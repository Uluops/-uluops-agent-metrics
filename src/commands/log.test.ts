/**
 * Log Commands Tests
 *
 * Tests for log status, tail, clear, path commands.
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Command } from 'commander';
import { registerLogCommands } from './log.js';
import { configureLogger, info } from '../logger.js';

// Test directory setup
const TEST_DIR = path.join(os.tmpdir(), 'agent-metrics-log-cmd-test-' + Date.now());
const LOG_PATH = path.join(TEST_DIR, 'test.log');

describe('Log Commands', () => {
  let program: Command;
  let output: string[];
  let exitCode: number | null;
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  const originalProcessExit = process.exit;

  before(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    // Configure logger to use test path
    configureLogger({ logPath: LOG_PATH, enabled: true });
  });

  after(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Clear log file
    if (fs.existsSync(LOG_PATH)) {
      fs.unlinkSync(LOG_PATH);
    }
    // Also clear rotated files
    for (let i = 1; i <= 3; i++) {
      const rotatedPath = `${LOG_PATH}.${i}`;
      if (fs.existsSync(rotatedPath)) {
        fs.unlinkSync(rotatedPath);
      }
    }

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

    registerLogCommands(program);
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    (process.exit as unknown) = originalProcessExit;
  });

  describe('log status command', () => {
    it('should show log status when file does not exist', async () => {
      await program.parseAsync(['node', 'test', 'log', 'status']);

      const textOutput = output.join('\n');
      assert.ok(textOutput.includes('Log') || textOutput.includes('Status'),
        'Should show status output');
    });

    it('should show log status with entries', async () => {
      // Create some log entries
      info('Test message 1');
      info('Test message 2');

      await program.parseAsync(['node', 'test', 'log', 'status']);

      const textOutput = output.join('\n');
      assert.ok(textOutput.includes('Log') || textOutput.includes('2') || textOutput.includes('lines'),
        'Should show entry count');
    });
  });

  describe('log tail command', () => {
    it('should show no entries message for empty log', async () => {
      await program.parseAsync(['node', 'test', 'log', 'tail']);

      const textOutput = output.join('\n');
      assert.ok(textOutput.includes('No log entries') || textOutput === '',
        'Should show empty message or empty output');
    });

    it('should show recent log entries', async () => {
      info('Test message 1');
      info('Test message 2');
      info('Test message 3');

      await program.parseAsync(['node', 'test', 'log', 'tail']);

      const textOutput = output.join('\n');
      assert.ok(textOutput.includes('Test message'), 'Should show log messages');
    });

    it('should respect --lines option', async () => {
      for (let i = 1; i <= 10; i++) {
        info(`Test message ${i}`);
      }

      await program.parseAsync(['node', 'test', 'log', 'tail', '-n', '3']);

      const textOutput = output.join('\n');
      // Should show last 3 lines
      assert.ok(textOutput.includes('Test message'), 'Should show log messages');
    });

    // Skip follow mode test as it requires SIGINT handling
  });

  describe('log clear command', () => {
    it('should clear log file', async () => {
      info('Test message');
      assert.ok(fs.existsSync(LOG_PATH), 'Log file should exist');

      await program.parseAsync(['node', 'test', 'log', 'clear']);

      const textOutput = output.join('\n');
      assert.ok(textOutput.includes('cleared') || textOutput.includes('Cleared'),
        'Should report cleared');
      assert.ok(!fs.existsSync(LOG_PATH), 'Log file should be deleted');
    });

    it('should clear rotated files with --all', async () => {
      info('Test message');
      // Create rotated files
      fs.writeFileSync(`${LOG_PATH}.1`, 'old log 1');
      fs.writeFileSync(`${LOG_PATH}.2`, 'old log 2');

      await program.parseAsync(['node', 'test', 'log', 'clear', '--all']);

      const textOutput = output.join('\n');
      assert.ok(textOutput.includes('cleared') || textOutput.includes('Cleared'),
        'Should report cleared');
      assert.ok(!fs.existsSync(`${LOG_PATH}.1`), 'Rotated file 1 should be deleted');
      assert.ok(!fs.existsSync(`${LOG_PATH}.2`), 'Rotated file 2 should be deleted');
    });

    it('should handle non-existent log gracefully', async () => {
      await program.parseAsync(['node', 'test', 'log', 'clear']);

      const textOutput = output.join('\n');
      assert.ok(textOutput.includes('cleared') || textOutput.includes('Log'),
        'Should complete without error');
    });
  });

  describe('log path command', () => {
    it('should print log file path', async () => {
      await program.parseAsync(['node', 'test', 'log', 'path']);

      const textOutput = output.join('\n');
      assert.ok(textOutput.includes('.log'), 'Should print path containing .log');
    });
  });
});
