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
import { registerLogCommands } from './log.js';
import { configureLogger, info } from '../logger.js';
import { createCommandTestHarness, type CommandTestHarness } from '../test-utils.js';

// Test directory setup
const TEST_DIR = path.join(os.tmpdir(), 'agent-metrics-log-cmd-test-' + Date.now());
const LOG_PATH = path.join(TEST_DIR, 'test.log');

describe('Log Commands', () => {
  let harness: CommandTestHarness;
  let program: CommandTestHarness['program'];
  let output: CommandTestHarness['output'];

  before(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
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
    for (let i = 1; i <= 3; i++) {
      const rotatedPath = `${LOG_PATH}.${i}`;
      if (fs.existsSync(rotatedPath)) {
        fs.unlinkSync(rotatedPath);
      }
    }

    harness = createCommandTestHarness();
    program = harness.program;
    output = harness.output;
    registerLogCommands(program);
  });

  afterEach(() => {
    harness.restore();
  });

  describe('log status command', () => {
    it('should show log status when file does not exist', async () => {
      await program.parseAsync(['node', 'test', 'log', 'status']);

      const textOutput = output.join('\n');
      assert.ok(textOutput.includes('Log'), 'Should show Log in status output');
    });

    it('should show log status with entries', async () => {
      // Create some log entries
      info('Test message 1');
      info('Test message 2');

      await program.parseAsync(['node', 'test', 'log', 'status']);

      const textOutput = output.join('\n');
      assert.ok(textOutput.includes('Log'), 'Should include Log header');
      assert.ok(textOutput.includes('2') || textOutput.includes('Line count'),
        'Should show entry count or line count');
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
      assert.ok(textOutput.includes('Test message'), 'Should show log messages');
      // Should only show last 3 messages, not earlier ones
      const messageLines = textOutput.split('\n').filter(l => l.includes('Test message'));
      assert.ok(messageLines.length <= 3, `Should show at most 3 lines, got ${messageLines.length}`);
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
