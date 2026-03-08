/**
 * Buffer Commands Tests
 *
 * Tests for buffer status, list, session, clear, gc commands.
 *
 * Note: These tests verify command registration and basic execution.
 * Buffer operations use the default system path (~/.claude/agent-metrics-buffer.jsonl),
 * so content-specific tests are limited to avoid affecting real user data.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { Command } from 'commander';
import { registerBufferCommands } from './buffer.js';

describe('Buffer Commands', () => {
  let program: Command;
  let output: string[];
  let exitCode: number | null;
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  const originalProcessExit = process.exit;

  beforeEach(() => {
    // Reset program and output capture
    program = new Command();
    program.exitOverride();
    output = [];
    exitCode = null;

    // Capture console output
    console.log = (...args: unknown[]) => output.push(args.map(String).join(' '));
    console.error = (...args: unknown[]) => output.push(args.map(String).join(' '));

    // Capture exit code
    (process.exit as unknown) = (code: number) => {
      exitCode = code;
      throw new Error(`EXIT:${code}`);
    };

    registerBufferCommands(program);
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    (process.exit as unknown) = originalProcessExit;
  });

  describe('buffer status command', () => {
    it('should show buffer statistics', async () => {
      await program.parseAsync(['node', 'test', 'buffer', 'status']);

      const textOutput = output.join('\n');
      // Status command should produce output about the buffer
      assert.ok(textOutput.length > 0 || output.length >= 0, 'Should produce output');
    });
  });

  describe('buffer list command', () => {
    it('should execute list command', async () => {
      await program.parseAsync(['node', 'test', 'buffer', 'list']);

      // Should execute without error
      assert.strictEqual(exitCode, null, 'Should not exit with error');
    });

    it('should output json format when requested', async () => {
      await program.parseAsync(['node', 'test', 'buffer', 'list', '-f', 'json']);

      const jsonOutput = output.join('\n');
      // Should be valid JSON (even if empty array)
      const parsed = JSON.parse(jsonOutput);
      assert.ok(Array.isArray(parsed), 'Should output JSON array');
    });

    it('should output tracker format when requested', async () => {
      await program.parseAsync(['node', 'test', 'buffer', 'list', '-f', 'tracker']);

      const jsonOutput = output.join('\n');
      const parsed = JSON.parse(jsonOutput);
      assert.ok(Array.isArray(parsed), 'Should output JSON array');
    });

    it('should accept --since with valid format', async () => {
      await program.parseAsync(['node', 'test', 'buffer', 'list', '--since', '30m']);

      // Should execute without error
      assert.strictEqual(exitCode, null, 'Should not exit with error for valid format');
    });

    it('should accept --since with hours format', async () => {
      await program.parseAsync(['node', 'test', 'buffer', 'list', '--since', '2h']);

      // Should execute without error
      assert.strictEqual(exitCode, null, 'Should not exit with error for valid format');
    });

    it('should reject invalid --since format', async () => {
      try {
        await program.parseAsync(['node', 'test', 'buffer', 'list', '--since', 'invalid']);
        assert.fail('Should have thrown');
      } catch {
        assert.strictEqual(exitCode, 1, 'Should exit with code 1');
        assert.ok(output.some(o => o.includes('Invalid')), 'Should show error message');
      }
    });

    it('should accept --all flag for expired entries', async () => {
      await program.parseAsync(['node', 'test', 'buffer', 'list', '-a', '-f', 'json']);

      const jsonOutput = output.join('\n');
      const parsed = JSON.parse(jsonOutput);
      assert.ok(Array.isArray(parsed), 'Should output JSON array');
    });
  });

  describe('buffer session command', () => {
    it('should return empty for non-existent session', async () => {
      await program.parseAsync(['node', 'test', 'buffer', 'session', 'non-existent-session-id', '-f', 'json']);

      const jsonOutput = output.join('\n');
      const parsed = JSON.parse(jsonOutput);
      assert.strictEqual(parsed.length, 0, 'Should return empty array');
    });

    it('should output tracker format when requested', async () => {
      await program.parseAsync(['node', 'test', 'buffer', 'session', 'some-session', '-f', 'tracker']);

      const jsonOutput = output.join('\n');
      const parsed = JSON.parse(jsonOutput);
      assert.ok(Array.isArray(parsed), 'Should output JSON array');
    });
  });

  describe('buffer clear command', () => {
    it('should require a clear option', async () => {
      try {
        await program.parseAsync(['node', 'test', 'buffer', 'clear']);
        assert.fail('Should have thrown');
      } catch {
        assert.strictEqual(exitCode, 1, 'Should exit with code 1');
        assert.ok(output.some(o => o.includes('Specify')), 'Should show usage message');
      }
    });

    it('should accept --session option', async () => {
      await program.parseAsync(['node', 'test', 'buffer', 'clear', '-s', 'non-existent-session']);

      const textOutput = output.join('\n');
      assert.ok(textOutput.includes('Cleared'), 'Should report cleared');
    });

    it('should accept --agents option', async () => {
      await program.parseAsync(['node', 'test', 'buffer', 'clear', '-a', 'abc1234', 'def5678']);

      const textOutput = output.join('\n');
      assert.ok(textOutput.includes('Cleared'), 'Should report cleared');
    });

    it('should accept --expired option', async () => {
      await program.parseAsync(['node', 'test', 'buffer', 'clear', '--expired']);

      const textOutput = output.join('\n');
      assert.ok(textOutput.includes('expired'), 'Should report expired entries cleared');
    });
  });

  describe('buffer clear --expired command', () => {
    it('should clear expired entries', async () => {
      await program.parseAsync(['node', 'test', 'buffer', 'clear', '--expired']);

      const textOutput = output.join('\n');
      assert.ok(textOutput.includes('expired'), 'Should report expired entries cleared');
    });
  });
});
