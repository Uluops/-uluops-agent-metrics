/**
 * Codex extractor tests.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { extractCodexMetricsFromFile } from './codex-extractor.js';
import { findCodexAgentFile, findRecentCodexAgentFiles } from './utils.js';

const TEST_DIR = path.join(os.tmpdir(), 'agent-metrics-codex-test-' + Date.now());
const CODEX_HOME = path.join(TEST_DIR, '.codex');
const SESSIONS_DIR = path.join(CODEX_HOME, 'sessions', '2026', '06', '08');
const AGENT_ID = '019eaa28-8e2d-73a2-840f-a00d6cc8795f';
const PARENT_ID = '019eaa27-f755-7cb2-84fa-bd1aa685d69e';
const FILE_PATH = path.join(SESSIONS_DIR, `rollout-2026-06-08T16-14-05-${AGENT_ID}.jsonl`);

function record(type: string, timestamp: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp, type, payload });
}

function sessionMeta(overrides: Record<string, unknown> = {}): string {
  return record('session_meta', '2026-06-08T16:14:05.000Z', {
    id: AGENT_ID,
    parent_thread_id: PARENT_ID,
    cwd: '/Users/aself/uluops',
    originator: 'codex-tui',
    cli_version: '0.137.0',
    thread_source: 'subagent',
    agent_nickname: 'Dirac',
    model_provider: 'openai',
    timestamp: '2026-06-08T16:14:05.000Z',
    ...overrides,
  });
}

function tokenCount(timestamp: string, usage: Record<string, number>): string {
  return record('event_msg', timestamp, {
    type: 'token_count',
    info: {
      total_token_usage: usage,
    },
  });
}

function singleTurnCodexJSONL(): string {
  return [
    sessionMeta(),
    record('turn_context', '2026-06-08T16:14:05.250Z', {
      model: 'gpt-5.5',
      cwd: '/Users/aself/uluops',
    }),
    record('response_item', '2026-06-08T16:14:06.000Z', {
      type: 'message',
      role: 'user',
    }),
    record('response_item', '2026-06-08T16:14:07.000Z', {
      type: 'reasoning',
    }),
    record('response_item', '2026-06-08T16:14:08.000Z', {
      type: 'function_call',
      name: 'exec_command',
    }),
    record('response_item', '2026-06-08T16:14:09.000Z', {
      type: 'custom_tool_call',
      name: 'custom.shell',
    }),
    record('response_item', '2026-06-08T16:14:10.000Z', {
      type: 'tool_search_call',
      name: 'tool_search_tool',
    }),
    record('event_msg', '2026-06-08T16:14:11.000Z', {
      type: 'unknown_future_event',
    }),
    tokenCount('2026-06-08T16:14:12.000Z', {
      input_tokens: 12459,
      cached_input_tokens: 4992,
      output_tokens: 9,
      reasoning_output_tokens: 7,
      total_tokens: 12475,
    }),
    record('event_msg', '2026-06-08T16:14:13.000Z', {
      type: 'task_complete',
      duration_ms: 10351,
      time_to_first_token_ms: 9891,
      last_agent_message: 'Subagent test complete.',
    }),
  ].join('\n');
}

function multiTurnCodexJSONL(): string {
  return [
    sessionMeta({
      id: '019eaa29-8e2d-73a2-840f-a00d6cc8795f',
      thread_source: 'user',
      agent_nickname: 'Parent',
      timestamp: '2026-06-08T10:00:00.000Z',
    }),
    record('turn_context', '2026-06-08T10:00:01.000Z', { model: 'gpt-5.5' }),
    tokenCount('2026-06-08T10:00:02.000Z', {
      input_tokens: 100,
      cached_input_tokens: 20,
      output_tokens: 30,
      reasoning_output_tokens: 5,
      total_tokens: 135,
    }),
    record('event_msg', '2026-06-08T10:00:03.000Z', {
      type: 'task_complete',
      duration_ms: 1000,
      time_to_first_token_ms: 300,
      last_agent_message: 'First turn',
    }),
    record('turn_context', '2026-06-08T10:01:00.000Z', { model: 'gpt-5.5' }),
    tokenCount('2026-06-08T10:01:30.000Z', {
      input_tokens: 300,
      cached_input_tokens: 50,
      output_tokens: 60,
      reasoning_output_tokens: 10,
      total_tokens: 370,
    }),
    record('event_msg', '2026-06-08T10:02:00.000Z', {
      type: 'task_complete',
      duration_ms: 2000,
      time_to_first_token_ms: 400,
      last_agent_message: 'Second turn',
    }),
  ].join('\n');
}

describe('Codex extractor', () => {
  const originalEnv = { ...process.env };

  before(() => {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    fs.writeFileSync(FILE_PATH, singleTurnCodexJSONL());
    process.env.CODEX_HOME = CODEX_HOME;
  });

  after(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    process.env = originalEnv;
  });

  it('extracts single-turn subagent metrics', async () => {
    const metrics = await extractCodexMetricsFromFile(FILE_PATH);

    assert.strictEqual(metrics.provider, 'codex');
    assert.strictEqual(metrics.agent_id, AGENT_ID);
    assert.strictEqual(metrics.session_id, PARENT_ID);
    assert.strictEqual(metrics.parent_thread_id, PARENT_ID);
    assert.strictEqual(metrics.slug, 'Dirac');
    assert.strictEqual(metrics.model, 'gpt-5.5');
    assert.strictEqual(metrics.codex_cli_version, '0.137.0');
    assert.strictEqual(metrics.model_provider, 'openai');
    assert.strictEqual(metrics.duration_ms, 10351);
    assert.strictEqual(metrics.time_to_first_token_ms, 9891);
    assert.strictEqual(metrics.final_message, 'Subagent test complete.');
    assert.strictEqual(metrics.tokens.input, 12459);
    assert.strictEqual(metrics.tokens.cached_input, 4992);
    assert.strictEqual(metrics.tokens.output, 9);
    assert.strictEqual(metrics.tokens.reasoning_output, 7);
    assert.strictEqual(metrics.tokens.total_raw, 12475);
    assert.strictEqual(metrics.tokens.total_effective, 12459 - 4992 + 9 + 7);
    assert.strictEqual(metrics.execution.message_count, 1);
    assert.strictEqual(metrics.execution.reasoning_record_count, 1);
    assert.strictEqual(metrics.execution.tool_use_count, 3);
    assert.strictEqual(metrics.execution.tool_breakdown.exec_command, 1);
    assert.strictEqual(metrics.execution.tool_breakdown.shell, 1);
    assert.strictEqual(metrics.execution.tool_breakdown.tool_search_tool, 1);
    assert.strictEqual(metrics.execution.error_count, 0);
  });

  it('uses final token_count and wall-clock duration for multi-turn sessions', async () => {
    const filePath = path.join(TEST_DIR, 'multi-turn.jsonl');
    fs.writeFileSync(filePath, multiTurnCodexJSONL());

    const metrics = await extractCodexMetricsFromFile(filePath);

    assert.strictEqual(metrics.duration_ms, 120000);
    assert.strictEqual(metrics.time_to_first_token_ms, 300);
    assert.strictEqual(metrics.final_message, 'Second turn');
    assert.strictEqual(metrics.tokens.input, 300);
    assert.strictEqual(metrics.tokens.cached_input, 50);
    assert.strictEqual(metrics.tokens.output, 60);
    assert.strictEqual(metrics.tokens.reasoning_output, 10);
    assert.strictEqual(metrics.tokens.total_raw, 370);
    assert.strictEqual(metrics.tokens.total_effective, 320);
  });

  it('finds Codex files by filename suffix without requiring date knowledge', async () => {
    const location = await findCodexAgentFile(AGENT_ID);

    assert.ok(location);
    assert.strictEqual(location.filePath, FILE_PATH);
    assert.strictEqual(location.projectDir, '/Users/aself/uluops');
  });

  it('lists only Codex subagent sessions', async () => {
    const parentPath = path.join(SESSIONS_DIR, 'rollout-2026-06-08T17-00-00-019eaa29-8e2d-73a2-840f-a00d6cc8795f.jsonl');
    fs.writeFileSync(parentPath, multiTurnCodexJSONL());

    const files = await findRecentCodexAgentFiles(10);

    assert.ok(files.some(file => file.filePath === FILE_PATH));
    assert.ok(!files.some(file => file.filePath === parentPath));
  });
});
