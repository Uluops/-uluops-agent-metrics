/**
 * Tracker 8fe868d4 / transcript-usage-dedupe spec v0.1.1: count each API response once.
 *
 * Claude Code writes one transcript line per content block, and every line of one response
 * repeats that response's `message.id`, `requestId` and full `usage`. Summing per line
 * multiplies every token component by the number of blocks. Measured 2026-10-30 across
 * 1,944 transcripts: naive ÷ deduped total_effective = 2.10. Repeats that differ differ only
 * in `output_tokens`, partial then full, with the last line the maximum (census C-1b), so
 * the last repeat wins (spec R2, G1).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { extractMetricsFromFile } from './extractor.js';
import { entriesToTrackerFormat, refreshEntriesFromTranscripts, trackerSpliceWarnings, usageCountingStats, type BufferEntry } from './buffer.js';
import type { AgentMetrics } from './types.js';
import { createTestMetrics } from './test-utils.js';

const DIR = path.join(os.tmpdir(), `agent-metrics-usage-dedupe-${process.pid}-${Date.now()}`);

interface Usage { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number }
/** Named fields, so a fixture can't silently transpose components (review run #11). */
const U = (u: { input: number; cw: number; cr: number; out: number }): Usage =>
  ({ input_tokens: u.input, cache_creation_input_tokens: u.cw, cache_read_input_tokens: u.cr, output_tokens: u.out });

let seq = 0;
function line(o: {
  type?: 'user' | 'assistant' | 'tool_result';
  id?: unknown;
  requestId?: string;
  /** Usually a Usage; anything else to test malformed input. */
  usage?: unknown;
  block?: Record<string, unknown>;
  isError?: boolean;
}): string {
  seq++;
  const type = o.type ?? 'assistant';
  const base = {
    type, agentId: 'dedupe0000aaaa', sessionId: 's', cwd: '/x', version: '2.1.311', gitBranch: 'main',
    uuid: `u-${String(seq)}`, timestamp: new Date(Date.UTC(2026, 10, 18, 0, 0, seq)).toISOString(),
    ...(o.requestId !== undefined ? { requestId: o.requestId } : {}),
  };
  if (type === 'tool_result') return JSON.stringify({ ...base, toolUseResult: { is_error: o.isError ?? false } });
  if (type === 'user') return JSON.stringify({ ...base, message: { role: 'user', content: [{ type: 'text', text: 'go' }] } });
  return JSON.stringify({
    ...base,
    message: {
      role: 'assistant', model: 'claude-opus-5-5',
      ...(o.id !== undefined ? { id: o.id } : {}),
      content: [o.block ?? { type: 'text', text: 'x' }],
      ...(o.usage !== undefined ? { usage: o.usage } : {}),
    },
  });
}

async function extract(name: string, lines: string[]): Promise<AgentMetrics> {
  const p = path.join(DIR, `${name}.jsonl`);
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return extractMetricsFromFile(p);
}

const tool = (id: string, name = 'Read') => ({ type: 'tool_use', id, name, input: {} });

