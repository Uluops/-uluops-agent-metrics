/**
 * Buffer Module Tests
 *
 * Tests for the agent metrics buffer including concurrent access safety.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  annotateBufferEntries,
  appendToBuffer,
  readBuffer,
  readValidEntries,
  queryBuffer,
  getLatestForSession,
  getAllForSession,
  cleanupExpired,
  clearSession,
  clearAgents,
  getBufferStats,
  entriesToTrackerFormat,
  type BufferConfig,
  type BufferEntry,
} from './buffer.js';
import { configureLogger } from './logger.js';
import { createTestMetrics, TEST_TTL_MS } from './test-utils.js';

// Test configuration with isolated temp directory
const TEST_DIR = path.join(os.tmpdir(), 'agent-metrics-test-' + Date.now());
const TEST_CONFIG: BufferConfig = {
  bufferPath: path.join(TEST_DIR, 'test-buffer.jsonl'),
  defaultTTL: TEST_TTL_MS,
};

// Fast lock config for testing lock timeout behavior without slow tests
const TEST_CONFIG_FAST_LOCK: BufferConfig = {
  ...TEST_CONFIG,
  lockTimeoutMs: 100, // 100ms timeout for faster lock timeout tests
};

/**
 * Write an entry directly to the buffer file, bypassing appendToBuffer.
 * appendToBuffer GC's expired entries opportunistically (v0.7.0), so tests
 * that need already-expired entries present must set them up out-of-band.
 */
function writeRawEntry(
  metrics: ReturnType<typeof createTestMetrics>,
  ttlMs: number,
  config: BufferConfig = TEST_CONFIG,
): BufferEntry {
  const now = new Date();
  const entry: BufferEntry = {
    agent_id: metrics.agent_id,
    session_id: metrics.session_id,
    captured_at: now.toISOString(),
    end_time: metrics.end_time,
    expires_at: new Date(now.getTime() + ttlMs).toISOString(),
    metrics,
  };
  fs.appendFileSync(config.bufferPath, JSON.stringify(entry) + '\n');
  return entry;
}

