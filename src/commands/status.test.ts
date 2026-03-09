/**
 * Status Commands Tests
 *
 * Tests for status and report commands.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { Command } from 'commander';
import { registerStatusCommands } from './status.js';

describe('Status Commands', () => {
  let program: Command;
  let output: string[];
  let exitCode: number | null;
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  const originalProcessExit = process.exit;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    output = [];
    exitCode = null;

    console.log = (...args: unknown[]) => output.push(args.map(String).join(' '));
    console.error = (...args: unknown[]) => output.push(args.map(String).join(' '));
    (process.exit as unknown) = (code: number) => {
      exitCode = code;
      throw new Error(`EXIT:${code}`);
    };

    registerStatusCommands(program);
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    (process.exit as unknown) = originalProcessExit;
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

      assert.strictEqual(exitCode, null, 'Should not exit with error for valid limit');
    });

    it('should reject invalid --limit value', async () => {
      try {
        await program.parseAsync(['node', 'test', 'report', '-n', '0']);
        assert.fail('Should have thrown for limit 0');
      } catch (err) {
        assert.strictEqual(exitCode, 1, 'Should exit with code 1 for invalid limit');
      }
    });

    it('should accept --session filter', async () => {
      await program.parseAsync(['node', 'test', 'report', '-s', 'some-session-id']);

      assert.strictEqual(exitCode, null, 'Should not exit with error');
    });

    it('should accept --current flag', async () => {
      await program.parseAsync(['node', 'test', 'report', '--current']);

      assert.strictEqual(exitCode, null, 'Should not exit with error');
    });
  });
});