describe('count each response once (8fe868d4)', () => {
  before(() => fs.mkdirSync(DIR, { recursive: true }));
  after(() => fs.rmSync(DIR, { recursive: true, force: true }));

  it('one response written as three lines counts its usage once, not 3x (the issue\'s control)', async () => {
    const u = U({ input: 3, cw: 1000, cr: 500, out: 70 });
    const m = await extract('three-block', [
      line({ type: 'user' }),
      line({ id: 'msg_A', usage: u, block: { type: 'thinking', thinking: '' } }),
      line({ id: 'msg_A', usage: u, block: { type: 'text', text: 'x' } }),
      line({ id: 'msg_A', usage: u, block: tool('t1') }),
    ]);
    assert.deepStrictEqual(
      [m.tokens.input, m.tokens.cache_creation, m.tokens.cache_read, m.tokens.output],
      [3, 1000, 500, 70],
    );
    assert.strictEqual(m.tokens.total_effective, 3 + 1000 + 70);
    assert.strictEqual(m.tokens.total_raw, 3 + 1000 + 500 + 70);
  });

  it('two responses of two lines each sum to the two responses', async () => {
    const a = U({ input: 1, cw: 100, cr: 0, out: 10 });
    const b = U({ input: 2, cw: 20, cr: 100, out: 30 });
    const m = await extract('two-two', [
      line({ id: 'msg_A', usage: a, block: { type: 'text', text: 'x' } }),
      line({ id: 'msg_A', usage: a, block: tool('t1') }),
      line({ id: 'msg_B', usage: b, block: tool('t2') }),
      line({ id: 'msg_B', usage: b, block: tool('t3') }),
    ]);
    assert.strictEqual(m.tokens.total_effective, (1 + 100 + 10) + (2 + 20 + 30));
    assert.strictEqual(m.tokens.cache_read, 100);
  });

  it('lines with neither message.id nor requestId count once each, as before', async () => {
    const u = U({ input: 1, cw: 10, cr: 100, out: 5 });
    const m = await extract('no-id', [line({ usage: u }), line({ usage: u })]);
    assert.strictEqual(m.tokens.total_effective, 2 * (1 + 10 + 5));
  });

  it('requestId keys the response when message.id is absent', async () => {
    const u = U({ input: 1, cw: 10, cr: 100, out: 5 });
    const m = await extract('request-id', [
      line({ requestId: 'req_1', usage: u }),
      line({ requestId: 'req_1', usage: u, block: tool('t1') }),
      line({ requestId: 'req_2', usage: u }),
    ]);
    assert.strictEqual(m.tokens.total_effective, 2 * (1 + 10 + 5));
  });

  it('message.id takes precedence over requestId', async () => {
    const u = U({ input: 1, cw: 10, cr: 0, out: 5 });
    // Same requestId, different message ids: two responses.
    const m = await extract('id-precedence', [
      line({ id: 'msg_A', requestId: 'req_1', usage: u }),
      line({ id: 'msg_B', requestId: 'req_1', usage: u }),
    ]);
    assert.strictEqual(m.tokens.total_effective, 2 * 16);
  });

  it('partial-then-full output repeats: the last wins, one conflict, no regression (census C-1b shape)', async () => {
    const m = await extract('partial-full', [
      line({ id: 'msg_A', usage: U({ input: 2, cw: 300, cr: 50, out: 4 }), block: { type: 'text', text: 'x' } }),
      line({ id: 'msg_A', usage: U({ input: 2, cw: 300, cr: 50, out: 125 }), block: tool('t1') }),
    ]);
    assert.strictEqual(m.tokens.output, 125);
    assert.strictEqual(m.tokens.total_effective, 2 + 300 + 125);
    assert.strictEqual(m.execution.usage_conflicts, 1);
    assert.strictEqual(m.execution.usage_regressions, 0);
  });

  it('a later repeat lower than an earlier one is counted as a regression; the last still wins (R2)', async () => {
    const m = await extract('regression', [
      line({ id: 'msg_A', usage: U({ input: 2, cw: 300, cr: 50, out: 125 }) }),
      line({ id: 'msg_A', usage: U({ input: 2, cw: 300, cr: 50, out: 4 }), block: tool('t1') }),
    ]);
    assert.strictEqual(m.tokens.output, 4);
    assert.strictEqual(m.execution.usage_conflicts, 1);
    assert.strictEqual(m.execution.usage_regressions, 1);
  });

  it('a regression stays counted when a later repeat rises again (the flag is sticky)', async () => {
    const m = await extract('regression-sticky', [
      line({ id: 'msg_A', usage: U({ input: 2, cw: 300, cr: 50, out: 125 }) }),
      line({ id: 'msg_A', usage: U({ input: 2, cw: 300, cr: 50, out: 4 }) }),
      line({ id: 'msg_A', usage: U({ input: 2, cw: 300, cr: 50, out: 200 }) }),
    ]);
    assert.strictEqual(m.tokens.output, 200);
    assert.strictEqual(m.execution.usage_regressions, 1);
  });

  it('conflicts and regressions are detected in every component, not only output', async () => {
    const conflictInput = await extract('conflict-input', [
      line({ id: 'msg_A', usage: U({ input: 2, cw: 10, cr: 10, out: 10 }) }),
      line({ id: 'msg_A', usage: U({ input: 3, cw: 10, cr: 10, out: 10 }) }),
    ]);
    assert.strictEqual(conflictInput.execution.usage_conflicts, 1);
    assert.strictEqual(conflictInput.execution.usage_regressions, 0);
    for (const [name, a, b] of [
      ['input', U({ input: 5, cw: 10, cr: 10, out: 10 }), U({ input: 4, cw: 10, cr: 10, out: 10 })],
      ['cache_creation', U({ input: 5, cw: 10, cr: 10, out: 10 }), U({ input: 5, cw: 9, cr: 10, out: 10 })],
      ['cache_read', U({ input: 5, cw: 10, cr: 10, out: 10 }), U({ input: 5, cw: 10, cr: 9, out: 10 })],
    ] as const) {
      const m = await extract(`regress-${name}`, [line({ id: 'msg_A', usage: a }), line({ id: 'msg_A', usage: b })]);
      assert.strictEqual(m.execution.usage_regressions, 1, `${name} drop is a regression`);
      assert.strictEqual(m.execution.usage_conflicts, 1, `${name} drop is a conflict`);
    }
  });

  it('identical repeats in a second response do not add a conflict', async () => {
    const m = await extract('second-identical', [
      line({ id: 'msg_A', usage: U({ input: 2, cw: 300, cr: 50, out: 4 }) }),
      line({ id: 'msg_A', usage: U({ input: 2, cw: 300, cr: 50, out: 125 }) }),
      line({ id: 'msg_B', usage: U({ input: 1, cw: 1, cr: 1, out: 1 }) }),
      line({ id: 'msg_B', usage: U({ input: 1, cw: 1, cr: 1, out: 1 }) }),
    ]);
    assert.strictEqual(m.execution.usage_conflicts, 1);
  });

  it('identical repeats are not conflicts', async () => {
    const u = U({ input: 1, cw: 1, cr: 1, out: 1 });
    const m = await extract('identical', [line({ id: 'msg_A', usage: u }), line({ id: 'msg_A', usage: u, block: tool('t1') })]);
    assert.strictEqual(m.execution.usage_conflicts, 0);
    assert.strictEqual(m.execution.usage_regressions, 0);
  });

  it('tool and error counts stay per block/line (R3)', async () => {
    const u = U({ input: 1, cw: 1, cr: 1, out: 1 });
    const m = await extract('tools', [
      line({ id: 'msg_A', usage: u, block: tool('t1', 'Read') }),
      line({ id: 'msg_A', usage: u, block: tool('t2', 'Read') }),
      line({ id: 'msg_A', usage: u, block: tool('t3', 'Grep') }),
      line({ type: 'tool_result', isError: true }),
      line({ type: 'tool_result' }),
      line({ type: 'tool_result' }),
    ]);
    assert.strictEqual(m.execution.tool_use_count, 3);
    assert.deepStrictEqual(m.execution.tool_breakdown, { Read: 2, Grep: 1 });
    assert.strictEqual(m.execution.error_count, 1);
  });

  it('message_count = distinct responses + user/tool_result lines; line_count = lines (G2)', async () => {
    const u = U({ input: 1, cw: 1, cr: 1, out: 1 });
    const m = await extract('counts', [
      line({ type: 'user' }),
      line({ id: 'msg_A', usage: u }),
      line({ id: 'msg_A', usage: u, block: tool('t1') }),
      line({ type: 'tool_result' }),
      line({ id: 'msg_B', usage: u }),
      line({ id: 'msg_B' }), // an id-bearing line without usage is still part of msg_B
      line({}), // no id, no usage: its own response
    ]);
    assert.strictEqual(m.execution.line_count, 7);
    assert.strictEqual(m.execution.message_count, 2 /* user, tool_result */ + 3 /* msg_A, msg_B, anonymous */);
  });

  it('marks the figures as per-response (R5), also when no line carries usage', async () => {
    const m = await extract('marker', [line({ id: 'msg_A', usage: U({ input: 1, cw: 1, cr: 1, out: 1 }) })]);
    assert.strictEqual(m.tokens.counting, 'per-response');
    const none = await extract('marker-none', [line({ type: 'user' }), line({ id: 'msg_A' })]);
    assert.strictEqual(none.tokens.counting, 'per-response');
    assert.strictEqual(none.tokens.total_raw, 0);
  });
});

