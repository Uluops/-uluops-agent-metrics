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
import { spawnSync } from 'node:child_process';
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
  bufferTempPath,
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

/**
 * Write a raw entry with fully caller-controlled captured_at/expires_at
 * strings, bypassing writeRawEntry's unconditional ISO formatting. Needed for
 * spec 04 (unparseable-timestamp retention): writeRawEntry cannot produce an
 * unparseable expires_at or captured_at, since it ISO-formats both.
 */
function writeRawEntryWithTimestamps(
  metrics: ReturnType<typeof createTestMetrics>,
  timestamps: { captured_at: string; expires_at: string },
  config: BufferConfig = TEST_CONFIG,
): void {
  const entry = {
    agent_id: metrics.agent_id,
    session_id: metrics.session_id,
    captured_at: timestamps.captured_at,
    end_time: metrics.end_time,
    expires_at: timestamps.expires_at,
    metrics,
  };
  fs.appendFileSync(config.bufferPath, JSON.stringify(entry) + '\n');
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
    try {
      // spec 03: the cross-process GC-throttle sidecar marker. Without this,
      // a marker touched by one test's opportunistic GC would leave the gate
      // closed (fresh mtime) for every later test sharing TEST_CONFIG's
      // bufferPath within GC_INTERVAL_MS, since the marker — unlike
      // `lastGcAt` before it — persists on disk across appendToBuffer calls
      // rather than resetting per process.
      fs.unlinkSync(TEST_CONFIG.bufferPath + '.gc');
    } catch {
      // Marker doesn't exist, that's fine
    }
  });

  describe('appendToBuffer', () => {
    it('issue 33fa21ff: opportunistic GC failure is reported, not silently swallowed', () => {
      if (process.getuid?.() === 0) {
        // Root bypasses filesystem permission bits, so chmod 0o200 would not
        // reproduce the EACCES this test depends on (precedent: core.test.ts ~:273).
        return;
      }

      // This test uses its own bufferPath (gcConfig), so its sidecar `.gc`
      // throttle marker (spec 03, Option A) starts absent regardless of
      // execution order — the gate is open on this test's first
      // appendToBuffer call no matter what else has already run.
      const gcConfig: BufferConfig = {
        bufferPath: path.join(TEST_DIR, 'gc-failure-buffer.jsonl'),
        defaultTTL: TEST_TTL_MS,
      };
      writeRawEntry(createTestMetrics({ agent_id: 'gc-fail-expired' }), -1000, gcConfig);
      // appendFileSync (flag 'a') only needs write access, so the append
      // below still succeeds; readBuffer's readFileSync inside GC needs read
      // access and throws EACCES.
      fs.chmodSync(gcConfig.bufferPath, 0o200);

      const originalStderrWrite = process.stderr.write.bind(process.stderr);
      const captured: string[] = [];
      process.stderr.write = ((chunk: string | Uint8Array) => {
        captured.push(chunk.toString());
        return true;
      }) as typeof process.stderr.write;

      let entry: BufferEntry | null = null;
      try {
        entry = appendToBuffer(createTestMetrics({ agent_id: 'gc-fail-new' }), { config: gcConfig });
      } finally {
        process.stderr.write = originalStderrWrite;
        fs.chmodSync(gcConfig.bufferPath, 0o644);
      }

      assert.ok(entry, 'appendToBuffer should still return the new entry despite the GC failure');
      assert.ok(
        captured.some((line) => /buffer GC failed/.test(line)),
        `Expected a "buffer GC failed" warning on stderr, got:\n${captured.join('')}`
      );
    });

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

    describe('issue 0df83bb6 / 44bf69f1: isValidBufferEntry checks every field formatters.ts dereferences unconditionally', () => {
      it('skips an entry that passed the OLD validator but omits model/duration_ms/duration_formatted/execution', () => {
        const before = createTestMetrics({ agent_id: 'af7-before' });
        appendToBuffer(before, { config: TEST_CONFIG });

        // Has metrics.tokens with all five required numeric fields (passes the
        // old validator) but lacks model, duration_ms, duration_formatted, and
        // execution — every one of which formatters.ts dereferences without a
        // guard (e.g. entry.metrics.duration_formatted.padEnd(8)).
        fs.appendFileSync(
          TEST_CONFIG.bufferPath,
          JSON.stringify({
            agent_id: 'af7-incomplete',
            session_id: 's',
            captured_at: '2026-01-01T00:00:00Z',
            expires_at: '2099-01-01T00:00:00Z',
            metrics: {
              tokens: { input: 1, output: 1, cache_creation: 0, cache_read: 0, total_effective: 2 },
            },
          }) + '\n'
        );

        const after = createTestMetrics({ agent_id: 'af7-after' });
        appendToBuffer(after, { config: TEST_CONFIG });

        const entries = readBuffer(TEST_CONFIG);
        assert.strictEqual(entries.length, 2, 'The incomplete entry must be skipped, not just the malformed ones');
        assert.deepStrictEqual(entries.map((e) => e.agent_id), ['af7-before', 'af7-after']);
      });

      it('control: accepts an entry whose falsy-but-valid fields are 0 (execution.tool_use_count: 0, duration_ms: 0)', () => {
        fs.appendFileSync(
          TEST_CONFIG.bufferPath,
          JSON.stringify({
            agent_id: 'af7-falsy-valid',
            session_id: 's',
            captured_at: '2026-01-01T00:00:00Z',
            expires_at: '2099-01-01T00:00:00Z',
            metrics: {
              model: 'claude-sonnet-4-5-20250929',
              duration_ms: 0,
              duration_formatted: '0s',
              tokens: { input: 0, output: 0, cache_creation: 0, cache_read: 0, total_effective: 0 },
              execution: { tool_use_count: 0 },
            },
          }) + '\n'
        );

        const entries = readBuffer(TEST_CONFIG);
        assert.strictEqual(entries.length, 1, '0 is a valid value, not a missing field — must not be over-generalized away');
        assert.strictEqual(entries[0].agent_id, 'af7-falsy-valid');
      });

      it('control: accepts an entry lacking only optional cross-harness token fields (cached_input, reasoning_output, thinking, tool)', () => {
        fs.appendFileSync(
          TEST_CONFIG.bufferPath,
          JSON.stringify({
            agent_id: 'af7-optional-fields-absent',
            session_id: 's',
            captured_at: '2026-01-01T00:00:00Z',
            expires_at: '2099-01-01T00:00:00Z',
            metrics: {
              model: 'claude-sonnet-4-5-20250929',
              duration_ms: 1000,
              duration_formatted: '1s',
              tokens: { input: 10, output: 5, cache_creation: 0, cache_read: 0, total_effective: 15 },
              execution: { tool_use_count: 2 },
            },
          }) + '\n'
        );

        const entries = readBuffer(TEST_CONFIG);
        assert.strictEqual(entries.length, 1, 'Optional cross-harness token fields must stay optional');
        assert.strictEqual(entries[0].agent_id, 'af7-optional-fields-absent');
      });
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

    it('Fix 1: an entry with no end_time anywhere (entry.end_time and metrics.end_time both absent) is excluded by an endTime-windowed query', () => {
      const metrics = createTestMetrics();
      delete (metrics as { end_time?: string }).end_time;
      const now = new Date();
      // Write the raw line directly (bypassing writeRawEntry, which always sets
      // entry.end_time = metrics.end_time) so entry.end_time is absent too.
      const entry = {
        agent_id: metrics.agent_id,
        session_id: metrics.session_id,
        captured_at: now.toISOString(),
        expires_at: new Date(now.getTime() + TEST_TTL_MS).toISOString(),
        metrics,
      };
      fs.appendFileSync(TEST_CONFIG.bufferPath, JSON.stringify(entry) + '\n');

      const windowed = queryBuffer(
        { endTimeAfter: new Date(now.getTime() - 60_000), endTimeBefore: new Date(now.getTime() + 60_000) },
        TEST_CONFIG
      );
      assert.strictEqual(windowed.length, 0, 'a row with no end_time cannot satisfy a finish-time window');

      // Control: the same buffer with no window filter still returns the row.
      const unfiltered = queryBuffer({}, TEST_CONFIG);
      assert.strictEqual(unfiltered.length, 1);
    });

    it('Fix 1: an entry with an unparseable end_time is excluded by an endTime-windowed query', () => {
      writeRawEntry(createTestMetrics({ end_time: 'not-a-date' }), TEST_TTL_MS);

      const windowed = queryBuffer({ endTimeBefore: new Date('2000-01-01T00:00:00Z') }, TEST_CONFIG);
      assert.strictEqual(windowed.length, 0, 'an unparseable end_time cannot satisfy a finish-time window');

      // Control: the same buffer with no window filter still returns the row.
      const unfiltered = queryBuffer({}, TEST_CONFIG);
      assert.strictEqual(unfiltered.length, 1);
    });

    it('Fix 1 control: a well-formed row whose end_time is inside the window is still returned', () => {
      const now = new Date();
      writeRawEntry(createTestMetrics({ end_time: now.toISOString() }), TEST_TTL_MS);

      const windowed = queryBuffer(
        { endTimeAfter: new Date(now.getTime() - 60_000), endTimeBefore: new Date(now.getTime() + 60_000) },
        TEST_CONFIG
      );
      assert.strictEqual(windowed.length, 1, 'a well-formed in-window end_time must still pass');
    });

    it('issue 136d461e (query half): an entry with an unparseable captured_at is excluded by a since-windowed query', () => {
      const metrics = createTestMetrics();
      const now = new Date();
      // Write the raw line directly (bypassing writeRawEntry, which always
      // sets captured_at = now.toISOString()) so captured_at is unparseable.
      const entry = {
        agent_id: metrics.agent_id,
        session_id: metrics.session_id,
        captured_at: 'not-a-date',
        end_time: metrics.end_time,
        expires_at: new Date(now.getTime() + TEST_TTL_MS).toISOString(),
        metrics,
      };
      fs.appendFileSync(TEST_CONFIG.bufferPath, JSON.stringify(entry) + '\n');

      const windowed = queryBuffer({ since: new Date(now.getTime() - 60 * 60 * 1000) }, TEST_CONFIG);
      assert.strictEqual(windowed.length, 0, 'an unparseable captured_at cannot satisfy a since window');

      // Control: readBuffer never drops the row for this — only the
      // since-scoped query view excludes it.
      const unfiltered = queryBuffer({}, TEST_CONFIG);
      assert.strictEqual(unfiltered.length, 1);
      assert.strictEqual(readBuffer(TEST_CONFIG).length, 1, 'readBuffer itself must still return the row unfiltered');
    });

    it('control: a valid recent captured_at is still included under the same since window', () => {
      appendToBuffer(createTestMetrics(), { config: TEST_CONFIG });

      const windowed = queryBuffer({ since: new Date(Date.now() - 60 * 60 * 1000) }, TEST_CONFIG);
      assert.strictEqual(windowed.length, 1);
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

    it('issue 136d461e: an entry with an unparseable captured_at sorts last, deterministically', () => {
      // Written FIRST (before the valid entries) so a NaN-comparator's stable,
      // no-swap behavior would otherwise leave it in its original — wrong —
      // leading position rather than proving anything about "last".
      const sessionId = 'nan-sort-session';
      const metrics = createTestMetrics({ session_id: sessionId, agent_id: 'bad-captured' });
      const now = new Date();
      const badEntry = {
        agent_id: metrics.agent_id,
        session_id: metrics.session_id,
        captured_at: 'not-a-date',
        end_time: metrics.end_time,
        expires_at: new Date(now.getTime() + TEST_TTL_MS).toISOString(),
        metrics,
      };
      fs.appendFileSync(TEST_CONFIG.bufferPath, JSON.stringify(badEntry) + '\n');

      appendToBuffer(createTestMetrics({ session_id: sessionId, agent_id: 'valid-a' }), { config: TEST_CONFIG });
      appendToBuffer(createTestMetrics({ session_id: sessionId, agent_id: 'valid-b' }), { config: TEST_CONFIG });

      const all = getAllForSession(sessionId, TEST_CONFIG);
      assert.strictEqual(all.length, 3);
      assert.strictEqual(all[all.length - 1].agent_id, 'bad-captured', 'unparseable captured_at must sort last');
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

    it('should run opportunistically on append (via the append-triggered gate, not a direct cleanupExpired call)', () => {
      appendToBuffer(createTestMetrics({ agent_id: 'gc-valid-1' }), { config: TEST_CONFIG });
      writeRawEntry(createTestMetrics({ agent_id: 'gc-expired' }), -1000);

      // spec 03, Option A: appendToBuffer time-gates GC via a cross-process
      // `<bufferPath>.gc` sidecar marker. Append #1 above (fresh TEST_CONFIG,
      // no marker) opened the gate and touched it. Backdate it past
      // GC_INTERVAL_MS so append #2's gate is open too, and assert the
      // in-append trigger itself removed the expired entry — no direct
      // cleanupExpired() call.
      const gcPath = TEST_CONFIG.bufferPath + '.gc';
      const staleTime = new Date(Date.now() - 61_000);
      fs.utimesSync(gcPath, staleTime, staleTime);

      appendToBuffer(createTestMetrics({ agent_id: 'gc-valid-2' }), { config: TEST_CONFIG });

      const entries = readBuffer(TEST_CONFIG);
      assert.strictEqual(entries.length, 2);
      assert.ok(
        !entries.some((e) => e.agent_id === 'gc-expired'),
        'expired entry should be removed by the opportunistic append-triggered GC'
      );
    });
  });

  describe('untracked fix: rewrite paths (removeWhere/annotateBufferEntries) preserve quarantined rows', () => {
    // A quarantined row is a line readBuffer skips (and warns about) rather than
    // rejecting outright: either it fails isValidBufferEntry (well-formed JSON,
    // missing a required field) or it fails JSON.parse entirely. Neither should
    // be permanently deleted the next time a GC/annotate rewrite happens.
    const SCHEMA_INVALID_LINE = JSON.stringify({ agent_id: 'schema-invalid', session_id: 's1' });
    const UNPARSEABLE_LINE = '{"agent_id":"unparseable", "session_id":';

    function readRawLines(config: BufferConfig = TEST_CONFIG): string[] {
      return fs.readFileSync(config.bufferPath, 'utf-8').trim().split('\n').filter(Boolean);
    }

    it('cleanupExpired: quarantined lines survive a triggered rewrite, and the expired entry is actually gone', () => {
      appendToBuffer(createTestMetrics({ agent_id: 'valid-kept' }), { config: TEST_CONFIG });
      writeRawEntry(createTestMetrics({ agent_id: 'valid-expired' }), -1000);
      fs.appendFileSync(TEST_CONFIG.bufferPath, SCHEMA_INVALID_LINE + '\n');
      fs.appendFileSync(TEST_CONFIG.bufferPath, UNPARSEABLE_LINE + '\n');

      const removedCount = cleanupExpired(TEST_CONFIG);
      assert.strictEqual(removedCount, 1, 'only the expired valid entry should count as removed');

      const rawLines = readRawLines();
      assert.ok(rawLines.includes(SCHEMA_INVALID_LINE), 'schema-invalid line must survive the rewrite (fails today)');
      assert.ok(
        rawLines.some((l) => l.includes('unparseable')),
        'unparseable line must survive the rewrite (fails today)'
      );

      // Control: prove a rewrite actually happened — the expired entry must be gone.
      const entries = readBuffer(TEST_CONFIG);
      assert.ok(!entries.some((e) => e.agent_id === 'valid-expired'), 'expired entry should be removed');
      assert.ok(entries.some((e) => e.agent_id === 'valid-kept'), 'unexpired entry should remain');
    });

    it('annotateBufferEntries: quarantined lines survive a triggered rewrite', () => {
      appendToBuffer(createTestMetrics({ agent_id: 'annotate-target' }), { config: TEST_CONFIG });
      fs.appendFileSync(TEST_CONFIG.bufferPath, SCHEMA_INVALID_LINE + '\n');
      fs.appendFileSync(TEST_CONFIG.bufferPath, UNPARSEABLE_LINE + '\n');

      const updated = annotateBufferEntries({ 'annotate-target': 'renamed' }, TEST_CONFIG);
      assert.strictEqual(updated, 1);

      const rawLines = readRawLines();
      assert.ok(rawLines.includes(SCHEMA_INVALID_LINE), 'schema-invalid line must survive the rewrite (fails today)');
      assert.ok(
        rawLines.some((l) => l.includes('unparseable')),
        'unparseable line must survive the rewrite (fails today)'
      );

      // Control: prove a rewrite actually happened — the rename must have landed.
      const entries = readBuffer(TEST_CONFIG);
      assert.strictEqual(
        entries.find((e) => e.agent_id === 'annotate-target')?.agent_name,
        'renamed',
        'rename should have landed, proving a rewrite happened'
      );
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
      // The actual temp name is unique (`<bufferPath>.<pid>.<uuid>.tmp`, see
      // bufferTempPath), so a fixed-suffix existsSync check against
      // `<bufferPath>.tmp` is vacuous — no code ever creates that exact
      // name. Scan the sibling directory instead for anything matching the
      // real naming scheme.
      const dir = path.dirname(TEST_CONFIG.bufferPath);
      const base = path.basename(TEST_CONFIG.bufferPath);
      const leftoverTemps = fs.readdirSync(dir).filter(
        (name) => name.startsWith(`${base}.`) && name.endsWith('.tmp'),
      );
      assert.deepStrictEqual(leftoverTemps, [], 'No unique-named .tmp file should remain after rewrite');
    });
  });

  describe('bufferTempPath (issue a5ecf28a)', () => {
    it('produces a unique path per call matching the documented naming scheme', () => {
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
      const first = bufferTempPath(TEST_CONFIG.bufferPath);
      const second = bufferTempPath(TEST_CONFIG.bufferPath);

      assert.notStrictEqual(first, second, 'Two successive calls must differ');

      for (const tmpPath of [first, second]) {
        assert.ok(tmpPath.startsWith(`${TEST_CONFIG.bufferPath}.`), `${tmpPath} must be a sibling of the buffer path`);
        assert.ok(tmpPath.endsWith('.tmp'), `${tmpPath} must end with .tmp`);
        assert.ok(tmpPath.includes(String(process.pid)), `${tmpPath} must contain the process pid`);

        const middle = tmpPath.slice(TEST_CONFIG.bufferPath.length + 1, -'.tmp'.length);
        const [pidPart, uuidPart] = middle.split('.');
        assert.strictEqual(pidPart, String(process.pid));
        assert.ok(uuidPart && uuidRegex.test(uuidPart), `${uuidPart} must be a UUID`);
      }
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

    it('should drop entries whose core token fields are not numbers (F5 delta)', () => {
      // tokens object EXISTS but its numbers don't — must fail validation,
      // not flow undefined token counts into tracker rows.
      appendToBuffer(createTestMetrics({ agent_id: 'f5-good' }), { config: TEST_CONFIG });
      const bad = {
        agent_id: 'f5-bad',
        session_id: 's',
        captured_at: new Date().toISOString(),
        end_time: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60000).toISOString(),
        metrics: { model: 'x', tokens: { input: '5', output: 2 } },
      };
      fs.appendFileSync(TEST_CONFIG.bufferPath, JSON.stringify(bad) + '\n');
      const empty = { ...bad, agent_id: 'f5-empty', metrics: { model: 'x', tokens: {} } };
      fs.appendFileSync(TEST_CONFIG.bufferPath, JSON.stringify(empty) + '\n');

      const entries = readBuffer(TEST_CONFIG);
      assert.strictEqual(entries.length, 1, 'non-numeric/empty-token entries must be rejected');
      assert.strictEqual(entries[0]?.agent_id, 'f5-good');
    });

    it('should include agent_id for provenance', () => {
      const metrics = createTestMetrics({ agent_id: 'prov-agent-1' });
      const entry = appendToBuffer(metrics, { agentName: 'code-validator', config: TEST_CONFIG });

      assert.ok(entry, 'entry should be written when the lock is free');
      const result = entriesToTrackerFormat([entry]);
      assert.strictEqual(result[0].agent_id, 'prov-agent-1');
      assert.strictEqual(result[0].name, 'code-validator');
    });

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

    it('should handle empty array', () => {
      const result = entriesToTrackerFormat([]);
      assert.deepStrictEqual(result, []);
    });
  });

  describe('run_id — run-scoped attribution (v0.8.0)', () => {
    it('round-trips run_id through appendToBuffer → readBuffer', () => {
      const metrics = createTestMetrics();
      appendToBuffer(metrics, { runId: 'proj-ir-3-a4f3', config: TEST_CONFIG });

      const entries = readBuffer(TEST_CONFIG);
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].run_id, 'proj-ir-3-a4f3');
    });

    it('omits run_id when absent, and the entry is still valid', () => {
      const metrics = createTestMetrics();
      appendToBuffer(metrics, { config: TEST_CONFIG });

      const raw = fs.readFileSync(TEST_CONFIG.bufferPath, 'utf-8').trim();
      // undefined run_id must be omitted from the serialized JSON, not written as null
      assert.ok(!raw.includes('run_id'), 'serialized entry must omit run_id when absent');

      const entries = readValidEntries(TEST_CONFIG);
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].run_id, undefined);
    });

    it('reads a hand-written legacy JSONL line lacking run_id (backward-compat)', () => {
      const metrics = createTestMetrics();
      const now = new Date();
      const legacy: BufferEntry = {
        agent_id: metrics.agent_id,
        session_id: metrics.session_id,
        captured_at: now.toISOString(),
        end_time: metrics.end_time,
        expires_at: new Date(now.getTime() + TEST_TTL_MS).toISOString(),
        metrics,
        // no run_id — a row captured before v0.8.0
      };
      fs.appendFileSync(TEST_CONFIG.bufferPath, JSON.stringify(legacy) + '\n');

      const entries = readValidEntries(TEST_CONFIG);
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].run_id, undefined);
    });

    it('queryBuffer({runId}) returns only entries with a matching run_id', () => {
      appendToBuffer(createTestMetrics(), { runId: 'run-A', config: TEST_CONFIG });
      appendToBuffer(createTestMetrics(), { runId: 'run-B', config: TEST_CONFIG });
      appendToBuffer(createTestMetrics(), { config: TEST_CONFIG }); // untagged

      const a = queryBuffer({ runId: 'run-A' }, TEST_CONFIG);
      assert.strictEqual(a.length, 1);
      assert.strictEqual(a[0].run_id, 'run-A');
    });

    it('queryBuffer for an unknown token returns [] and entriesToTrackerFormat([]) is []', () => {
      appendToBuffer(createTestMetrics(), { runId: 'run-A', config: TEST_CONFIG });

      const none = queryBuffer({ runId: 'no-such-token' }, TEST_CONFIG);
      assert.deepStrictEqual(none, []);
      assert.deepStrictEqual(entriesToTrackerFormat(none), []);
    });

    it('AND-composes runId with projectPath', () => {
      appendToBuffer(createTestMetrics(), { runId: 'run-A', projectPath: '/proj/x', config: TEST_CONFIG });
      appendToBuffer(createTestMetrics(), { runId: 'run-A', projectPath: '/proj/y', config: TEST_CONFIG });

      const composed = queryBuffer({ runId: 'run-A', projectPath: '/proj/x' }, TEST_CONFIG);
      assert.strictEqual(composed.length, 1);
      assert.strictEqual(composed[0].project_path, '/proj/x');
    });

    it('excludes legacy rows (no run_id) from a --run result', () => {
      appendToBuffer(createTestMetrics(), { runId: 'run-A', config: TEST_CONFIG });
      appendToBuffer(createTestMetrics(), { config: TEST_CONFIG }); // untagged/legacy

      const scoped = queryBuffer({ runId: 'run-A' }, TEST_CONFIG);
      assert.strictEqual(scoped.length, 1);
    });

    it('regression guard (ADR-0004): entriesToTrackerFormat NEVER surfaces run_id', () => {
      appendToBuffer(createTestMetrics(), { runId: 'run-A', config: TEST_CONFIG });
      const withRun = queryBuffer({ runId: 'run-A' }, TEST_CONFIG);
      assert.strictEqual(withRun.length, 1);

      const tracker = entriesToTrackerFormat(withRun);
      assert.strictEqual(tracker.length, 1);
      assert.ok(!('run_id' in tracker[0]), 'tracker output must NOT contain run_id (strict save_run schema)');

      // The tracker shape is identical whether or not the source carried a run_id.
      appendToBuffer(createTestMetrics(), { config: TEST_CONFIG }); // untagged
      const untagged = queryBuffer({}, TEST_CONFIG).filter((e) => e.run_id === undefined);
      const trackerUntagged = entriesToTrackerFormat(untagged.slice(0, 1));
      assert.deepStrictEqual(
        Object.keys(tracker[0]).sort(),
        Object.keys(trackerUntagged[0]).sort(),
        'tracker key-set must be identical with and without run_id on the source entry'
      );

      // run_id IS present in the raw entry (surfaced by -f json, which serializes BufferEntry).
      assert.strictEqual(withRun[0].run_id, 'run-A');
    });
  });

  describe('opportunistic GC throttle — cross-process sidecar (spec 03, Option A)', () => {
    const GC_CONFIG: BufferConfig = {
      bufferPath: path.join(TEST_DIR, 'gc-throttle-buffer.jsonl'),
      defaultTTL: TEST_TTL_MS,
    };

    beforeEach(() => {
      for (const suffix of ['', '.lock', '.gc']) {
        try {
          fs.unlinkSync(GC_CONFIG.bufferPath + suffix);
        } catch {
          // doesn't exist, fine
        }
      }
    });

    it('two sequential appendToBuffer calls within the interval produce exactly one GC run', () => {
      // Append #1: no sidecar marker yet -> gate open -> GC runs (buffer is
      // empty at this point, so it removes nothing but touches the marker).
      appendToBuffer(createTestMetrics({ agent_id: 'interval-1' }), { config: GC_CONFIG });

      // Written directly (bypassing the lock) between the two appends, like
      // an entry that expired in the gap.
      writeRawEntry(createTestMetrics({ agent_id: 'interval-expired' }), -1000, GC_CONFIG);

      appendToBuffer(createTestMetrics({ agent_id: 'interval-2' }), { config: GC_CONFIG });

      const entries = readBuffer(GC_CONFIG);
      assert.ok(
        entries.some((e) => e.agent_id === 'interval-expired'),
        'expired entry written between the two appends must still be present — the gate must have stayed closed for append #2'
      );
    });

    it('the gate reopens once the sidecar marker is older than GC_INTERVAL_MS', () => {
      appendToBuffer(createTestMetrics({ agent_id: 'reopen-1' }), { config: GC_CONFIG });
      writeRawEntry(createTestMetrics({ agent_id: 'reopen-expired' }), -1000, GC_CONFIG);

      const gcPath = GC_CONFIG.bufferPath + '.gc';
      const staleTime = new Date(Date.now() - 61_000);
      fs.utimesSync(gcPath, staleTime, staleTime);

      appendToBuffer(createTestMetrics({ agent_id: 'reopen-2' }), { config: GC_CONFIG });

      const entries = readBuffer(GC_CONFIG);
      assert.ok(
        !entries.some((e) => e.agent_id === 'reopen-expired'),
        'expired entry should be gone once the throttle gate reopens'
      );
    });
  });

  describe('opportunistic GC throttle — cross-process (finding-level, spec 03 §7)', () => {
    it("a second process appending within GC_INTERVAL_MS of the first process's GC must not trigger a second GC", () => {
      const config: BufferConfig = {
        bufferPath: path.join(TEST_DIR, 'cross-process-buffer.jsonl'),
        defaultTTL: TEST_TTL_MS,
      };
      for (const suffix of ['', '.lock', '.gc']) {
        try {
          fs.unlinkSync(config.bufferPath + suffix);
        } catch {
          // doesn't exist, fine
        }
      }

      // Process 1 (this test process): first append opens the gate (no
      // marker yet) and GC runs, touching the marker.
      appendToBuffer(createTestMetrics({ agent_id: 'cross-1' }), { config });

      // An expired row, as if it arrived between process 1's GC and process 2's append.
      writeRawEntry(createTestMetrics({ agent_id: 'cross-expired' }), -1000, config);

      // Process 2: a genuinely separate Node process, appending to the SAME
      // buffer within GC_INTERVAL_MS of process 1's GC. Under the old
      // module-scoped `lastGcAt`, this fresh process's own `lastGcAt` would
      // be 0 and it would always GC — exactly the bug this proposal fixes.
      const bufferModuleUrl = new URL('./buffer.js', import.meta.url).href;
      const childMetrics = createTestMetrics({ agent_id: 'cross-2' });
      const script =
        `import(${JSON.stringify(bufferModuleUrl)}).then(({ appendToBuffer }) => { ` +
        `appendToBuffer(${JSON.stringify(childMetrics)}, { config: ${JSON.stringify(config)} }); ` +
        `});`;

      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf-8',
        timeout: 10_000,
      });
      assert.strictEqual(
        result.status,
        0,
        `child process failed (status ${result.status}): stderr=${result.stderr} error=${result.error}`
      );

      const entries = readBuffer(config);
      assert.ok(
        entries.some((e) => e.agent_id === 'cross-expired'),
        "expired entry must survive the second process's append — the cross-process gate must have stayed closed"
      );
      assert.ok(
        entries.some((e) => e.agent_id === 'cross-2'),
        "the second process's own append must still have landed"
      );
    });
  });

  describe('retention: unparseable expires_at derives from captured_at + defaultTTL (spec 04, Option C)', () => {
    const DERIVE_CONFIG: BufferConfig = {
      bufferPath: path.join(TEST_DIR, 'derive-buffer.jsonl'),
      defaultTTL: 30 * 24 * 60 * 60 * 1000, // 30d, matches the spec's fixtures
    };

    beforeEach(() => {
      for (const suffix of ['', '.lock', '.gc']) {
        try {
          fs.unlinkSync(DERIVE_CONFIG.bufferPath + suffix);
        } catch {
          // doesn't exist, fine
        }
      }
    });

    function captureStderr(fn: () => number): { removedCount: number; captured: string[] } {
      const originalWrite = process.stderr.write.bind(process.stderr);
      const captured: string[] = [];
      process.stderr.write = ((chunk: string | Uint8Array) => {
        captured.push(chunk.toString());
        return true;
      }) as typeof process.stderr.write;

      let removedCount: number;
      try {
        removedCount = fn();
      } finally {
        process.stderr.write = originalWrite;
      }
      return { removedCount, captured };
    }

    it('1: unparseable expires_at + captured_at 31d ago (30d TTL) — cleanupExpired removes it', () => {
      const capturedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      writeRawEntryWithTimestamps(
        createTestMetrics({ agent_id: 'derived-expired' }),
        { captured_at: capturedAt, expires_at: 'not-a-date' },
        DERIVE_CONFIG
      );

      const { removedCount } = captureStderr(() => cleanupExpired(DERIVE_CONFIG));
      assert.strictEqual(removedCount, 1, 'row must be removed once expiry is derived from captured_at + defaultTTL');

      const remaining = readBuffer(DERIVE_CONFIG);
      assert.ok(!remaining.some((e) => e.agent_id === 'derived-expired'));
    });

    it('2: unparseable expires_at + captured_at 1h ago (30d TTL) — kept, returned by readValidEntries', () => {
      const capturedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      writeRawEntryWithTimestamps(
        createTestMetrics({ agent_id: 'derived-fresh' }),
        { captured_at: capturedAt, expires_at: 'not-a-date' },
        DERIVE_CONFIG
      );

      const valid = readValidEntries(DERIVE_CONFIG);
      assert.ok(valid.some((e) => e.agent_id === 'derived-fresh'), 'row must still be readable as valid');
    });

    it('3: both fields unparseable — kept, exactly one stderr warning naming the row per cleanupExpired call', () => {
      writeRawEntryWithTimestamps(
        createTestMetrics({ agent_id: 'both-broken' }),
        { captured_at: 'also-not-a-date', expires_at: 'not-a-date' },
        DERIVE_CONFIG
      );

      const { removedCount, captured } = captureStderr(() => cleanupExpired(DERIVE_CONFIG));
      assert.strictEqual(removedCount, 0, 'a row with no derivable expiry must be kept');

      const warnings = captured.filter((l) => /both-broken/.test(l));
      assert.strictEqual(
        warnings.length,
        1,
        `expected exactly one warning naming both-broken, got:\n${captured.join('')}`
      );

      const remaining = readBuffer(DERIVE_CONFIG);
      assert.ok(remaining.some((e) => e.agent_id === 'both-broken'), 'row must survive on disk');
    });

    it('4 (control): well-formed unexpired row is untouched, no warning', () => {
      appendToBuffer(createTestMetrics({ agent_id: 'wellformed-fresh' }), { config: DERIVE_CONFIG });

      const { removedCount, captured } = captureStderr(() => cleanupExpired(DERIVE_CONFIG));
      assert.strictEqual(removedCount, 0);
      assert.strictEqual(captured.filter((l) => /wellformed-fresh/.test(l)).length, 0);

      const remaining = readBuffer(DERIVE_CONFIG);
      assert.ok(remaining.some((e) => e.agent_id === 'wellformed-fresh'));
    });

    it('5 (control): well-formed expired row is still removed and counted', () => {
      writeRawEntry(createTestMetrics({ agent_id: 'wellformed-expired' }), -1000, DERIVE_CONFIG);

      const { removedCount } = captureStderr(() => cleanupExpired(DERIVE_CONFIG));
      assert.strictEqual(removedCount, 1);

      const remaining = readBuffer(DERIVE_CONFIG);
      assert.ok(!remaining.some((e) => e.agent_id === 'wellformed-expired'));
    });

    it('6: getBufferStats counts a derivable-expired row as expired, not valid', () => {
      const capturedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      writeRawEntryWithTimestamps(
        createTestMetrics({ agent_id: 'stats-derived-expired' }),
        { captured_at: capturedAt, expires_at: 'not-a-date' },
        DERIVE_CONFIG
      );

      const stats = getBufferStats(DERIVE_CONFIG);
      assert.strictEqual(stats.totalEntries, 1);
      assert.strictEqual(stats.validEntries, 0);
      assert.strictEqual(stats.expiredEntries, 1);
    });
  });

  describe('state file permissions (spec 05, Option A: mode 0600 on write, no chmod on write path)', () => {
    function skip(): boolean {
      return process.getuid?.() === 0 || process.platform === 'win32';
    }

    it('1: a fresh buffer file is created with mode 0600', () => {
      if (skip()) return;
      appendToBuffer(createTestMetrics({ agent_id: 'perm-fresh' }), { config: TEST_CONFIG });
      const mode = fs.statSync(TEST_CONFIG.bufferPath).mode & 0o777;
      assert.strictEqual(mode, 0o600, `expected buffer mode 0600, got ${mode.toString(8)}`);
    });

    it('bonus: the spec-03 GC sidecar marker file is also created with mode 0600', () => {
      if (skip()) return;
      appendToBuffer(createTestMetrics({ agent_id: 'perm-gc-marker' }), { config: TEST_CONFIG });
      const gcPath = TEST_CONFIG.bufferPath + '.gc';
      const mode = fs.statSync(gcPath).mode & 0o777;
      assert.strictEqual(mode, 0o600, `expected .gc marker mode 0600, got ${mode.toString(8)}`);
    });

    it('5: the buffer directory is created with mode 0700', () => {
      if (skip()) return;
      const freshDir = path.join(TEST_DIR, 'perm-fresh-subdir');
      const config: BufferConfig = {
        bufferPath: path.join(freshDir, 'buffer.jsonl'),
        defaultTTL: TEST_TTL_MS,
      };
      appendToBuffer(createTestMetrics({ agent_id: 'perm-dir' }), { config });
      const mode = fs.statSync(freshDir).mode & 0o777;
      assert.strictEqual(mode, 0o700, `expected buffer dir mode 0700, got ${mode.toString(8)}`);
    });

    it('4: rewrite self-heals hardening via cleanupExpired/removeWhere — a 0644 buffer becomes 0600 at its next GC rewrite', () => {
      if (skip()) return;
      appendToBuffer(createTestMetrics({ agent_id: 'perm-preexisting' }), { config: TEST_CONFIG });
      fs.chmodSync(TEST_CONFIG.bufferPath, 0o644);
      writeRawEntry(createTestMetrics({ agent_id: 'perm-to-expire' }), -1000);

      const removed = cleanupExpired(TEST_CONFIG);
      assert.strictEqual(removed, 1);

      const mode = fs.statSync(TEST_CONFIG.bufferPath).mode & 0o777;
      assert.strictEqual(mode, 0o600, `expected rewrite to self-heal to 0600, got ${mode.toString(8)}`);
    });

    it('4b: rewrite self-heals hardening via annotateBufferEntries too (both rewrite sites must set mode)', () => {
      if (skip()) return;
      appendToBuffer(createTestMetrics({ agent_id: 'perm-annotate-target' }), { config: TEST_CONFIG });
      fs.chmodSync(TEST_CONFIG.bufferPath, 0o644);

      const updated = annotateBufferEntries({ 'perm-annotate-target': 'renamed' }, TEST_CONFIG);
      assert.strictEqual(updated, 1);

      const mode = fs.statSync(TEST_CONFIG.bufferPath).mode & 0o777;
      assert.strictEqual(mode, 0o600, `expected annotateBufferEntries rewrite to self-heal to 0600, got ${mode.toString(8)}`);
    });

    it('6 (control): appendFileSync without an explicit mode does not yield 0600 (proves the assertions above can fail)', () => {
      if (skip()) return;
      const p = path.join(TEST_DIR, 'perm-control-no-mode.txt');
      try {
        fs.unlinkSync(p);
      } catch {
        // doesn't exist, fine
      }
      fs.appendFileSync(p, 'x', 'utf-8');
      const mode = fs.statSync(p).mode & 0o777;
      assert.notStrictEqual(mode, 0o600, `expected a non-0600 mode without an explicit mode argument, got ${mode.toString(8)}`);
      fs.unlinkSync(p);
    });
  });
});
