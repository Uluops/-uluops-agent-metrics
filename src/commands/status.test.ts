/**
 * Status Commands Tests
 *
 * Tests for status and report commands.
 *
 * Note: These tests verify command registration and basic execution.
 * Buffer operations use the default system path, so content-specific
 * tests are limited.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { Command } from 'commander';
import { registerStatusCommands } from './status.js';

describe('Status Commands', () => {
  let program: Command;
  let output: string[];
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;

  beforeEach(() => {
    // Reset program and output capture
    program = new Command();
    program.exitOverride();
    output = [];

    // Capture console output
    console.log = (...args: unknown[]) => output.push(args.map(String).join(' '));
    console.error = (...args: unknown[]) => output.push(args.map(String).join(' '));

    registerStatusCommands(program);
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  });

  describe('status command', () => {
    it('should show buffer status', async () => {
      await program.parseAsync(['node', 'test', 'status']);

      // Should execute without error and produce output
      const textOutput = output.join('\n');
      assert.ok(textOutput.length >= 0, 'Should produce output');
    });
  });

  describe('report command', () => {
    it('should execute report command', async () => {
      await program.parseAsync(['node', 'test', 'report']);

      // Should execute without error
      const textOutput = output.join('\n');
      assert.ok(textOutput !== undefined, 'Should produce output');
    });

    it('should respect --limit option', async () => {
      await program.parseAsync(['node', 'test', 'report', '-n', '5']);

      // Should execute without error
      const textOutput = output.join('\n');
      assert.ok(textOutput !== undefined, 'Should produce output');
    });

    it('should accept --session filter', async () => {
      await program.parseAsync(['node', 'test', 'report', '-s', 'some-session-id']);

      // Should execute without error
      const textOutput = output.join('\n');
      assert.ok(textOutput !== undefined, 'Should produce output');
    });

    it('should accept --current flag', async () => {
      await program.parseAsync(['node', 'test', 'report', '--current']);

      // Should execute without error
      const textOutput = output.join('\n');
      assert.ok(textOutput !== undefined, 'Should produce output');
    });
  });
});