describe('response keys (R1 edge cases)', () => {
  before(() => fs.mkdirSync(DIR, { recursive: true }));
  after(() => fs.rmSync(DIR, { recursive: true, force: true }));
  const u = U({ input: 1, cw: 10, cr: 0, out: 5 }); // 16 effective

  it('an empty-string message.id falls through to requestId', async () => {
    const m = await extract('empty-id', [line({ id: '', requestId: 'req_1', usage: u }), line({ id: '', requestId: 'req_1', usage: u })]);
    assert.strictEqual(m.tokens.total_effective, 16);
  });

  it('an empty-string id and requestId fall through to the line', async () => {
    const m = await extract('empty-both', [line({ id: '', requestId: '', usage: u }), line({ id: '', requestId: '', usage: u })]);
    assert.strictEqual(m.tokens.total_effective, 32);
  });

  it('a message.id and a requestId with the same value on different lines stay separate', async () => {
    const m = await extract('id-vs-req', [line({ id: 'X', usage: u }), line({ requestId: 'X', usage: u })]);
    assert.strictEqual(m.tokens.total_effective, 32);
  });

  it('non-adjacent repeats (A, B, A) fold into their responses; the last A wins', async () => {
    const m = await extract('interleaved', [
      line({ id: 'msg_A', usage: U({ input: 1, cw: 10, cr: 0, out: 2 }) }),
      line({ id: 'msg_B', usage: U({ input: 1, cw: 10, cr: 0, out: 3 }) }),
      line({ id: 'msg_A', usage: U({ input: 1, cw: 10, cr: 0, out: 7 }) }),
    ]);
    assert.strictEqual(m.tokens.output, 7 + 3);
    assert.strictEqual(m.execution.message_count, 2);
  });

  it('distinct numeric message ids sharing a requestId are not merged', async () => {
    const m = await extract('numeric-id', [line({ id: 7, requestId: 'req_1', usage: u }), line({ id: 8, requestId: 'req_1', usage: u })]);
    assert.strictEqual(m.tokens.total_effective, 32);
  });
});

