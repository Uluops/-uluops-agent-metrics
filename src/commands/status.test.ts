/**
 * Status Commands Tests
 *
 * Tests for status and report commands.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { registerStatusCommands } from './status.js';
import { createCommandTestHarness, type CommandTestHarness } from '../test-utils.js';

describe('Status Commands', () => {
  let harness: CommandTestHarness;
  let program: CommandTestHarness['program'];
  let output: CommandTestHarness['output'];

  beforeEach(() => {
    harness = createCommandTestHarness();
    program = harness.program;
    output = harness.output;
    registerStatusCommands(program);
  });

  afterEach(() => {
    harness.restore();
  });

  describe('status command', () => {
    it('should show buffer status with expected fields', async () => {
      await program.parseAsync(['node', 'test', 'status']);

      const textOutput = output.join('\n');
      assert.ok(textOutput.includes('Buffer'), 'Should include Buffer in output');
      assert.ok(textOutput.includes('entries'), 'Should include entries count');
    });
  });

  describe('report command', () => {
    it('should execute report command and show header', async () => {
      await program.parseAsync(['node', 'test', 'report']);

      const textOutput = output.join('\n');
      assert.ok(output.length > 0, 'Should produce at least one line of output');
      assert.ok(textOutput.includes('Agent') || textOutput.includes('Recent') || textOutput.includes('No'),
        'Should show agent report or empty state');
    });

    it('should respect --limit option', async () => {
      await program.parseAsync(['node', 'test', 'report', '-n', '5']);

      assert.strictEqual(harness.exitCode, null, 'Should not exit with error for valid limit');
    });

    it('should reject invalid --limit value', async () => {
      try {
        await program.parseAsync(['node', 'test', 'report', '-n', '0']);
        assert.fail('Should have thrown for limit 0');
      } catch (err) {
        assert.strictEqual(harness.exitCode, 1, 'Should exit with code 1 for invalid limit');
      }
    });

    it('should accept --session filter', async () => {
      await program.parseAsync(['node', 'test', 'report', '-s', 'some-session-id']);

      assert.strictEqual(harness.exitCode, null, 'Should not exit with error');
    });

    it('should accept --current flag', async () => {
      await program.parseAsync(['node', 'test', 'report', '--current']);

      assert.strictEqual(harness.exitCode, null, 'Should not exit with error');
    });

    it('should reject Codex provider with explicit guidance', async () => {
      try {
        await program.parseAsync(['node', 'test', 'report', '--provider', 'codex']);
        assert.fail('Should have thrown for unsupported Codex report');
      } catch {
        const textOutput = output.join('\n');
        assert.strictEqual(harness.exitCode, 1, 'Should exit with code 1');
        assert.ok(textOutput.includes('list --provider codex'), 'Should point to Codex list');
        assert.ok(textOutput.includes('extract <id> --provider codex'), 'Should point to Codex extract');
        assert.ok(textOutput.includes('future Codex hook spec'), 'Should mention future hook direction');
      }
    });

    it('should reject invalid provider values', async () => {
      try {
        await program.parseAsync(['node', 'test', 'report', '--provider', 'invalid']);
        assert.fail('Should have thrown for invalid provider');
      } catch {
        assert.strictEqual(harness.exitCode, null, 'Commander should reject before process.exit override');
      }
    });
  });
});