describe('Buffer Module', () => {
  before(() => {
    // Disable logging during tests to prevent log pollution
    configureLogger({ enabled: false });
    // Create test directory
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  after(() => {
    // Cleanup test directory
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    // Re-enable logging
    configureLogger({ enabled: true });
  });

  beforeEach(() => {
    // Clear buffer before each test
    try {
      fs.unlinkSync(TEST_CONFIG.bufferPath);
    } catch {
      // File doesn't exist, that's fine
    }
    try {
      fs.unlinkSync(TEST_CONFIG.bufferPath + '.lock');
    } catch {
      // Lock file doesn't exist, that's fine
    }
  });

  describe('appendToBuffer', () => {
    it('should append metrics to buffer file', () => {
      const metrics = createTestMetrics();
      const entry = appendToBuffer(metrics, { config: TEST_CONFIG });

      assert.ok(entry, 'entry should be written when the lock is free');
      assert.strictEqual(entry.agent_id, metrics.agent_id);
      assert.strictEqual(entry.session_id, metrics.session_id);
      assert.ok(entry.captured_at);
      assert.ok(entry.expires_at);

      // Verify file was created and contains the entry
      const content = fs.readFileSync(TEST_CONFIG.bufferPath, 'utf-8');
      const parsed = JSON.parse(content.trim());
      assert.strictEqual(parsed.agent_id, metrics.agent_id);
    });

    it('should append multiple entries to same file', () => {
      const metrics1 = createTestMetrics({ agent_id: 'first-append-agent' });
      const metrics2 = createTestMetrics({ agent_id: 'second-append-agent' });

      appendToBuffer(metrics1, { config: TEST_CONFIG });
      appendToBuffer(metrics2, { config: TEST_CONFIG });

      const entries = readBuffer(TEST_CONFIG);
      assert.strictEqual(entries.length, 2);
      assert.strictEqual(entries[0].agent_id, 'first-append-agent');
      assert.strictEqual(entries[1].agent_id, 'second-append-agent');
    });

    it('should include optional metadata', () => {
      const metrics = createTestMetrics();
      const entry = appendToBuffer(metrics, {
        agentName: 'code-validator',
        projectPath: '/path/to/project',
        config: TEST_CONFIG,
      });

      assert.ok(entry, 'entry should be written when the lock is free');
      assert.strictEqual(entry.agent_name, 'code-validator');
      assert.strictEqual(entry.project_path, '/path/to/project');
    });

    it('should respect custom TTL', () => {
      const metrics = createTestMetrics();
      const shortTTL = 1000; // 1 second
      const entry = appendToBuffer(metrics, { ttlMs: shortTTL, config: TEST_CONFIG });

      assert.ok(entry, 'entry should be written when the lock is free');
      const capturedAt = new Date(entry.captured_at).getTime();
      const expiresAt = new Date(entry.expires_at).getTime();
      assert.strictEqual(expiresAt - capturedAt, shortTTL);
    });
  });

  describe('readBuffer', () => {
    it('should return empty array for non-existent file', () => {
      const entries = readBuffer(TEST_CONFIG);
      assert.deepStrictEqual(entries, []);
    });

    it('should read all entries including expired', () => {
      const expiredMetrics = createTestMetrics({ agent_id: 'expired-read-agent' });
      const validMetrics = createTestMetrics({ agent_id: 'valid-read-agent' });

      // Valid entry first — appendToBuffer GC's expired entries, so the
      // expired one is written raw afterwards.
      appendToBuffer(validMetrics, { config: TEST_CONFIG });
      writeRawEntry(expiredMetrics, -1000);

      const entries = readBuffer(TEST_CONFIG);
      assert.strictEqual(entries.length, 2);
    });

    it('should skip malformed lines and log warning', () => {
      // Write a valid entry first
      const metrics = createTestMetrics();
      appendToBuffer(metrics, { config: TEST_CONFIG });

      // Manually append malformed line
      fs.appendFileSync(TEST_CONFIG.bufferPath, 'not valid json\n');

      // Write another valid entry
      const validMetrics = createTestMetrics({ agent_id: 'valid-after-malformed' });
      appendToBuffer(validMetrics, { config: TEST_CONFIG });

      const entries = readBuffer(TEST_CONFIG);
      assert.strictEqual(entries.length, 2);
    });

    it('should skip entries with missing required fields', () => {
      // Write a valid entry first
      const metrics = createTestMetrics();
      appendToBuffer(metrics, { config: TEST_CONFIG });

      // Manually append valid JSON but missing required fields
      fs.appendFileSync(TEST_CONFIG.bufferPath, '{"foo": "bar"}\n');
      fs.appendFileSync(TEST_CONFIG.bufferPath, '{"agent_id": "test"}\n'); // Missing other fields

      // Write another valid entry
      const validMetrics = createTestMetrics({ agent_id: 'valid-after-incomplete' });
      appendToBuffer(validMetrics, { config: TEST_CONFIG });

      const entries = readBuffer(TEST_CONFIG);
      // Should skip the two invalid entries, keeping only the 2 valid ones
      assert.strictEqual(entries.length, 2);
      assert.strictEqual(entries[0].agent_id, metrics.agent_id);
      assert.strictEqual(entries[1].agent_id, 'valid-after-incomplete');
    });

    it('F5: should skip an entry whose metrics has no tokens', () => {
      const metrics = createTestMetrics();
      appendToBuffer(metrics, { config: TEST_CONFIG });

      // metrics present but no `tokens` — passed the old validator, then crashed
      // consumers (entriesToTrackerFormat) that dereference metrics.tokens.*.
      fs.appendFileSync(
        TEST_CONFIG.bufferPath,
        '{"agent_id":"no-tokens","session_id":"s","captured_at":"2026-01-01T00:00:00Z","expires_at":"2026-01-01T00:00:00Z","metrics":{"model":"x"}}\n',
      );

      const entries = readBuffer(TEST_CONFIG);
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].agent_id, metrics.agent_id);
    });
  });

  describe('entriesToTrackerFormat', () => {
    it('F5: skips entries missing metrics.tokens instead of throwing (one bad entry must not crash the batch)', () => {
      const good = {
        agent_id: 'g', session_id: 's', captured_at: 't', end_time: 't', expires_at: 't',
        metrics: createTestMetrics({ agent_id: 'g' }),
      };
      const bad = {
        agent_id: 'b', session_id: 's', captured_at: 't', end_time: 't', expires_at: 't',
        metrics: { model: 'x' },
      } as unknown as BufferEntry;

      const result = entriesToTrackerFormat([good, bad]);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].harness, 'claude-code');
    });
  });

  describe('readValidEntries', () => {
    it('should filter out expired entries', () => {
      const metrics1 = createTestMetrics({ agent_id: 'expired-agent' });
      const metrics2 = createTestMetrics({ agent_id: 'valid-agent' });

      // Add expired entry (TTL in the past)
      appendToBuffer(metrics1, { ttlMs: -1000, config: TEST_CONFIG });
      // Add valid entry
      appendToBuffer(metrics2, { config: TEST_CONFIG });

      const entries = readValidEntries(TEST_CONFIG);
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].agent_id, 'valid-agent');
    });
  });

  describe('queryBuffer', () => {
    it('should filter by session ID', () => {
      const sessionA = 'session-a';
      const sessionB = 'session-b';

      appendToBuffer(createTestMetrics({ session_id: sessionA }), { config: TEST_CONFIG });
      appendToBuffer(createTestMetrics({ session_id: sessionA }), { config: TEST_CONFIG });
      appendToBuffer(createTestMetrics({ session_id: sessionB }), { config: TEST_CONFIG });

      const entries = queryBuffer({ sessionId: sessionA }, TEST_CONFIG);
      assert.strictEqual(entries.length, 2);
      entries.forEach((e) => assert.strictEqual(e.session_id, sessionA));
    });

    it('should filter by agent name', () => {
      appendToBuffer(createTestMetrics(), { agentName: 'code-validator', config: TEST_CONFIG });
      appendToBuffer(createTestMetrics(), { agentName: 'test-architect', config: TEST_CONFIG });
      appendToBuffer(createTestMetrics(), { agentName: 'code-validator', config: TEST_CONFIG });

      const entries = queryBuffer({ agentName: 'code-validator' }, TEST_CONFIG);
      assert.strictEqual(entries.length, 2);
    });

    it('should include expired entries when requested', () => {
      appendToBuffer(createTestMetrics(), { config: TEST_CONFIG });
      writeRawEntry(createTestMetrics(), -1000);

      const withExpired = queryBuffer({ includeExpired: true }, TEST_CONFIG);
      const withoutExpired = queryBuffer({ includeExpired: false }, TEST_CONFIG);

      assert.strictEqual(withExpired.length, 2);
      assert.strictEqual(withoutExpired.length, 1);
    });

    it('should treat TTL=0 entries as immediately expired', () => {
      writeRawEntry(createTestMetrics(), 0);

      const withExpired = queryBuffer({ includeExpired: true }, TEST_CONFIG);
      const withoutExpired = queryBuffer({ includeExpired: false }, TEST_CONFIG);

      assert.strictEqual(withExpired.length, 1, 'Should exist in buffer');
      assert.strictEqual(withoutExpired.length, 0, 'Should be expired with TTL=0');
    });
  });

  describe('getLatestForSession', () => {
    it('should return most recent entry for session', async () => {
      const sessionId = 'test-session';

      appendToBuffer(createTestMetrics({ session_id: sessionId, agent_id: 'first' }), { config: TEST_CONFIG });
      // Small delay to ensure different timestamps
      await new Promise((r) => setTimeout(r, 10));
      appendToBuffer(createTestMetrics({ session_id: sessionId, agent_id: 'second' }), { config: TEST_CONFIG });

      const latest = getLatestForSession(sessionId, TEST_CONFIG);
      assert.ok(latest);
      assert.strictEqual(latest.agent_id, 'second');
    });

    it('should return null for non-existent session', () => {
      const latest = getLatestForSession('non-existent', TEST_CONFIG);
      assert.strictEqual(latest, null);
    });
  });

  describe('getAllForSession', () => {
    it('should return all entries for session sorted by time', async () => {
      const sessionId = 'test-session';

      appendToBuffer(createTestMetrics({ session_id: sessionId, agent_id: 'first' }), { config: TEST_CONFIG });
      await new Promise((r) => setTimeout(r, 10));
      appendToBuffer(createTestMetrics({ session_id: sessionId, agent_id: 'second' }), { config: TEST_CONFIG });

      const all = getAllForSession(sessionId, TEST_CONFIG);
      assert.strictEqual(all.length, 2);
      assert.strictEqual(all[0].agent_id, 'first');
      assert.strictEqual(all[1].agent_id, 'second');
    });
  });

  describe('cleanupExpired', () => {
    it('should remove expired entries and return count', () => {
      appendToBuffer(createTestMetrics(), { config: TEST_CONFIG });
      writeRawEntry(createTestMetrics(), -1000);
      writeRawEntry(createTestMetrics(), -1000);

      const removedCount = cleanupExpired(TEST_CONFIG);
      assert.strictEqual(removedCount, 2);

      const remaining = readBuffer(TEST_CONFIG);
      assert.strictEqual(remaining.length, 1);
    });

    it('should run opportunistically on append', () => {
      appendToBuffer(createTestMetrics({ agent_id: 'gc-valid-1' }), { config: TEST_CONFIG });
      writeRawEntry(createTestMetrics({ agent_id: 'gc-expired' }), -1000);

      // The next append should GC the expired entry
      appendToBuffer(createTestMetrics({ agent_id: 'gc-valid-2' }), { config: TEST_CONFIG });

      const entries = readBuffer(TEST_CONFIG);
      assert.strictEqual(entries.length, 2);
      assert.ok(!entries.some((e) => e.agent_id === 'gc-expired'), 'expired entry should be GC\'d by append');
    });
  });

  describe('annotateBufferEntries', () => {
    it('should write names onto matching entries and return count', () => {
      appendToBuffer(createTestMetrics({ agent_id: 'annotate-1' }), { config: TEST_CONFIG });
      appendToBuffer(createTestMetrics({ agent_id: 'annotate-2' }), { config: TEST_CONFIG });
      appendToBuffer(createTestMetrics({ agent_id: 'annotate-3' }), { agentName: 'already-named', config: TEST_CONFIG });

      const updated = annotateBufferEntries(
        { 'annotate-1': 'code-validator', 'annotate-2': 'test-architect', 'no-such-id': 'ghost' },
        TEST_CONFIG,
      );

      assert.strictEqual(updated, 2);
      const entries = readBuffer(TEST_CONFIG);
      assert.strictEqual(entries.find((e) => e.agent_id === 'annotate-1')?.agent_name, 'code-validator');
      assert.strictEqual(entries.find((e) => e.agent_id === 'annotate-2')?.agent_name, 'test-architect');
      assert.strictEqual(entries.find((e) => e.agent_id === 'annotate-3')?.agent_name, 'already-named');
    });

    it('should overwrite existing names (caller-supplied is authoritative)', () => {
      appendToBuffer(createTestMetrics({ agent_id: 'annotate-ow' }), { agentName: 'stale-name', config: TEST_CONFIG });

      const updated = annotateBufferEntries({ 'annotate-ow': 'fresh-name' }, TEST_CONFIG);

      assert.strictEqual(updated, 1);
      assert.strictEqual(readBuffer(TEST_CONFIG)[0]?.agent_name, 'fresh-name');
    });

    it('should be a no-op when names already match', () => {
      appendToBuffer(createTestMetrics({ agent_id: 'annotate-same' }), { agentName: 'same-name', config: TEST_CONFIG });

      const updated = annotateBufferEntries({ 'annotate-same': 'same-name' }, TEST_CONFIG);
      assert.strictEqual(updated, 0);
    });
  });

  describe('clearSession', () => {
    it('should remove all entries for a session', () => {
      const sessionToRemove = 'session-remove';
      const sessionToKeep = 'session-keep';

      appendToBuffer(createTestMetrics({ session_id: sessionToRemove }), { config: TEST_CONFIG });
      appendToBuffer(createTestMetrics({ session_id: sessionToRemove }), { config: TEST_CONFIG });
      appendToBuffer(createTestMetrics({ session_id: sessionToKeep }), { config: TEST_CONFIG });

      const removedCount = clearSession(sessionToRemove, TEST_CONFIG);
      assert.strictEqual(removedCount, 2);

      const remaining = readBuffer(TEST_CONFIG);
      assert.strictEqual(remaining.length, 1);
      assert.strictEqual(remaining[0].session_id, sessionToKeep);
    });
  });

  describe('clearAgents', () => {
    it('should remove entries for specific agent IDs', () => {
      appendToBuffer(createTestMetrics({ agent_id: 'agent-to-clear-first' }), { config: TEST_CONFIG });
      appendToBuffer(createTestMetrics({ agent_id: 'agent-to-keep' }), { config: TEST_CONFIG });
      appendToBuffer(createTestMetrics({ agent_id: 'agent-to-clear-second' }), { config: TEST_CONFIG });

      const removedCount = clearAgents(['agent-to-clear-first', 'agent-to-clear-second'], TEST_CONFIG);
      assert.strictEqual(removedCount, 2);

      const remaining = readBuffer(TEST_CONFIG);
      assert.strictEqual(remaining.length, 1);
      assert.strictEqual(remaining[0].agent_id, 'agent-to-keep');
    });
  });

  describe('Atomic rewrite (crash-safety)', () => {
    it('rewrites the buffer via temp+rename, leaving surviving entries intact and no .tmp behind', () => {
      appendToBuffer(createTestMetrics({ agent_id: 'keep-1', session_id: 's-keep' }), { config: TEST_CONFIG });
      appendToBuffer(createTestMetrics({ agent_id: 'drop-1', session_id: 's-drop' }), { config: TEST_CONFIG });
      appendToBuffer(createTestMetrics({ agent_id: 'keep-2', session_id: 's-keep' }), { config: TEST_CONFIG });

      const removed = clearSession('s-drop', TEST_CONFIG);
      assert.strictEqual(removed, 1);

      // Surviving entries are intact and uncorrupted.
      const remaining = readBuffer(TEST_CONFIG);
      assert.strictEqual(remaining.length, 2);
      assert.deepStrictEqual(
        remaining.map((e) => e.agent_id).sort(),
        ['keep-1', 'keep-2'],
      );

      // The sibling temp file must not linger after the atomic rename.
      assert.ok(!fs.existsSync(TEST_CONFIG.bufferPath + '.tmp'), 'No .tmp file should remain after rewrite');
    });
  });

  describe('getBufferStats', () => {
    it('should return accurate statistics', () => {
      appendToBuffer(createTestMetrics({ agent_id: 'stats-agent-valid-1', session_id: 'stats-session-active' }), { config: TEST_CONFIG });
      appendToBuffer(createTestMetrics({ agent_id: 'stats-agent-valid-2', session_id: 'stats-session-active' }), { config: TEST_CONFIG });
      writeRawEntry(createTestMetrics({ agent_id: 'stats-agent-expired', session_id: 'stats-session-expired' }), -1000);

      const stats = getBufferStats(TEST_CONFIG);

      assert.strictEqual(stats.totalEntries, 3);
      assert.strictEqual(stats.validEntries, 2);
      assert.strictEqual(stats.expiredEntries, 1);
      assert.strictEqual(stats.uniqueSessions, 2);
      assert.strictEqual(stats.uniqueAgents, 3);
      assert.ok(stats.oldestEntry);
      assert.ok(stats.newestEntry);
      assert.ok(stats.bufferSizeBytes > 0);
    });

    it('should handle empty buffer', () => {
      const stats = getBufferStats(TEST_CONFIG);

      assert.strictEqual(stats.totalEntries, 0);
      assert.strictEqual(stats.validEntries, 0);
      assert.strictEqual(stats.uniqueSessions, 0);
      assert.strictEqual(stats.oldestEntry, null);
      assert.strictEqual(stats.newestEntry, null);
    });
  });

  describe('Concurrent Access', () => {
    it('should handle concurrent writes without corruption', async () => {
      const writeCount = 20;
      const promises: Promise<void>[] = [];

      // Simulate concurrent writes using microtask queue for deterministic concurrency
      for (let i = 0; i < writeCount; i++) {
        promises.push(
          Promise.resolve().then(() => {
            appendToBuffer(createTestMetrics({ agent_id: `concurrent-${i}` }), { config: TEST_CONFIG });
          })
        );
      }

      await Promise.all(promises);

      // Verify all entries were written without corruption
      const entries = readBuffer(TEST_CONFIG);
      assert.strictEqual(entries.length, writeCount);

      // Verify each entry is valid JSON (no corruption)
      const agentIds = new Set(entries.map((e) => e.agent_id));
      assert.strictEqual(agentIds.size, writeCount);
    });
  });

  describe('Lock Acquisition Edge Cases', () => {
    it('should fail closed (skip + warn) when lock cannot be acquired', () => {
      // Create a lock file that will block acquisition
      const lockPath = TEST_CONFIG_FAST_LOCK.bufferPath + '.lock';
      fs.writeFileSync(lockPath, String(process.pid));

      // Capture stderr output
      const originalWrite = process.stderr.write;
      let warningLogged = false;
      process.stderr.write = ((msg: string | Uint8Array) => {
        if (typeof msg === 'string' && msg.includes('Warning') && msg.includes('lock')) {
          warningLogged = true;
        }
        return true;
      }) as typeof process.stderr.write;

      try {
        // Uses TEST_CONFIG_FAST_LOCK with 100ms timeout for fast testing.
        // The lock is fresh (not stale), so it won't be removed; acquisition
        // times out and appendToBuffer fails closed — it skips the write rather
        // than racing an unlocked append that could corrupt the buffer.
        const metrics = createTestMetrics();
        const result = appendToBuffer(metrics, { config: TEST_CONFIG_FAST_LOCK });

        // Entry should NOT be written, and the call returns null to signal the skip.
        assert.strictEqual(result, null, 'Should return null when the append is skipped');
        const entries = readBuffer(TEST_CONFIG_FAST_LOCK);
        assert.strictEqual(entries.length, 0, 'Entry should be skipped, not raced, under lock contention');
        assert.ok(warningLogged, 'Should log a warning about lock acquisition failure');
      } finally {
        process.stderr.write = originalWrite;
        try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
      }
    });

    it('should remove stale lock older than 30 seconds', () => {
      const lockPath = TEST_CONFIG.bufferPath + '.lock';

      // Create a lock file with old mtime
      fs.writeFileSync(lockPath, '12345');

      // Set mtime to 31 seconds ago
      const oldTime = new Date(Date.now() - 31000);
      fs.utimesSync(lockPath, oldTime, oldTime);

      // Now try to write - should succeed because stale lock is removed
      const metrics = createTestMetrics();
      appendToBuffer(metrics, { config: TEST_CONFIG });

      // Verify entry was written
      const entries = readBuffer(TEST_CONFIG);
      assert.strictEqual(entries.length, 1, 'Should write after removing stale lock');

      // Lock file should be gone or be our new lock
      // (it gets released after write)
    });

    it('should NOT remove lock that is less than 30 seconds old', () => {
      const lockPath = TEST_CONFIG_FAST_LOCK.bufferPath + '.lock';

      // Create a fresh lock file
      fs.writeFileSync(lockPath, '99999');

      // Set mtime to 29 seconds ago (just under threshold)
      const recentTime = new Date(Date.now() - 29000);
      fs.utimesSync(lockPath, recentTime, recentTime);

      // Capture stderr output
      const originalWrite = process.stderr.write;
      let warningLogged = false;
      process.stderr.write = ((msg: string | Uint8Array) => {
        if (typeof msg === 'string' && msg.includes('Warning')) warningLogged = true;
        return true;
      }) as typeof process.stderr.write;

      try {
        // Uses TEST_CONFIG_FAST_LOCK with 100ms timeout for fast testing.
        // A 29s-old lock is under the 30s stale threshold, so it is NOT removed;
        // acquisition times out and appendToBuffer fails closed (skips the write).
        const metrics = createTestMetrics();
        const result = appendToBuffer(metrics, { config: TEST_CONFIG_FAST_LOCK });

        // Entry should be skipped because the sub-threshold lock was not removed.
        assert.strictEqual(result, null, 'Should return null when the append is skipped');
        const entries = readBuffer(TEST_CONFIG_FAST_LOCK);
        assert.strictEqual(entries.length, 0, 'Entry should be skipped (lock not stale → not removed)');
        assert.ok(warningLogged, 'Should warn about lock acquisition failure');
      } finally {
        process.stderr.write = originalWrite;
        try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
      }
    });
  });

  describe('Malformed JSONL Edge Cases', () => {
    it('should handle partial JSON (truncated mid-object)', () => {
      const metrics = createTestMetrics();
      appendToBuffer(metrics, { config: TEST_CONFIG });

      // Append truncated JSON (e.g., process killed mid-write)
      fs.appendFileSync(TEST_CONFIG.bufferPath, '{"agent_id":"trunc","session_id":"s1","captured_at":"2026-01\n');

      const entries = readBuffer(TEST_CONFIG);
      assert.strictEqual(entries.length, 1, 'Should skip truncated JSON and keep valid entry');
      assert.strictEqual(entries[0].agent_id, metrics.agent_id);
    });

    it('should handle lines with only whitespace characters', () => {
      const metrics = createTestMetrics();
      appendToBuffer(metrics, { config: TEST_CONFIG });

      // Append lines with various whitespace
      fs.appendFileSync(TEST_CONFIG.bufferPath, '   \n\t\t\n  \t \n');

      const entries = readBuffer(TEST_CONFIG);
      assert.strictEqual(entries.length, 1, 'Should skip whitespace-only lines');
    });

    it('should handle valid JSON that is not a buffer entry (array)', () => {
      const metrics = createTestMetrics();
      appendToBuffer(metrics, { config: TEST_CONFIG });

      // Append valid JSON but wrong type (array instead of object)
      fs.appendFileSync(TEST_CONFIG.bufferPath, '[1, 2, 3]\n');

      const entries = readBuffer(TEST_CONFIG);
      assert.strictEqual(entries.length, 1, 'Should skip non-object JSON');
    });

    it('should handle valid JSON with null value', () => {
      const metrics = createTestMetrics();
      appendToBuffer(metrics, { config: TEST_CONFIG });

      fs.appendFileSync(TEST_CONFIG.bufferPath, 'null\n');

      const entries = readBuffer(TEST_CONFIG);
      assert.strictEqual(entries.length, 1, 'Should skip null JSON');
    });

    it('should handle empty string between valid entries', () => {
      appendToBuffer(createTestMetrics({ agent_id: 'before-empty' }), { config: TEST_CONFIG });
      fs.appendFileSync(TEST_CONFIG.bufferPath, '\n\n\n');
      appendToBuffer(createTestMetrics({ agent_id: 'after-empty' }), { config: TEST_CONFIG });

      const entries = readBuffer(TEST_CONFIG);
      assert.strictEqual(entries.length, 2);
      assert.strictEqual(entries[0].agent_id, 'before-empty');
      assert.strictEqual(entries[1].agent_id, 'after-empty');
    });
  });

  describe('Error Boundary Conditions', () => {
    it('should handle read-only buffer file gracefully on append', () => {
      // Create buffer file first
      const metrics = createTestMetrics();
      appendToBuffer(metrics, { config: TEST_CONFIG });

      // Make it read-only
      fs.chmodSync(TEST_CONFIG.bufferPath, 0o444);

      try {
        assert.throws(
          () => appendToBuffer(createTestMetrics(), { config: TEST_CONFIG }),
          /EACCES|permission denied/i
        );
      } finally {
        // Restore permissions for cleanup
        fs.chmodSync(TEST_CONFIG.bufferPath, 0o644);
      }
    });

    it('should handle non-existent parent directory for buffer stats', () => {
      const badConfig: BufferConfig = {
        bufferPath: path.join(TEST_DIR, 'nonexistent', 'deep', 'buffer.jsonl'),
        defaultTTL: TEST_TTL_MS,
      };

      const stats = getBufferStats(badConfig);
      assert.strictEqual(stats.totalEntries, 0);
      assert.strictEqual(stats.bufferSizeBytes, 0);
      assert.strictEqual(stats.oldestEntry, null);
    });

    it('should return 0 for cleanupExpired on non-existent buffer', () => {
      const badConfig: BufferConfig = {
        bufferPath: path.join(TEST_DIR, 'no-such-file.jsonl'),
        defaultTTL: TEST_TTL_MS,
      };

      const removed = cleanupExpired(badConfig);
      assert.strictEqual(removed, 0);
    });

    it('should return 0 for clearSession on non-existent buffer', () => {
      const badConfig: BufferConfig = {
        bufferPath: path.join(TEST_DIR, 'no-such-file.jsonl'),
        defaultTTL: TEST_TTL_MS,
      };

      const removed = clearSession('any-session', badConfig);
      assert.strictEqual(removed, 0);
    });
  });

  describe('Expiry Boundary Conditions', () => {
    it('should consider entry expired at exact boundary', () => {
      // Capture time before and after to account for execution time
      const beforeCreate = Date.now();
      const metrics = createTestMetrics();
      const entry = appendToBuffer(metrics, { ttlMs: 0, config: TEST_CONFIG });
      const afterCreate = Date.now();

      assert.ok(entry, 'entry should be written when the lock is free');
      // Entry expires_at should be between beforeCreate and afterCreate
      const expiresAt = new Date(entry.expires_at).getTime();

      assert.ok(
        expiresAt >= beforeCreate && expiresAt <= afterCreate,
        `Expiry (${expiresAt}) should be between ${beforeCreate} and ${afterCreate}`
      );

      // Should be filtered out as expired (or just barely valid)
      // The implementation uses '>' so entry at exact boundary IS expired
      const validEntries = readValidEntries(TEST_CONFIG);
      // With 0 TTL, entry should be expired immediately
      assert.strictEqual(validEntries.length, 0, 'Entry with TTL=0 should be expired immediately');
    });

    it('should keep entry that expires 1ms in future', async () => {
      const metrics = createTestMetrics();
      appendToBuffer(metrics, { ttlMs: 100, config: TEST_CONFIG });

      // Should be valid immediately
      const validEntries = readValidEntries(TEST_CONFIG);
      assert.strictEqual(validEntries.length, 1, 'Entry should be valid before expiry');

      // Wait for expiry
      await new Promise((r) => setTimeout(r, 150));

      // Should now be expired
      const afterExpiry = readValidEntries(TEST_CONFIG);
      assert.strictEqual(afterExpiry.length, 0, 'Entry should be expired after TTL');
    });

    it('should handle negative TTL as already expired', () => {
      const metrics = createTestMetrics();
      writeRawEntry(metrics, -1000);

      const validEntries = readValidEntries(TEST_CONFIG);
      assert.strictEqual(validEntries.length, 0, 'Negative TTL should create expired entry');

      const allEntries = readBuffer(TEST_CONFIG);
      assert.strictEqual(allEntries.length, 1, 'Entry should exist in raw buffer');
    });
  });

  describe('entriesToTrackerFormat', () => {
    it('should map token fields correctly', () => {
      const metrics = createTestMetrics({
        model: 'claude-sonnet-4-5',
        duration_ms: 5000,
        tokens: {
          input: 100,
          output: 200,
          cache_creation: 300,
          cache_read: 400,
          total_effective: 600,
          total_raw: 1000,
        },
      });
      const entry = appendToBuffer(metrics, {
        agentName: 'code-validator',
        config: TEST_CONFIG,
      });

      assert.ok(entry, 'entry should be written when the lock is free');
      const result = entriesToTrackerFormat([entry]);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].name, 'code-validator');
      assert.strictEqual(result[0].model, 'claude-sonnet-4-5');
      assert.strictEqual(result[0].duration_ms, 5000);
      assert.strictEqual(result[0].tokens.input_tokens, 100);
      assert.strictEqual(result[0].tokens.output_tokens, 200);
      assert.strictEqual(result[0].tokens.cache_creation_tokens, 300);
      assert.strictEqual(result[0].tokens.cache_read_tokens, 400);
      assert.strictEqual(result[0].tokens.total_effective_tokens, 600);
    });

    it('should fall back to agent_id for missing agent name', () => {
      const metrics = createTestMetrics();
      const entry = appendToBuffer(metrics, { config: TEST_CONFIG });

      assert.ok(entry, 'entry should be written when the lock is free');
      const result = entriesToTrackerFormat([entry]);
      // agent_id, not 'unknown': tracker saves enforce unique agent names
      // per run, so nameless entries must not collide on a shared literal.
      assert.strictEqual(result[0].name, entry.agent_id);
    });

    it('should include agent_id for provenance', () => {
      const metrics = createTestMetrics({ agent_id: 'prov-agent-1' });
      const entry = appendToBuffer(metrics, { agentName: 'code-validator', config: TEST_CONFIG });

      assert.ok(entry, 'entry should be written when the lock is free');
      const result = entriesToTrackerFormat([entry]);
      assert.strictEqual(result[0].agent_id, 'prov-agent-1');
      assert.strictEqual(result[0].name, 'code-validator');
    });

    it('should handle empty array', () => {
      const result = entriesToTrackerFormat([]);
      assert.deepStrictEqual(result, []);
    });
  });
});