describe('malformed or partial usage never zeroes a response (review run #11)', () => {
  before(() => fs.mkdirSync(DIR, { recursive: true }));
  after(() => fs.rmSync(DIR, { recursive: true, force: true }));
  const good = U({ input: 2, cw: 300, cr: 50, out: 125 });

  for (const [name, bad] of [
    ['empty object', {}],
    ['a number', 5],
    ['an array', [1, 2]],
    ['null', null],
    ['string fields', { input_tokens: '2', output_tokens: '125', cache_creation_input_tokens: '300', cache_read_input_tokens: '50' }],
  ] as const) {
    it(`a later repeat whose usage is ${name} keeps the earlier figures`, async () => {
      const m = await extract(`bad-${name.replace(/\W+/g, '-')}`, [line({ id: 'msg_A', usage: good }), line({ id: 'msg_A', usage: bad })]);
      assert.deepStrictEqual([m.tokens.input, m.tokens.cache_creation, m.tokens.cache_read, m.tokens.output], [2, 300, 50, 125]);
      assert.strictEqual(m.execution.usage_regressions, 0);
    });
  }

  it('a later repeat missing a cache field carries that field forward; present fields still win', async () => {
    const m = await extract('missing-cache', [
      line({ id: 'msg_A', usage: good }),
      line({ id: 'msg_A', usage: { input_tokens: 2, output_tokens: 130 } }),
    ]);
    assert.deepStrictEqual([m.tokens.input, m.tokens.cache_creation, m.tokens.cache_read, m.tokens.output], [2, 300, 50, 130]);
  });

  it('usage present only on a later line of the response counts once', async () => {
    const m = await extract('usage-later', [line({ id: 'msg_A' }), line({ id: 'msg_A', usage: good }), line({ id: 'msg_A', usage: good })]);
    assert.strictEqual(m.tokens.total_effective, 2 + 300 + 125);
    assert.strictEqual(m.execution.message_count, 1);
  });

  it('a non-object usage on the only line counts nothing and does not throw', async () => {
    const m = await extract('bad-only', [line({ id: 'msg_A', usage: 'lots' })]);
    assert.strictEqual(m.tokens.total_raw, 0);
  });
});

