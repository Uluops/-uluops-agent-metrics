/**
 * U+2028/U+2029 inside a JSONL string are not line breaks (see jsonl.ts).
 * Every transcript reader goes through readJsonlLines; each is tested here on a
 * record carrying a raw separator, which readline split into two unparseable halves.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readJsonlLines } from './jsonl.js';
import { extractMetricsFromFile } from './extractor.js';
import { extractCodexMetricsFromFile } from './codex-extractor.js';
import { getFirstUserMessageContent } from './hook.js';

const DIR = path.join(os.tmpdir(), `agent-metrics-jsonl-${Date.now()}`);
const LS = ' ';
const PS = ' ';
const AGENT = 'abad1dea0000111122223333eeeeffff';

const claudeLine = (type: string, out: number, ts: string, text: string): string => JSON.stringify({
  type, agentId: AGENT, sessionId: 's', cwd: '/x', version: '2.1.0', gitBranch: 'main', uuid: `${type}-${ts}`, timestamp: ts,
  message: type === 'user'
    ? { role: 'user', content: text }
    : { role: 'assistant', id: `m-${ts}`, model: 'claude-opus-5-5', content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: out, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
});

async function collect(file: string): Promise<string[]> {
  const out: string[] = [];
  for await (const l of readJsonlLines(file)) out.push(l);
  return out;
}

describe('readJsonlLines', () => {
  before(() => fs.mkdirSync(DIR, { recursive: true }));
  after(() => fs.rmSync(DIR, { recursive: true, force: true }));

  it('splits on \\n only: raw U+2028/U+2029 and a bare \\r stay inside the line', async () => {
    const f = path.join(DIR, 'seps.jsonl');
    fs.writeFileSync(f, `a${LS}b\nc${PS}d\ne\rf\n`);
    assert.deepStrictEqual(await collect(f), [`a${LS}b`, `c${PS}d`, 'e\rf']);
  });

  it('drops a trailing \\r (CRLF) and yields a final unterminated line', async () => {
    const f = path.join(DIR, 'crlf.jsonl');
    fs.writeFileSync(f, 'one\r\ntwo\r\nthree');
    assert.deepStrictEqual(await collect(f), ['one', 'two', 'three']);
  });

  it('keeps a multi-byte character whole across stream chunk boundaries', async () => {
    const f = path.join(DIR, 'big.jsonl');
    const line = `${'x'.repeat(65535)}${LS}${'y'.repeat(70000)}`; // U+2028 straddles the 64 KiB chunk edge
    fs.writeFileSync(f, `${line}\nend\n`);
    const lines = await collect(f);
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(lines[0], line);
  });
});

describe('transcript readers on a record with a raw U+2028/U+2029', () => {
  before(() => fs.mkdirSync(DIR, { recursive: true }));
  after(() => fs.rmSync(DIR, { recursive: true, force: true }));

  it('extractMetricsFromFile counts the tokens of every record', async () => {
    const f = path.join(DIR, `agent-${AGENT}.jsonl`);
    fs.writeFileSync(f, [
      claudeLine('user', 0, '2026-10-19T00:00:00.000Z', 'go'),
      claudeLine('assistant', 10, '2026-10-19T00:00:01.000Z', 'plain'),
      claudeLine('assistant', 200, '2026-10-19T00:00:02.000Z', `line${LS}separator`),
      claudeLine('assistant', 3000, '2026-10-19T00:00:03.000Z', `para${PS}separator`),
    ].join('\n') + '\n');
    const m = await extractMetricsFromFile(f);
    assert.strictEqual(m.tokens.output, 3210);
  });

  it('extractCodexMetricsFromFile reads a final token_count that carries one', async () => {
    const f = path.join(DIR, 'rollout.jsonl');
    const rec = (type: string, timestamp: string, payload: Record<string, unknown>): string => JSON.stringify({ timestamp, type, payload });
    fs.writeFileSync(f, [
      rec('session_meta', '2026-10-19T00:00:00.000Z', { id: '019eaa28-8e2d-73a2-840f-a00d6cc8795f', cwd: '/x', cli_version: '0.137.0', model_provider: 'openai', timestamp: '2026-10-19T00:00:00.000Z' }),
      rec('turn_context', '2026-10-19T00:00:00.100Z', { model: 'gpt-5.5', cwd: '/x' }),
      rec('event_msg', '2026-10-19T00:00:01.000Z', { type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } } }),
      rec('event_msg', '2026-10-19T00:00:02.000Z', { type: 'token_count', note: `x${LS}y`, info: { total_token_usage: { input_tokens: 500, output_tokens: 40, total_tokens: 540 } } }),
    ].join('\n') + '\n');
    const m = await extractCodexMetricsFromFile(f);
    assert.strictEqual(m.tokens.output, 40);
    assert.strictEqual(m.tokens.input, 500);
  });

  it('getFirstUserMessageContent returns the first user message whole', async () => {
    const f = path.join(DIR, 'transcript.jsonl');
    const prompt = `[agent:x] first${LS}prompt`;
    fs.writeFileSync(f, [
      claudeLine('user', 0, '2026-10-19T00:00:00.000Z', prompt),
      claudeLine('user', 0, '2026-10-19T00:00:01.000Z', 'second'),
    ].join('\n') + '\n');
    assert.strictEqual(await getFirstUserMessageContent(f), prompt);
  });
});
