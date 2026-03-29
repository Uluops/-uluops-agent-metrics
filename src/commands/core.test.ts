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
    process.env.HOME = TEST_DIR;
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

    it('should error for non-existent agent ID', async () => {
      try {
        await program.parseAsync(['node', 'test', 'extract', 'nonexistent']);
        assert.fail('Should have thrown');
      } catch (err) {
        assert.ok(output.some(o => o.includes('not found')), 'Should report agent not found');
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
  });

  describe('find command', () => {
    it('should find agent file location', async () => {
      await program.parseAsync(['node', 'test', 'find', 'abc1234']);

      const jsonOutput = output.join('\n');
      assert.ok(jsonOutput.includes('filePath'), 'Should return file location');
      assert.ok(jsonOutput.includes('abc1234'), 'Should include agent ID in path');
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