describe('the tracker wire is unchanged (G3 = c, no schema change)', () => {
  it('-f tracker output carries none of the 0.13.0 fields, in tokens or anywhere on the row', () => {
    const metrics = createTestMetrics({ agent_id: 'a1' });
    const entry = {
      agent_id: 'a1', agent_name: 'x',
      metrics: {
        ...metrics,
        tokens: { ...metrics.tokens, counting: 'per-response' as const },
        execution: { ...metrics.execution, line_count: 9, usage_conflicts: 2, usage_regressions: 1 },
      },
    } as unknown as BufferEntry;
    const [row] = entriesToTrackerFormat([entry]);
    assert.ok(row);
    const serialized = JSON.stringify(row);
    for (const field of ['counting', 'line_count', 'usage_conflicts', 'usage_regressions', 'execution']) {
      assert.ok(!serialized.includes(`"${field}"`), `${field} must not reach the strict agents[] row`);
    }
    assert.deepStrictEqual(Object.keys(row.tokens).sort(), Object.keys(entriesToTrackerFormat([{ ...entry, metrics: metrics } as unknown as BufferEntry])[0]!.tokens).sort());
  });
});

describe('refresh replaces a legacy entry with the per-response count (R6)', () => {
  const legacy = (): BufferEntry => {
    const m = createTestMetrics({ agent_id: 'a1', end_time: '2026-10-04T10:00:01.000Z' });
    return { agent_id: 'a1', agent_name: 'x', end_time: m.end_time, metrics: m } as unknown as BufferEntry;
  };

  it('a legacy entry whose transcript ends at the same time is re-extracted and marked', async () => {
    const e = legacy();
    assert.strictEqual(e.metrics.tokens.counting, undefined, 'fixture is legacy');
    const fresh = createTestMetrics({ agent_id: 'a1', end_time: e.end_time });
    const [r] = await refreshEntriesFromTranscripts([e], {
      find: () => ({ filePath: 'f' }),
      extract: async () => ({ ...fresh, tokens: { ...fresh.tokens, total_effective: 1, counting: 'per-response' } }),
    });
    assert.strictEqual(r?.metrics.tokens.counting, 'per-response');
    assert.strictEqual(r?.metrics.tokens.total_effective, 1);
  });

  it('a legacy entry whose transcript is gone stays legacy (nothing to prove it with)', async () => {
    const e = legacy();
    const [r] = await refreshEntriesFromTranscripts([e], { find: () => null });
    assert.strictEqual(r?.metrics.tokens.counting, undefined);
  });

  it('a transcript that ends earlier than the stored capture keeps the stored entry (covers guard)', async () => {
    const e = legacy();
    const fresh = createTestMetrics({ agent_id: 'a1', end_time: '2026-10-04T10:00:00.000Z' });
    const [r] = await refreshEntriesFromTranscripts([e], {
      find: () => ({ filePath: 'f' }),
      extract: async () => ({ ...fresh, tokens: { ...fresh.tokens, counting: 'per-response' } }),
    });
    assert.strictEqual(r, e);
  });

  it('the real extractor, through refresh, recounts a legacy entry from a multi-line transcript', async () => {
    fs.mkdirSync(DIR, { recursive: true });
    try {
      const p = path.join(DIR, 'refresh-real.jsonl');
      const u = U({ input: 3, cw: 1000, cr: 500, out: 70 });
      fs.writeFileSync(p, [line({ id: 'msg_A', usage: u }), line({ id: 'msg_A', usage: u, block: tool('t1') }), line({ id: 'msg_A', usage: u, block: tool('t2') })].join('\n') + '\n');
      const e = legacy();
      const stored = { ...e, end_time: undefined, metrics: { ...e.metrics, tokens: { ...e.metrics.tokens, total_effective: 3 * 1073 } } } as unknown as BufferEntry;
      const [r] = await refreshEntriesFromTranscripts([stored], { find: () => ({ filePath: p }) });
      assert.strictEqual(r?.metrics.tokens.total_effective, 1073);
      assert.strictEqual(r?.metrics.tokens.counting, 'per-response');
    } finally {
      fs.rmSync(DIR, { recursive: true, force: true });
    }
  });

  it('an extraction error falls back to the stored entry and says so, naming a legacy count', async () => {
    const warnings: string[] = [];
    const e = legacy();
    const [r] = await refreshEntriesFromTranscripts([e], {
      find: () => ({ filePath: 'f' }), extract: async () => { throw new Error('EACCES'); }, warn: (l) => warnings.push(l),
    });
    assert.strictEqual(r, e);
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0]!, /a1.*EACCES.*per line before 0\.13\.0/);
  });

  it('the fallback warning does not call a per-response entry legacy', async () => {
    const warnings: string[] = [];
    const e = legacy();
    const marked = { ...e, metrics: { ...e.metrics, tokens: { ...e.metrics.tokens, counting: 'per-response' } } } as unknown as BufferEntry;
    await refreshEntriesFromTranscripts([marked], { find: () => ({ filePath: 'f' }), extract: async () => { throw new Error('x'); }, warn: (l) => warnings.push(l) });
    assert.strictEqual(warnings.length, 1);
    assert.doesNotMatch(warnings[0]!, /per line/);
  });
});

