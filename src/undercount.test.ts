/**
 * Tracker 74629040: the SubagentStop capture must include the final assistant message.
 * Measured live 2026-10-04: in 3 of 4 agents the hook read the transcript before the
 * last assistant line was flushed, undercounting output tokens 6–10×.
 */
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleHook, waitForStableFile } from './hook.js';
import { clearAgents, latestPerAgent, readBuffer, refreshEntriesFromTranscripts, type BufferEntry } from './buffer.js';
import { createTestMetrics } from './test-utils.js';

const DIR = path.join(os.homedir(), '.claude', `agent-metrics-undercount-${Date.now()}`);
const AGENT = 'abad1dea0000111122223333ccccdddd';
const line = (type: string, out: number, ts: string): string => JSON.stringify({
  type, agentId: AGENT, sessionId: 's', cwd: '/x', version: '2.1.0', gitBranch: 'main', uuid: `${type}-${ts}`, timestamp: ts,
  message: type === 'user'
    ? { role: 'user', content: [{ type: 'text', text: 'go' }] }
    : { role: 'assistant', id: `m-${ts}`, model: 'claude-opus-5-5', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 1, output_tokens: out, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
}) + '\n';

describe('waitForStableFile', () => {
  it('returns once the size has been unchanged for stableMs', async () => {
    let t = 0; const sizes = [10, 20, 30, 30, 30, 30, 30, 30, 30];
    let i = 0;
    const r = await waitForStableFile('f', { intervalMs: 100, stableMs: 300, maxMs: 3000 }, {
      sleep: async (ms) => { t += ms; }, size: () => sizes[Math.min(i++, sizes.length - 1)]!, now: () => t,
    });
    assert.strictEqual(r.stable, true);
    assert.ok(r.waitedMs >= 300 && r.waitedMs < 3000);
  });

  it('gives up at maxMs while the file keeps growing (never hangs SubagentStop)', async () => {
    let t = 0; let n = 0;
    const r = await waitForStableFile('f', { intervalMs: 100, stableMs: 300, maxMs: 1000 }, {
      sleep: async (ms) => { t += ms; }, size: () => ++n, now: () => t,
    });
    assert.strictEqual(r.stable, false);
    assert.strictEqual(r.waitedMs, 1000);
  });
});

describe('the hook counts the final assistant message (74629040)', () => {
  before(() => fs.mkdirSync(DIR, { recursive: true }));
  after(() => fs.rmSync(DIR, { recursive: true, force: true }));
  afterEach(() => clearAgents([AGENT]));

  const capture = async (waitForStable: Parameters<typeof handleHook>[1] extends infer D ? D extends { waitForStable?: infer W } ? W : never : never): Promise<number | undefined> => {
    const p = path.join(DIR, `agent-${AGENT}.jsonl`);
    fs.writeFileSync(p, line('user', 0, '2026-10-04T10:00:00.000Z') + line('assistant', 70, '2026-10-04T10:00:01.000Z'));
    await handleHook({ agent_transcript_path: p, agent_id: AGENT, agent_type: 'x', cwd: '/x' },
      { readFirstMessage: async () => 'go', waitForStable, definitionDirs: [], spawnFile: path.join(DIR, 'spawns.jsonl') });
    return readBuffer().find(e => e.agent_id === AGENT)?.metrics.tokens.output;
  };
  // The final assistant line lands on disk while the hook waits — the live race.
  const flushDuringWait = async (file: string): Promise<{ stable: boolean; waitedMs: number }> => {
    fs.appendFileSync(file, line('assistant', 700, '2026-10-04T10:00:02.000Z'));
    return { stable: true, waitedMs: 500 };
  };

  it('a final message flushed during the wait is counted (control: no wait undercounts)', async () => {
    assert.strictEqual(await capture(flushDuringWait), 770);
    // control: the pre-fix hook read immediately; the late line is appended after the read
    const noWait = async (): Promise<{ stable: boolean; waitedMs: number }> => ({ stable: true, waitedMs: 0 });
    clearAgents([AGENT]);
    assert.strictEqual(await capture(noWait), 70);
  });
});

describe('refreshEntriesFromTranscripts', () => {
  const entry = (end: string, out: number): BufferEntry => ({
    agent_id: 'abc', session_id: 's', captured_at: '', end_time: end, expires_at: '',
    metrics: createTestMetrics({ agent_id: 'abc', end_time: end, tokens: { ...createTestMetrics().tokens, output: out } }),
  });

  it('replaces metrics when the transcript covers at least as much of the run', async () => {
    const [r] = await refreshEntriesFromTranscripts([entry('2026-10-04T10:00:01.000Z', 70)], {
      find: () => ({ filePath: 'f' }),
      extract: async () => createTestMetrics({ end_time: '2026-10-04T10:00:02.000Z', tokens: { ...createTestMetrics().tokens, output: 770 } }),
    });
    assert.strictEqual(r!.metrics.tokens.output, 770);
    assert.strictEqual(r!.metrics.agent_id, 'abc');
  });

  it('keeps the buffer metrics when the transcript ends earlier (a truncated or rotated file)', async () => {
    const [r] = await refreshEntriesFromTranscripts([entry('2026-10-04T10:00:02.000Z', 770)], {
      find: () => ({ filePath: 'f' }),
      extract: async () => createTestMetrics({ end_time: '2026-10-04T10:00:01.000Z', tokens: { ...createTestMetrics().tokens, output: 70 } }),
    });
    assert.strictEqual(r!.metrics.tokens.output, 770);
  });

  it('leaves entries unchanged when the transcript is gone or unreadable', async () => {
    const e = entry('2026-10-04T10:00:01.000Z', 70);
    assert.deepStrictEqual(await refreshEntriesFromTranscripts([e], { find: () => null }), [e]);
    assert.deepStrictEqual(await refreshEntriesFromTranscripts([e], { find: () => ({ filePath: 'f' }), extract: async () => { throw new Error('gone'); } }), [e]);
  });
});

describe('one entry per agent instance (re-woken agents, 74629040)', () => {
  const e = (id: string, end: string, captured: string, out: number): BufferEntry => ({
    agent_id: id, session_id: 's', captured_at: captured, end_time: end, expires_at: '',
    metrics: createTestMetrics({ agent_id: id, tokens: { ...createTestMetrics().tokens, output: out } }),
  });
  it('the latest capture of an agent wins; others keep their order (control: no collapse returns both)', () => {
    const entries = [
      e('a', '2026-10-04T19:14:20.448Z', '2026-10-04T19:14:21.134Z', 188),
      e('b', '2026-10-04T19:14:25.000Z', '2026-10-04T19:14:25.500Z', 50),
      e('a', '2026-10-04T19:14:30.902Z', '2026-10-04T19:14:31.631Z', 523),
    ];
    const out = latestPerAgent(entries);
    assert.deepStrictEqual(out.map(x => [x.agent_id, x.metrics.tokens.output]), [['a', 523], ['b', 50]]);
    assert.strictEqual(entries.filter(x => x.agent_id === 'a').length, 2); // what an uncollapsed read returns
  });
  it('equal end_time: the later capture wins', () => {
    const out = latestPerAgent([e('a', 'T', '2026-10-04T10:00:01Z', 1), e('a', 'T', '2026-10-04T10:00:02Z', 2)]);
    assert.strictEqual(out[0]!.metrics.tokens.output, 2);
  });
});

describe('readBuffer collapses re-woken captures', () => {
  it('two appends for one agent read back as one, the later (control: an uncollapsed readBuffer returns two)', async () => {
    const { appendToBuffer } = await import('./buffer.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-collapse-'));
    const config = { bufferPath: path.join(dir, 'b.jsonl'), defaultTTL: 3_600_000, lockTimeoutMs: 1000 };
    const m = (end: string, out: number) => createTestMetrics({ agent_id: 'rewoken1', end_time: end, tokens: { ...createTestMetrics().tokens, output: out } });
    appendToBuffer(m('2026-10-04T19:14:20.448Z', 188), { config });
    appendToBuffer(m('2026-10-04T19:14:30.902Z', 523), { config });
    const lines = fs.readFileSync(config.bufferPath, 'utf-8').trim().split('\n');
    assert.strictEqual(lines.length, 2, 'the file keeps both captures');
    const read = readBuffer(config);
    assert.deepStrictEqual(read.map(e => e.metrics.tokens.output), [523]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
