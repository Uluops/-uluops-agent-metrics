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
import { entriesToTrackerFormat, refreshEntriesFromTranscripts, usageCountingStats, type BufferEntry } from './buffer.js';
import type { AgentMetrics } from './types.js';
import { createTestMetrics } from './test-utils.js';

const DIR = path.join(os.tmpdir(), `agent-metrics-usage-dedupe-${process.pid}-${Date.now()}`);

interface Usage { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number }
const U = (input: number, cw: number, cr: number, out: number): Usage =>
  ({ input_tokens: input, cache_creation_input_tokens: cw, cache_read_input_tokens: cr, output_tokens: out });

let seq = 0;
function line(o: {
  type?: 'user' | 'assistant' | 'tool_result';
  id?: string;
  requestId?: string;
  usage?: Usage;
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
      ...(o.usage ? { usage: o.usage } : {}),
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
    const u = U(3, 1000, 500, 70);
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
    const a = U(1, 100, 0, 10);
    const b = U(2, 20, 100, 30);
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
    const u = U(1, 10, 100, 5);
    const m = await extract('no-id', [line({ usage: u }), line({ usage: u })]);
    assert.strictEqual(m.tokens.total_effective, 2 * (1 + 10 + 5));
  });

  it('requestId keys the response when message.id is absent', async () => {
    const u = U(1, 10, 100, 5);
    const m = await extract('request-id', [
      line({ requestId: 'req_1', usage: u }),
      line({ requestId: 'req_1', usage: u, block: tool('t1') }),
      line({ requestId: 'req_2', usage: u }),
    ]);
    assert.strictEqual(m.tokens.total_effective, 2 * (1 + 10 + 5));
  });

  it('message.id takes precedence over requestId', async () => {
    const u = U(1, 10, 0, 5);
    // Same requestId, different message ids: two responses.
    const m = await extract('id-precedence', [
      line({ id: 'msg_A', requestId: 'req_1', usage: u }),
      line({ id: 'msg_B', requestId: 'req_1', usage: u }),
    ]);
    assert.strictEqual(m.tokens.total_effective, 2 * 16);
  });

  it('partial-then-full output repeats: the last wins, one conflict, no regression (census C-1b shape)', async () => {
    const m = await extract('partial-full', [
      line({ id: 'msg_A', usage: U(2, 300, 50, 4), block: { type: 'text', text: 'x' } }),
      line({ id: 'msg_A', usage: U(2, 300, 50, 125), block: tool('t1') }),
    ]);
    assert.strictEqual(m.tokens.output, 125);
    assert.strictEqual(m.tokens.total_effective, 2 + 300 + 125);
    assert.strictEqual(m.execution.usage_conflicts, 1);
    assert.strictEqual(m.execution.usage_regressions, 0);
  });

  it('a later repeat lower than an earlier one is counted as a regression; the last still wins (R2)', async () => {
    const m = await extract('regression', [
      line({ id: 'msg_A', usage: U(2, 300, 50, 125) }),
      line({ id: 'msg_A', usage: U(2, 300, 50, 4), block: tool('t1') }),
      line({ id: 'msg_B', usage: U(1, 1, 1, 1) }),
      line({ id: 'msg_B', usage: U(1, 1, 1, 1) }),
    ]);
    assert.strictEqual(m.tokens.output, 4 + 1);
    assert.strictEqual(m.execution.usage_conflicts, 1, 'msg_B repeats identically: not a conflict');
    assert.strictEqual(m.execution.usage_regressions, 1);
  });

  it('identical repeats are not conflicts', async () => {
    const u = U(1, 1, 1, 1);
    const m = await extract('identical', [line({ id: 'msg_A', usage: u }), line({ id: 'msg_A', usage: u, block: tool('t1') })]);
    assert.strictEqual(m.execution.usage_conflicts, 0);
    assert.strictEqual(m.execution.usage_regressions, 0);
  });

  it('tool and error counts stay per block/line (R3)', async () => {
    const u = U(1, 1, 1, 1);
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
    const u = U(1, 1, 1, 1);
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

  it('marks the figures as per-response (R5)', async () => {
    const m = await extract('marker', [line({ id: 'msg_A', usage: U(1, 1, 1, 1) })]);
    assert.strictEqual(m.tokens.counting, 'per-response');
  });
});

describe('the tracker wire is unchanged (G3 = c, no schema change)', () => {
  it('-f tracker output carries no counting marker', () => {
    const metrics = createTestMetrics({ agent_id: 'a1' });
    const entry = { agent_id: 'a1', agent_name: 'x', metrics: { ...metrics, tokens: { ...metrics.tokens, counting: 'per-response' as const } } } as unknown as BufferEntry;
    const [row] = entriesToTrackerFormat([entry]);
    assert.ok(row);
    assert.ok(!('counting' in row.tokens), 'tokens must keep the strict agents[] shape');
    assert.ok(!('counting' in row));
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
});

describe('usageCountingStats (status)', () => {
  it('counts per-response vs legacy entries and sums conflicts and regressions', () => {
    const base = createTestMetrics();
    const mk = (counting: 'per-response' | undefined, conflicts?: number, regressions?: number): BufferEntry => ({
      agent_id: `a${String(Math.random())}`,
      metrics: {
        ...base,
        tokens: { ...base.tokens, ...(counting ? { counting } : {}) },
        execution: { ...base.execution, ...(conflicts !== undefined ? { usage_conflicts: conflicts } : {}), ...(regressions !== undefined ? { usage_regressions: regressions } : {}) },
      },
    }) as unknown as BufferEntry;
    const s = usageCountingStats([mk('per-response', 3, 0), mk('per-response', 2, 1), mk(undefined)]);
    assert.deepStrictEqual(s, { entries: 3, perResponse: 2, legacy: 1, usageConflicts: 5, usageRegressions: 1, entriesWithRegressions: 1 });
  });
});