let entrySeq = 0;
function entry(o: { counting?: 'per-response'; harness?: string; conflicts?: unknown; regressions?: unknown } = {}): BufferEntry {
  const base = createTestMetrics();
  entrySeq++;
  return {
    agent_id: `e${String(entrySeq)}`,
    metrics: {
      ...base,
      ...(o.harness !== undefined ? { harness: o.harness } : {}),
      tokens: { ...base.tokens, ...(o.counting ? { counting: o.counting } : {}) },
      execution: {
        ...base.execution,
        ...(o.conflicts !== undefined ? { usage_conflicts: o.conflicts } : {}),
        ...(o.regressions !== undefined ? { usage_regressions: o.regressions } : {}),
      },
    },
  } as unknown as BufferEntry;
}

describe('trackerSpliceWarnings (-f tracker stderr)', () => {
  it('is silent for per-response entries with no regression, and for Codex entries', () => {
    assert.deepStrictEqual(trackerSpliceWarnings([entry({ counting: 'per-response', regressions: 0 }), entry({ harness: 'codex' })]), []);
  });

  it('names legacy Claude entries', () => {
    const a = entry();
    const w = trackerSpliceWarnings([a, entry({ counting: 'per-response' })]);
    assert.strictEqual(w.length, 1);
    assert.match(w[0]!, new RegExp(`1 of 2 entries.*${a.agent_id}`));
  });

  it('names entries with usage regressions', () => {
    const a = entry({ counting: 'per-response', regressions: 2 });
    const w = trackerSpliceWarnings([a]);
    assert.strictEqual(w.length, 1);
    assert.match(w[0]!, new RegExp(`${a.agent_id}: 2 response`));
  });
});

