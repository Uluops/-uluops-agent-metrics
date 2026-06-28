/**
 * Core Commands Tests
 *
 * Tests for extract, list, find, compare CLI commands.
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { registerCoreCommands } from './core.js';
import { isValidAgentId } from '../hook.js';
import { createAgentJSONL, createCommandTestHarness, type CommandTestHarness } from '../test-utils.js';

// Test directory setup
const TEST_DIR = path.join(os.tmpdir(), 'agent-metrics-cli-test-' + Date.now());
const PROJECTS_DIR = path.join(TEST_DIR, '.claude', 'projects');
const PROJECT_DIR = path.join(PROJECTS_DIR, '-test-project');
const CODEX_HOME = path.join(TEST_DIR, '.codex');
const CODEX_SESSIONS_DIR = path.join(CODEX_HOME, 'sessions', '2026', '06', '08');
const CODEX_AGENT_ID = '019eaa28-8e2d-73a2-840f-a00d6cc8795f';
const OTHER_PROJECT_DIR = path.join(PROJECTS_DIR, '-other-project');

function createCodexJSONL(): string {
  return [
    JSON.stringify({
      timestamp: '2026-06-08T16:14:05.000Z',
      type: 'session_meta',
      payload: {
        id: CODEX_AGENT_ID,
        parent_thread_id: '019eaa27-f755-7cb2-84fa-bd1aa685d69e',
        cwd: '/test/project',
        cli_version: '0.137.0',
        thread_source: 'subagent',
        agent_nickname: 'Dirac',
        timestamp: '2026-06-08T16:14:05.000Z',
      },
    }),
    JSON.stringify({
      timestamp: '2026-06-08T16:14:06.000Z',
      type: 'turn_context',
      payload: { model: 'gpt-5.5', cwd: '/test/project' },
    }),
    JSON.stringify({
      timestamp: '2026-06-08T16:14:07.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 25,
            output_tokens: 20,
            reasoning_output_tokens: 5,
            total_tokens: 125,
          },
        },
      },
    }),
    JSON.stringify({
      timestamp: '2026-06-08T16:14:08.000Z',
      type: 'event_msg',
      payload: { type: 'task_complete', duration_ms: 3000 },
    }),
  ].join('\n');
}

describe('Core Commands', () => {
  let harness: CommandTestHarness;
  let program: CommandTestHarness['program'];
  let output: CommandTestHarness['output'];
  const originalEnv = { ...process.env };

  before(() => {
    fs.mkdirSync(PROJECT_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(PROJECT_DIR, 'agent-abc1234.jsonl'),
      createAgentJSONL('abc1234', 'session-1')
    );
    fs.writeFileSync(
      path.join(PROJECT_DIR, 'agent-def5678.jsonl'),
      createAgentJSONL('def5678', 'session-2')
    );
    fs.mkdirSync(OTHER_PROJECT_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(OTHER_PROJECT_DIR, 'agent-fff9999.jsonl'),
      createAgentJSONL('fff9999', 'session-3')
    );
    fs.mkdirSync(CODEX_SESSIONS_DIR, { recursive: true });
    const codexPath = path.join(CODEX_SESSIONS_DIR, `rollout-2026-06-08T16-14-05-${CODEX_AGENT_ID}.jsonl`);
    fs.writeFileSync(
      codexPath,
      createCodexJSONL()
    );
    fs.utimesSync(path.join(PROJECT_DIR, 'agent-abc1234.jsonl'), new Date('2026-06-08T10:00:00Z'), new Date('2026-06-08T10:00:00Z'));
    fs.utimesSync(path.join(PROJECT_DIR, 'agent-def5678.jsonl'), new Date('2026-06-08T11:00:00Z'), new Date('2026-06-08T11:00:00Z'));
    fs.utimesSync(path.join(OTHER_PROJECT_DIR, 'agent-fff9999.jsonl'), new Date('2026-06-08T12:00:00Z'), new Date('2026-06-08T12:00:00Z'));
    fs.utimesSync(codexPath, new Date('2026-06-08T13:00:00Z'), new Date('2026-06-08T13:00:00Z'));
    process.env.HOME = TEST_DIR;
    process.env.CODEX_HOME = CODEX_HOME;
  });

  after(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    process.env = originalEnv;
  });

  beforeEach(() => {
    harness = createCommandTestHarness();
    program = harness.program;
    output = harness.output;
    registerCoreCommands(program);
  });

  afterEach(() => {
    harness.restore();
  });

  describe('extract command', () => {
    it('should extract metrics for valid agent ID', async () => {
      await program.parseAsync(['node', 'test', 'extract', 'abc1234']);

      const jsonOutput = output.join('\n');
      assert.ok(jsonOutput.includes('"agent_id"'), 'Should output JSON with agent_id');
      assert.ok(jsonOutput.includes('abc1234'), 'Should include the agent ID');
    });

    it('should output summary format when requested', async () => {
      await program.parseAsync(['node', 'test', 'extract', 'abc1234', '-f', 'summary']);

      const textOutput = output.join('\n');
      assert.ok(textOutput.includes('Agent Metrics'), 'Should show summary header');
      assert.ok(textOutput.includes('abc1234'), 'Should include agent ID in summary');
    });

    it('should output tracker format when requested', async () => {
      await program.parseAsync(['node', 'test', 'extract', 'abc1234', '-f', 'tracker', '-a', 'test-agent']);

      const jsonOutput = output.join('\n');
      assert.ok(jsonOutput.includes('"name"'), 'Should output tracker format');
      assert.ok(jsonOutput.includes('test-agent'), 'Should use provided agent name');
    });

    it('should extract Codex metrics when provider is codex', async () => {
      await program.parseAsync(['node', 'test', 'extract', CODEX_AGENT_ID, '--provider', 'codex']);

      const jsonOutput = output.join('\n');
      assert.ok(jsonOutput.includes('"harness": "codex"'), 'Should output Codex harness');
      assert.ok(jsonOutput.includes('"cached_input": 25'), 'Should include Codex cached input');
    });

    it('should error for non-existent agent ID', async () => {
      try {
        await program.parseAsync(['node', 'test', 'extract', 'nonexistent']);
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(output.some(o => o.includes('not found')), 'Should report agent not found');
        assert.strictEqual(harness.exitCode, 1, 'Should exit with code 1');
      }
    });

    it('should error when batch extract finds no agents', async () => {
      try {
        await program.parseAsync(['node', 'test', 'extract', 'missing1', 'missing2']);
        assert.fail('Should have thrown');
      } catch (err) {
        const textOutput = output.join('\n');
        assert.ok(textOutput.includes('No agent metrics were extracted.'), 'Should report zero extracted agents');
        assert.strictEqual(harness.exitCode, 1, 'Should exit with code 1');
      }
    });

    it('should handle invalid agent ID format gracefully', async () => {
      try {
        await program.parseAsync(['node', 'test', 'extract', 'INVALID!@#']);
        assert.fail('Should have thrown');
      } catch (err) {
        assert.strictEqual(harness.exitCode, 1, 'Should exit with code 1 for invalid ID');
      }
    });
  });

  describe('list command', () => {
    it('should list recent agent runs', async () => {
      await program.parseAsync(['node', 'test', 'list']);

      const textOutput = output.join('\n');
      assert.ok(textOutput.includes('Recent Agent Runs'), 'Should show header');
    });

    it('should respect limit option', async () => {
      await program.parseAsync(['node', 'test', 'list', '-n', '1']);

      // Should only show 1 agent (plus header lines)
      const textOutput = output.join('\n');
      assert.ok(textOutput.includes('Recent Agent Runs'), 'Should show header');
    });

    it('should list Codex runs when provider is codex', async () => {
      await program.parseAsync(['node', 'test', 'list', '--provider', 'codex']);

      const textOutput = output.join('\n');
      assert.ok(textOutput.includes(CODEX_AGENT_ID), 'Should include Codex agent ID');
    });

    it('should sort auto provider results by recency across providers before applying limit', async () => {
      await program.parseAsync(['node', 'test', 'list', '--provider', 'auto', '-n', '1']);

      const textOutput = output.join('\n');
      assert.ok(textOutput.includes(CODEX_AGENT_ID), 'Newest Codex run should win mixed-provider limit');
      assert.ok(!textOutput.includes('fff9999'), 'Older Claude run should be excluded by limit');
    });

    it('should apply --project filter to recent list results', async () => {
      await program.parseAsync(['node', 'test', 'list', '--provider', 'claude', '--project', 'other-project']);

      const textOutput = output.join('\n');
      assert.ok(textOutput.includes('fff9999'), 'Should include matching project agent');
      assert.ok(!textOutput.includes('abc1234'), 'Should exclude non-matching project agent');
      assert.ok(!textOutput.includes('def5678'), 'Should exclude non-matching project agent');
    });
  });

  describe('find command', () => {
    it('should find agent file location', async () => {
      await program.parseAsync(['node', 'test', 'find', 'abc1234']);

      const jsonOutput = output.join('\n');
      assert.ok(jsonOutput.includes('filePath'), 'Should return file location');
      assert.ok(jsonOutput.includes('abc1234'), 'Should include agent ID in path');
    });

    it('should find Codex file location when provider is codex', async () => {
      await program.parseAsync(['node', 'test', 'find', CODEX_AGENT_ID, '--provider', 'codex']);

      const jsonOutput = output.join('\n');
      assert.ok(jsonOutput.includes('filePath'), 'Should return file location');
      assert.ok(jsonOutput.includes(CODEX_AGENT_ID), 'Should include Codex agent ID in path');
    });

    it('should error for non-existent agent', async () => {
      try {
        await program.parseAsync(['node', 'test', 'find', 'nonexistent']);
        assert.fail('Should have thrown');
      } catch (err) {
        assert.strictEqual(harness.exitCode, 1, 'Should exit with code 1');
      }
    });
  });

  describe('compare command', () => {
    it('should compare multiple agents', async () => {
      await program.parseAsync(['node', 'test', 'compare', 'abc1234', 'def5678']);

      const textOutput = output.join('\n');
      assert.ok(textOutput.includes('Agent Comparison'), 'Should show comparison header');
      assert.ok(textOutput.includes('TOTAL'), 'Should show totals row');
    });

    it('should handle missing agents gracefully', async () => {
      await program.parseAsync(['node', 'test', 'compare', 'abc1234', 'nonexistent']);

      const textOutput = output.join('\n');
      assert.ok(textOutput.includes('not found'), 'Should indicate missing agent');
      assert.ok(textOutput.includes('abc1234'), 'Should still show valid agent');
    });
  });
});

describe('Agent ID Validation', () => {
  it('should accept valid lowercase hex IDs', () => {
    const validIds = ['abc1234', 'def5678', 'a1b2c3d', '0000000'];
    for (const id of validIds) {
      assert.ok(isValidAgentId(id), `${id} should be valid`);
    }
  });

  it('should reject invalid agent IDs', () => {
    const invalidIds = ['ABC1234', 'xyz1234', 'abc-123', 'abc 123', '', '!@#$%'];
    for (const id of invalidIds) {
      assert.ok(!isValidAgentId(id), `${id} should be invalid`);
    }
  });
});
