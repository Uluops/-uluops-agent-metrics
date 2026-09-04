/**
 * Logger Module Tests
 *
 * Tests for logging functionality including:
 * - Logger configuration
 * - Log level filtering
 * - Log file rotation
 * - Log entry formatting
 * - Reading logs
 * - Log statistics
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  configureLogger,
  getLoggerConfig,
  debug,
  info,
  warn,
  error,
  readRecentLogs,
  getLogStats,
  logMetricsCapture,
  logBufferOperation,
  type LogLevel,
} from './logger.js';

// Test configuration with isolated temp directory
const TEST_DIR = path.join(os.tmpdir(), 'agent-metrics-logger-test-' + Date.now());
const TEST_LOG_PATH = path.join(TEST_DIR, 'test.log');

describe('Logger Module', () => {
  before(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  after(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Reset logger configuration for each test
    configureLogger({
      logPath: TEST_LOG_PATH,
      minLevel: 'debug',
      enabled: true,
      maxFileSize: 10 * 1024 * 1024,
      maxFiles: 3,
    });

    // Clear any existing log files
    if (fs.existsSync(TEST_LOG_PATH)) {
      fs.unlinkSync(TEST_LOG_PATH);
    }
    for (let i = 1; i <= 5; i++) {
      const rotatedPath = `${TEST_LOG_PATH}.${i}`;
      if (fs.existsSync(rotatedPath)) {
        fs.unlinkSync(rotatedPath);
      }
    }
  });

  describe('configureLogger', () => {
    it('should update logger configuration', () => {
      const newPath = path.join(TEST_DIR, 'custom.log');
      configureLogger({
        logPath: newPath,
        minLevel: 'warn',
        enabled: false,
      });

      const config = getLoggerConfig();
      assert.strictEqual(config.logPath, newPath);
      assert.strictEqual(config.minLevel, 'warn');
      assert.strictEqual(config.enabled, false);
    });

    it('should preserve unspecified config values', () => {
      const originalConfig = getLoggerConfig();
      configureLogger({ minLevel: 'error' });

      const newConfig = getLoggerConfig();
      assert.strictEqual(newConfig.minLevel, 'error');
      assert.strictEqual(newConfig.maxFileSize, originalConfig.maxFileSize);
    });

    describe('issue 1f6d6ba2: invalid/undefined values do not overwrite a good config', () => {
      let originalWrite: typeof process.stderr.write;

      beforeEach(() => {
        originalWrite = process.stderr.write;
        configureLogger({ logPath: TEST_LOG_PATH, minLevel: 'debug', enabled: true });
      });

      afterEach(() => {
        process.stderr.write = originalWrite;
      });

      it('rejects an invalid minLevel and retains the current (stricter) level', () => {
        configureLogger({ minLevel: 'error' });
        process.stderr.write = (() => true) as typeof process.stderr.write;

        configureLogger({ minLevel: 'verbose' as LogLevel });

        assert.strictEqual(getLoggerConfig().minLevel, 'error', 'minLevel must not be loosened by an invalid value');

        fs.writeFileSync(TEST_LOG_PATH, '');
        debug('should not be written');
        error('should be written');

        const content = fs.readFileSync(TEST_LOG_PATH, 'utf-8');
        assert.ok(!content.includes('should not be written'), 'debug entry must be dropped — minLevel is still error');
        assert.ok(content.includes('should be written'), 'error entry must be written — minLevel is still error');
      });

      it('rejects an undefined minLevel and retains the current value', () => {
        configureLogger({ minLevel: 'error' });

        configureLogger({ minLevel: undefined });

        assert.strictEqual(getLoggerConfig().minLevel, 'error', 'minLevel must not be reset by an explicit undefined');

        fs.writeFileSync(TEST_LOG_PATH, '');
        debug('should not be written either');
        const content = fs.readFileSync(TEST_LOG_PATH, 'utf-8');
        assert.ok(!content.includes('should not be written either'), 'debug entry must be dropped — minLevel is still error');
      });

      it('control: a valid minLevel still applies', () => {
        configureLogger({ minLevel: 'error' });
        configureLogger({ minLevel: 'debug' });

        assert.strictEqual(getLoggerConfig().minLevel, 'debug');

        fs.writeFileSync(TEST_LOG_PATH, '');
        debug('written when valid debug applies');
        const content = fs.readFileSync(TEST_LOG_PATH, 'utf-8');
        assert.ok(content.includes('written when valid debug applies'));
      });

      it('control: sibling keys in the same call still apply when minLevel is rejected', () => {
        configureLogger({ minLevel: 'error', maxFiles: 3 });

        configureLogger({ minLevel: 'nope' as LogLevel, maxFiles: 7 });

        const config = getLoggerConfig();
        assert.strictEqual(config.maxFiles, 7, 'sibling key must still apply');
        assert.strictEqual(config.minLevel, 'error', 'rejected minLevel must be retained, not defaulted');
      });

      it('rejects a prototype-pollution-shaped minLevel ("constructor")', () => {
        configureLogger({ minLevel: 'error' });

        configureLogger({ minLevel: 'constructor' as LogLevel });

        assert.strictEqual(getLoggerConfig().minLevel, 'error', '"constructor" must not pass as a valid LogLevel');
      });
    });

    describe('tracker 0a05e8be: maxFiles / maxFileSize range validation', () => {
      let originalWrite: typeof process.stderr.write;

      beforeEach(() => {
        originalWrite = process.stderr.write;
        configureLogger({ logPath: TEST_LOG_PATH, minLevel: 'debug', enabled: true, maxFiles: 3, maxFileSize: 1024 });
        process.stderr.write = (() => true) as typeof process.stderr.write;
      });

      afterEach(() => {
        process.stderr.write = originalWrite;
      });

      it('rejects maxFiles: 0 and retains the current value', () => {
        configureLogger({ maxFiles: 0 });

        assert.strictEqual(getLoggerConfig().maxFiles, 3, 'maxFiles must not be set below 1');
      });

      it('warns to stderr naming the key and value when maxFiles is rejected', () => {
        const written: string[] = [];
        process.stderr.write = ((chunk: string) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;

        configureLogger({ maxFiles: 0 });

        assert.ok(written.some(w => w.includes('maxFiles') && w.includes('0')), 'warning must name the key and the rejected value');
      });

      it('rejects maxFileSize: -1 and retains the current value', () => {
        configureLogger({ maxFileSize: -1 });

        assert.strictEqual(getLoggerConfig().maxFileSize, 1024, 'maxFileSize must not be set to a non-positive value');
      });

      it('warns to stderr naming the key and value when maxFileSize is rejected', () => {
        const written: string[] = [];
        process.stderr.write = ((chunk: string) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;

        configureLogger({ maxFileSize: -1 });

        assert.ok(written.some(w => w.includes('maxFileSize') && w.includes('-1')), 'warning must name the key and the rejected value');
      });

      it('rejects a non-integer maxFiles', () => {
        configureLogger({ maxFiles: 2.5 });

        assert.strictEqual(getLoggerConfig().maxFiles, 3, 'maxFiles must be an integer');
      });

      it('rejects a non-finite maxFileSize', () => {
        configureLogger({ maxFileSize: Infinity });

        assert.strictEqual(getLoggerConfig().maxFileSize, 1024, 'maxFileSize must be finite');
      });

      it('control: a valid maxFiles still applies', () => {
        configureLogger({ maxFiles: 7 });

        assert.strictEqual(getLoggerConfig().maxFiles, 7);
      });

      it('control: a valid maxFileSize still applies', () => {
        configureLogger({ maxFileSize: 2048 });

        assert.strictEqual(getLoggerConfig().maxFileSize, 2048);
      });

      it('control: sibling keys in the same call still apply when maxFiles is rejected', () => {
        configureLogger({ maxFiles: 0, minLevel: 'warn' });

        const config = getLoggerConfig();
        assert.strictEqual(config.minLevel, 'warn', 'sibling key must still apply');
        assert.strictEqual(config.maxFiles, 3, 'rejected maxFiles must be retained, not defaulted');
      });
    });
  });

  describe('File permissions (spec 05 — logger half)', () => {
    function skipPerms(): boolean {
      return process.getuid?.() === 0 || process.platform === 'win32';
    }

    it('creates the log file 0600 and a fresh log directory 0700', (t) => {
      if (skipPerms()) { t.skip('mode bits are not enforced for root / on Windows'); return; }
      const freshDir = path.join(TEST_DIR, 'perm-' + Date.now(), 'nested');
      const logPath = path.join(freshDir, 'perm.log');
      try {
        configureLogger({ logPath, enabled: true, minLevel: 'info' });
        info('permissions probe');
        const fileMode = fs.statSync(logPath).mode & 0o777;
        assert.strictEqual(fileMode, 0o600, `expected log mode 0600, got ${fileMode.toString(8)}`);
        const dirMode = fs.statSync(freshDir).mode & 0o777;
        assert.strictEqual(dirMode, 0o700, `expected log dir mode 0700, got ${dirMode.toString(8)}`);
      } finally {
        configureLogger({ logPath: TEST_LOG_PATH, enabled: true, minLevel: 'debug' });
      }
    });
  });

  describe('getLoggerConfig', () => {
    it('should return a copy of the configuration', () => {
      const config1 = getLoggerConfig();
      const config2 = getLoggerConfig();

      assert.notStrictEqual(config1, config2);
      assert.deepStrictEqual(config1, config2);
    });
  });

  describe('Log Level Filtering', () => {
    it('should write debug messages when minLevel is debug', () => {
      configureLogger({ logPath: TEST_LOG_PATH, minLevel: 'debug', enabled: true });

      debug('Debug message');
      info('Info message');
      warn('Warn message');
      error('Error message');

      const logs = readRecentLogs(10);
      assert.strictEqual(logs.length, 4);
      assert.ok(logs[0].includes('DEBUG'));
      assert.ok(logs[1].includes('INFO'));
      assert.ok(logs[2].includes('WARN'));
      assert.ok(logs[3].includes('ERROR'));
    });

    it('should filter debug when minLevel is info', () => {
      configureLogger({ logPath: TEST_LOG_PATH, minLevel: 'info', enabled: true });

      debug('Debug message');
      info('Info message');

      const logs = readRecentLogs(10);
      assert.strictEqual(logs.length, 1);
      assert.ok(logs[0].includes('INFO'));
    });

    it('should filter debug and info when minLevel is warn', () => {
      configureLogger({ logPath: TEST_LOG_PATH, minLevel: 'warn', enabled: true });

      debug('Debug message');
      info('Info message');
      warn('Warn message');
      error('Error message');

      const logs = readRecentLogs(10);
      assert.strictEqual(logs.length, 2);
      assert.ok(logs[0].includes('WARN'));
      assert.ok(logs[1].includes('ERROR'));
    });

    it('should only write errors when minLevel is error', () => {
      configureLogger({ logPath: TEST_LOG_PATH, minLevel: 'error', enabled: true });

      debug('Debug message');
      info('Info message');
      warn('Warn message');
      error('Error message');

      const logs = readRecentLogs(10);
      assert.strictEqual(logs.length, 1);
      assert.ok(logs[0].includes('ERROR'));
    });
  });

  describe('Logging Enabled/Disabled', () => {
    it('should not write when logging is disabled', () => {
      configureLogger({ logPath: TEST_LOG_PATH, enabled: false });

      info('This should not be logged');

      const logs = readRecentLogs(10);
      assert.strictEqual(logs.length, 0);
    });

    it('should write when logging is enabled', () => {
      configureLogger({ logPath: TEST_LOG_PATH, enabled: true });

      info('This should be logged');

      const logs = readRecentLogs(10);
      assert.strictEqual(logs.length, 1);
    });
  });

  describe('Log Entry Format', () => {
    it('should include timestamp', () => {
      info('Test message');

      const logs = readRecentLogs(1);
      assert.strictEqual(logs.length, 1);
      // Should match ISO 8601 format: [2026-01-08T04:45:00.000Z]
      assert.ok(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z\]/.test(logs[0]));
    });

    it('should include log level', () => {
      info('Test message');
      warn('Test warning');

      const logs = readRecentLogs(2);
      assert.ok(logs[0].includes('INFO'));
      assert.ok(logs[1].includes('WARN'));
    });

    it('should include message', () => {
      info('My specific test message');

      const logs = readRecentLogs(1);
      assert.ok(logs[0].includes('My specific test message'));
    });

    it('should include JSON data when provided', () => {
      info('Test with data', { foo: 'bar', count: 42 });

      const logs = readRecentLogs(1);
      assert.ok(logs[0].includes('"foo":"bar"'));
      assert.ok(logs[0].includes('"count":42'));
    });

    it('should not include data section for empty data', () => {
      info('Test without data');

      const logs = readRecentLogs(1);
      // Should not have JSON object at the end
      assert.ok(!logs[0].includes('{'));
    });
  });

  describe('Log Rotation', () => {
    it('should rotate when file exceeds maxFileSize', () => {
      // Configure with very small max size
      configureLogger({
        logPath: TEST_LOG_PATH,
        maxFileSize: 100, // 100 bytes
        maxFiles: 3,
        enabled: true,
        minLevel: 'info',
      });

      // Write enough data to trigger rotation
      for (let i = 0; i < 20; i++) {
        info(`Message ${i} that will cause rotation because it is long enough`);
      }

      // Check that rotated file exists
      assert.ok(fs.existsSync(`${TEST_LOG_PATH}.1`), 'Rotated file .1 should exist');

      // Current log file should be smaller than maxFileSize or recently rotated
      const stats = fs.statSync(TEST_LOG_PATH);
      // After rotation, current log should be smaller than maxFileSize (100 bytes) + one message overhead
      assert.ok(stats.size < 100 * 5, 'Current log should be relatively small after rotation');
    });

    it('should not rotate when under maxFileSize', () => {
      configureLogger({
        logPath: TEST_LOG_PATH,
        maxFileSize: 1024 * 1024, // 1MB
        enabled: true,
        minLevel: 'info',
      });

      info('Small message');

      assert.ok(!fs.existsSync(`${TEST_LOG_PATH}.1`), 'Should not create rotated file for small log');
    });

    it('should respect maxFiles limit', () => {
      configureLogger({
        logPath: TEST_LOG_PATH,
        maxFileSize: 50, // Very small
        maxFiles: 3, // Keeps .1 and .2 (plus current = 3 total)
        enabled: true,
        minLevel: 'info',
      });

      // Write many messages to trigger multiple rotations
      for (let i = 0; i < 100; i++) {
        info(`Message ${i} - padding to make it longer for rotation testing`);
      }

      // Should have rotated files
      assert.ok(fs.existsSync(`${TEST_LOG_PATH}.1`), 'Should have .1 file');
      assert.ok(fs.existsSync(`${TEST_LOG_PATH}.2`), 'Should have .2 file');
      // .3 should not exist (maxFiles=3 means current + .1 + .2)
      assert.ok(!fs.existsSync(`${TEST_LOG_PATH}.3`), 'Should not have .3 file');
    });
  });

  describe('readRecentLogs', () => {
    it('should return empty array for non-existent log', () => {
      configureLogger({ logPath: path.join(TEST_DIR, 'nonexistent.log') });
      const logs = readRecentLogs(10);
      assert.deepStrictEqual(logs, []);
    });

    it('should return last N lines', () => {
      configureLogger({ logPath: TEST_LOG_PATH, enabled: true, minLevel: 'info' });

      for (let i = 1; i <= 10; i++) {
        info(`Message ${i}`);
      }

      const logs = readRecentLogs(3);
      assert.strictEqual(logs.length, 3);
      assert.ok(logs[0].includes('Message 8'));
      assert.ok(logs[1].includes('Message 9'));
      assert.ok(logs[2].includes('Message 10'));
    });

    it('should return all lines if less than requested', () => {
      configureLogger({ logPath: TEST_LOG_PATH, enabled: true, minLevel: 'info' });

      info('Only message');

      const logs = readRecentLogs(100);
      assert.strictEqual(logs.length, 1);
    });

    it('should return exact count at boundary (slice boundary verification)', () => {
      configureLogger({ logPath: TEST_LOG_PATH, enabled: true, minLevel: 'info' });

      // Write exactly 5 messages
      for (let i = 1; i <= 5; i++) {
        info(`Boundary message ${i}`);
      }

      // Request exactly 5 - should return all 5
      const exactLogs = readRecentLogs(5);
      assert.strictEqual(exactLogs.length, 5, 'Should return exactly 5 when requesting 5');
      assert.ok(exactLogs[0].includes('Boundary message 1'));
      assert.ok(exactLogs[4].includes('Boundary message 5'));

      // Request 6 (more than exist) - should still return 5
      const moreLogs = readRecentLogs(6);
      assert.strictEqual(moreLogs.length, 5, 'Should return all 5 when requesting 6');

      // Request 4 (less than exist) - should return last 4
      const lessLogs = readRecentLogs(4);
      assert.strictEqual(lessLogs.length, 4, 'Should return 4 when requesting 4');
      assert.ok(lessLogs[0].includes('Boundary message 2'), 'First should be message 2');
      assert.ok(lessLogs[3].includes('Boundary message 5'), 'Last should be message 5');
    });

    it('should handle zero lines requested', () => {
      configureLogger({ logPath: TEST_LOG_PATH, enabled: true, minLevel: 'info' });

      info('Test message');

      // Request 0 lines - should return empty array
      const logs = readRecentLogs(0);
      assert.strictEqual(logs.length, 0, 'Should return empty array for 0 lines');
    });
  });

  describe('getLogStats', () => {
    it('should report stats for existing log', () => {
      configureLogger({ logPath: TEST_LOG_PATH, enabled: true, minLevel: 'info' });

      info('First message');
      info('Second message');
      info('Third message');

      const stats = getLogStats();
      assert.strictEqual(stats.exists, true);
      assert.strictEqual(stats.lineCount, 3);
      assert.ok(stats.sizeBytes > 0);
      assert.ok(stats.oldestEntry !== null);
      assert.ok(stats.newestEntry !== null);
    });

    it('should report not exists for missing log', () => {
      configureLogger({ logPath: path.join(TEST_DIR, 'missing.log') });

      const stats = getLogStats();
      assert.strictEqual(stats.exists, false);
      assert.strictEqual(stats.lineCount, 0);
      assert.strictEqual(stats.sizeBytes, 0);
    });

    it('should count rotated files', () => {
      configureLogger({
        logPath: TEST_LOG_PATH,
        maxFileSize: 50,
        maxFiles: 3,
        enabled: true,
        minLevel: 'info',
      });

      // Write enough to trigger rotation
      for (let i = 0; i < 50; i++) {
        info(`Message ${i} with extra padding for size`);
      }

      const stats = getLogStats();
      assert.ok(stats.rotatedFiles >= 1, 'Should have at least one rotated file');
    });

    it('issue f34180fe: reports readError and resets line stats when the log path exists but is unreadable', () => {
      // A directory in place of a file: existsSync/statSync succeed (so
      // sizeBytes is trustworthy), but readFileSync throws EISDIR.
      const dirLogPath = path.join(TEST_DIR, 'log-as-directory.log');
      fs.mkdirSync(dirLogPath, { recursive: true });
      configureLogger({ logPath: dirLogPath, enabled: true, minLevel: 'info' });

      const stats = getLogStats();
      assert.strictEqual(stats.exists, true, 'statSync succeeded, so exists must be true');
      assert.ok(stats.readError && stats.readError.length > 0, 'readError should be a non-empty message');
      assert.strictEqual(stats.lineCount, 0, 'lineCount must reset to the unknown value on read failure');
      assert.strictEqual(stats.oldestEntry, null);
      assert.strictEqual(stats.newestEntry, null);
    });
  });

  describe('logMetricsCapture', () => {
    it('should log metrics capture event', () => {
      configureLogger({ logPath: TEST_LOG_PATH, enabled: true, minLevel: 'info' });

      logMetricsCapture(
        'agent123',
        'session-uuid-12345678',
        {
          model: 'claude-sonnet-4-5-20250929',
          duration_ms: 5000,
          tokens: {
            input: 1000,
            output: 500,
            cache_creation: 2000,
            cache_read: 3000,
            total_effective: 3500,
            total_raw: 6500,
          },
          execution: {
            message_count: 10,
            tool_use_count: 5,
            error_count: 0,
            tool_breakdown: {},
          },
        },
        {
          agentName: 'code-validator',
          projectPath: '/home/user/project',
          source: 'hook',
        }
      );

      const logs = readRecentLogs(1);
      assert.strictEqual(logs.length, 1);
      assert.ok(logs[0].includes('Metrics captured'));
      assert.ok(logs[0].includes('agent123'));
      assert.ok(logs[0].includes('code-validator'));
    });

    it('should truncate session ID', () => {
      logMetricsCapture('agent123', 'very-long-session-id-that-should-be-truncated', {} as Pick<import('./types.js').AgentMetrics, 'model' | 'duration_ms' | 'tokens' | 'execution'>);

      const logs = readRecentLogs(1);
      assert.ok(logs[0].includes('very-long-se...'));
    });
  });

  describe('logBufferOperation', () => {
    it('should log buffer operations at debug level', () => {
      configureLogger({ logPath: TEST_LOG_PATH, enabled: true, minLevel: 'debug' });

      logBufferOperation('append', { agent_id: 'abc123', count: 1 });

      const logs = readRecentLogs(1);
      assert.strictEqual(logs.length, 1);
      assert.ok(logs[0].includes('DEBUG'));
      assert.ok(logs[0].includes('Buffer append'));
    });

    it('should not log buffer operations when minLevel is info', () => {
      configureLogger({ logPath: TEST_LOG_PATH, enabled: true, minLevel: 'info' });

      logBufferOperation('query', { count: 5 });

      const logs = readRecentLogs(10);
      assert.strictEqual(logs.length, 0);
    });
  });

  describe('Directory Creation', () => {
    it('should create log directory if it does not exist', () => {
      const nestedPath = path.join(TEST_DIR, 'nested', 'dir', 'test.log');
      configureLogger({ logPath: nestedPath, enabled: true, minLevel: 'info' });

      info('Test message');

      assert.ok(fs.existsSync(nestedPath), 'Log file should be created');
      assert.ok(fs.existsSync(path.dirname(nestedPath)), 'Directory should be created');
    });
  });
});