describe('usageCountingStats (status)', () => {
  it('separates per-response, legacy Claude and Codex entries, and sums conflicts and regressions', () => {
    const s = usageCountingStats([
      entry({ counting: 'per-response', conflicts: 3, regressions: 0 }),
      entry({ counting: 'per-response', conflicts: 2, regressions: 1 }),
      entry(),
      entry({ harness: 'codex' }),
    ]);
    assert.deepStrictEqual(s, { entries: 4, perResponse: 2, legacy: 1, codex: 1, usageConflicts: 5, usageRegressions: 1, entriesWithRegressions: 1 });
  });

  it('ignores counter values that are not finite numbers (foreign or hand-edited entries)', () => {
    const s = usageCountingStats([entry({ counting: 'per-response', conflicts: '5', regressions: '1' }), entry({ counting: 'per-response', conflicts: 2, regressions: Infinity })]);
    assert.strictEqual(s.usageConflicts, 2);
    assert.strictEqual(s.usageRegressions, 0);
    assert.strictEqual(s.entriesWithRegressions, 0);
  });
});


describe('non-message transcript records (0.13.1)', () => {
  before(() => fs.mkdirSync(DIR, { recursive: true }));
  after(() => fs.rmSync(DIR, { recursive: true, force: true }));

  // Shapes measured 2026-11-18 over 2,472 transcripts: every line failing the required-field
  // check was one of these three types (69,596 lines in 1,912 files), and none carried usage.
  const apiRequest = JSON.stringify({ type: 'api-request', timestamp: '2026-11-18T00:00:00.000Z', agentId: 'dedupe0000aaaa', sessionId: 's', version: '2.1.316', uuid: 'r1' });
  const apiBlob = JSON.stringify({ type: 'api-request-blob', agentId: 'dedupe0000aaaa', sessionId: 's', uuid: 'r2' });
  const apiShape = JSON.stringify({ type: 'api-request-shape', timestamp: '2026-11-18T00:00:00.000Z', agentId: 'dedupe0000aaaa', sessionId: 's', version: '2.1.316', uuid: 'r3' });
  const attachment = JSON.stringify({ type: 'attachment', timestamp: '2026-11-18T00:00:01.000Z', agentId: 'dedupe0000aaaa', sessionId: 's', cwd: '/x', version: '2.1.316', gitBranch: 'main', uuid: 'a1' });

  async function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; stderr: string[] }> {
    const lines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try { return { result: await fn(), stderr: lines }; } finally { process.stderr.write = orig; }
  }

  it('api-request records lacking message fields are skipped without a warning', async () => {
    const u = U({ input: 1, cw: 10, cr: 0, out: 5 });
    const { result: m, stderr } = await captureStderr(() => extract('api-request', [apiRequest, apiBlob, line({ id: 'msg_A', usage: u }), apiShape, apiRequest]));
    assert.deepStrictEqual(stderr, []);
    assert.strictEqual(m.tokens.total_effective, 16);
    assert.strictEqual(m.execution.line_count, 1, 'skipped records are not counted as lines');
  });

  it('a user or assistant line missing required fields still warns (a real message would be lost)', async () => {
    const broken = JSON.stringify({ type: 'assistant', timestamp: '2026-11-18T00:00:00.000Z', agentId: 'x', sessionId: 's', message: { id: 'm', usage: U({ input: 1, cw: 1, cr: 1, out: 1 }) } });
    const { stderr } = await captureStderr(() => extract('broken-assistant', [line({ type: 'user' }), broken]));
    assert.strictEqual(stderr.filter(l => /missing required fields/.test(l)).length, 1);
  });

  it('attachment lines are not messages: message_count = responses + user/tool_result lines only (G2)', async () => {
    const u = U({ input: 1, cw: 1, cr: 1, out: 1 });
    const m = await extract('attachments', [line({ type: 'user' }), attachment, attachment, line({ id: 'msg_A', usage: u }), line({ type: 'tool_result' })]);
    assert.strictEqual(m.execution.message_count, 1 /* user */ + 1 /* tool_result */ + 1 /* msg_A */);
    assert.strictEqual(m.execution.line_count, 5, 'attachments are still lines');
  });
});
