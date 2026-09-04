/**
 * Utils Module Tests
 *
 * Tests for utility functions including:
 * - Path sanitization
 * - Duration formatting
 * - Token formatting
 * - Number formatting
 * - Agent ID extraction
 * - Project name extraction
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  sanitizePathAsFolderName,
  formatDuration,
  formatNumber,
  formatTokens,
  formatModelName,
  parseTimestamp,
  calculateDuration,
  extractAgentIdFromFilename,
  getProjectName,
  getClaudeProjectsDir,
  findAgentFile,
  findRecentAgentFiles,
  findCodexAgentFile,
  findRecentCodexAgentFiles,
} from './utils.js';

// Test configuration with isolated temp directory
const TEST_DIR = path.join(os.tmpdir(), 'agent-metrics-utils-test-' + Date.now());
const MOCK_PROJECTS_DIR = path.join(TEST_DIR, '.claude', 'projects');

describe('Utils Module', () => {
  before(() => {
    fs.mkdirSync(MOCK_PROJECTS_DIR, { recursive: true });
  });

  after(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('sanitizePathAsFolderName', () => {
    it('should replace forward slashes with dashes', () => {
      assert.strictEqual(
        sanitizePathAsFolderName('/home/user/project'),
        '-home-user-project'
      );
    });

    it('should handle root path', () => {
      assert.strictEqual(sanitizePathAsFolderName('/'), '-');
    });

    it('should handle paths without leading slash', () => {
      assert.strictEqual(
        sanitizePathAsFolderName('home/user/project'),
        'home-user-project'
      );
    });

    it('should handle single directory', () => {
      assert.strictEqual(sanitizePathAsFolderName('/project'), '-project');
    });

    it('should preserve dashes in path', () => {
      assert.strictEqual(
        sanitizePathAsFolderName('/home/user/my-project'),
        '-home-user-my-project'
      );
    });

    it('should handle empty string', () => {
      assert.strictEqual(sanitizePathAsFolderName(''), '');
    });
  });

  describe('formatDuration', () => {
    it('should format seconds only', () => {
      assert.strictEqual(formatDuration(5000), '5s');
      assert.strictEqual(formatDuration(45000), '45s');
      assert.strictEqual(formatDuration(59000), '59s');
    });

    it('should format minutes and seconds', () => {
      assert.strictEqual(formatDuration(60000), '1m 0s');
      assert.strictEqual(formatDuration(90000), '1m 30s');
      assert.strictEqual(formatDuration(279000), '4m 39s');
      assert.strictEqual(formatDuration(3599000), '59m 59s');
    });

    it('should format hours and minutes', () => {
      assert.strictEqual(formatDuration(3600000), '1h 0m');
      assert.strictEqual(formatDuration(5400000), '1h 30m');
      assert.strictEqual(formatDuration(7380000), '2h 3m');
    });

    it('should handle zero', () => {
      assert.strictEqual(formatDuration(0), '0s');
    });

    it('should handle sub-second durations', () => {
      assert.strictEqual(formatDuration(500), '0s');
      assert.strictEqual(formatDuration(999), '0s');
    });
  });

  describe('formatNumber', () => {
    it('should format small numbers', () => {
      assert.strictEqual(formatNumber(0), '0');
      assert.strictEqual(formatNumber(123), '123');
      assert.strictEqual(formatNumber(999), '999');
    });

    it('should format thousands with separators', () => {
      assert.strictEqual(formatNumber(1000), '1,000');
      assert.strictEqual(formatNumber(12345), '12,345');
      assert.strictEqual(formatNumber(999999), '999,999');
    });

    it('should format millions with separators', () => {
      assert.strictEqual(formatNumber(1000000), '1,000,000');
      assert.strictEqual(formatNumber(1234567890), '1,234,567,890');
    });
  });

  describe('formatTokens', () => {
    it('should format small numbers without suffix', () => {
      assert.strictEqual(formatTokens(0), '0');
      assert.strictEqual(formatTokens(500), '500');
      assert.strictEqual(formatTokens(999), '999');
    });

    it('should format thousands with k suffix', () => {
      assert.strictEqual(formatTokens(1000), '1.0k');
      assert.strictEqual(formatTokens(1500), '1.5k');
      assert.strictEqual(formatTokens(45200), '45.2k');
      assert.strictEqual(formatTokens(999999), '1000.0k');
    });

    it('should format millions with M suffix', () => {
      assert.strictEqual(formatTokens(1000000), '1.0M');
      assert.strictEqual(formatTokens(1500000), '1.5M');
      assert.strictEqual(formatTokens(2500000), '2.5M');
    });
  });

  describe('formatModelName', () => {
    it('should remove claude- prefix and date suffix', () => {
      assert.strictEqual(formatModelName('claude-sonnet-4-5-20250929'), 'sonnet-4-5');
      assert.strictEqual(formatModelName('claude-opus-4-5-20251101'), 'opus-4-5');
      assert.strictEqual(formatModelName('claude-haiku-3-5-20240307'), 'haiku-3-5');
    });

    it('should handle models without claude- prefix', () => {
      assert.strictEqual(formatModelName('sonnet-4-5-20250929'), 'sonnet-4-5');
      assert.strictEqual(formatModelName('gpt-4-turbo'), 'gpt-4-turbo');
    });

    it('should respect maxLength parameter', () => {
      assert.strictEqual(formatModelName('claude-sonnet-4-5-20250929', 6), 'sonnet');
      assert.strictEqual(formatModelName('claude-sonnet-4-5-20250929', 20), 'sonnet-4-5');
    });

    it('should return unknown for null/undefined', () => {
      assert.strictEqual(formatModelName(null), 'unknown');
      assert.strictEqual(formatModelName(undefined), 'unknown');
      assert.strictEqual(formatModelName(''), 'unknown');
    });

    it('should handle various date formats', () => {
      // 8-digit dates only
      assert.strictEqual(formatModelName('claude-test-20240101'), 'test');
      assert.strictEqual(formatModelName('claude-test-20991231'), 'test');
      // Not 8-digit dates should be preserved
      assert.strictEqual(formatModelName('claude-test-2024'), 'test-2024');
    });
  });

  describe('parseTimestamp', () => {
    it('should parse ISO 8601 timestamps', () => {
      const date = parseTimestamp('2026-01-08T04:45:00.000Z');
      assert.ok(date instanceof Date);
      assert.strictEqual(date.getUTCFullYear(), 2026);
      assert.strictEqual(date.getUTCMonth(), 0); // January
      assert.strictEqual(date.getUTCDate(), 8);
    });

    it('should handle timestamps with timezone', () => {
      const date = parseTimestamp('2026-01-08T12:00:00+05:00');
      assert.ok(date instanceof Date);
      assert.ok(!isNaN(date.getTime()));
    });

    it('tracker 1917beff: an unparseable timestamp yields an Invalid Date, not a throw', () => {
      const date = parseTimestamp('not-a-real-timestamp');
      assert.ok(date instanceof Date, 'must still return a Date instance (documented, non-breaking contract)');
      assert.ok(isNaN(date.getTime()), 'getTime() must be NaN for unparseable input — callers must check this');
    });
  });

  describe('calculateDuration', () => {
    it('should calculate duration between timestamps', () => {
      const start = '2026-01-08T04:00:00.000Z';
      const end = '2026-01-08T04:05:30.000Z';
      assert.strictEqual(calculateDuration(start, end), 330000); // 5m 30s in ms
    });

    it('should return 0 for same timestamps', () => {
      const timestamp = '2026-01-08T04:00:00.000Z';
      assert.strictEqual(calculateDuration(timestamp, timestamp), 0);
    });

    it('should return negative for reversed timestamps', () => {
      const start = '2026-01-08T04:05:00.000Z';
      const end = '2026-01-08T04:00:00.000Z';
      assert.strictEqual(calculateDuration(start, end), -300000);
    });

    it('tracker 1917beff: an unparseable start timestamp is NaN-safe (returns 0, not NaN)', () => {
      assert.strictEqual(calculateDuration('not-a-real-timestamp', '2026-01-08T04:00:00.000Z'), 0);
    });

    it('tracker 1917beff: an unparseable end timestamp is NaN-safe (returns 0, not NaN)', () => {
      assert.strictEqual(calculateDuration('2026-01-08T04:00:00.000Z', 'not-a-real-timestamp'), 0);
    });

    it('control: a valid pair of timestamps is unaffected by the NaN guard', () => {
      assert.strictEqual(calculateDuration('2026-01-08T04:00:00.000Z', '2026-01-08T04:01:00.000Z'), 60000);
    });
  });

  describe('extractAgentIdFromFilename', () => {
    it('should extract agent ID from valid filenames', () => {
      assert.strictEqual(extractAgentIdFromFilename('agent-a80e24f.jsonl'), 'a80e24f');
      assert.strictEqual(extractAgentIdFromFilename('agent-abc123.jsonl'), 'abc123');
      assert.strictEqual(extractAgentIdFromFilename('agent-0123456789abcdef.jsonl'), '0123456789abcdef');
    });

    it('should return null for non-agent filenames', () => {
      assert.strictEqual(extractAgentIdFromFilename('session.jsonl'), null);
      assert.strictEqual(extractAgentIdFromFilename('agent.jsonl'), null);
      assert.strictEqual(extractAgentIdFromFilename('agent-abc123.json'), null); // Wrong extension
    });

    it('should return null for invalid agent IDs', () => {
      assert.strictEqual(extractAgentIdFromFilename('agent-ABC123.jsonl'), null); // Uppercase
      assert.strictEqual(extractAgentIdFromFilename('agent-xyz.jsonl'), null); // Non-hex
      assert.strictEqual(extractAgentIdFromFilename('agent-.jsonl'), null); // Empty ID
    });
  });

  describe('getProjectName', () => {
    it('should extract project name from path, skipping home/user and username', () => {
      // Function skips 'home', 'user' prefixes AND the next segment (username)
      // So -home-user-my-project -> ['home','user','my','project'] -> skip home,user,<username> -> 'project'
      assert.strictEqual(
        getProjectName('/home/user/.claude/projects/-home-user-my-project'),
        'project'
      );
    });

    it('should handle complex paths', () => {
      const result = getProjectName('/path/-home-alexs-ongoing-projects-claude-agent-workflows');
      // Should skip home, alexs (username), and return the remaining segments
      assert.ok(result.includes('claude-agent-workflows') || result.length > 0);
    });

    it('should skip first segment when no common prefixes', () => {
      // For 'simple-folder', no common prefixes found, but still skips first segment as "username"
      const result = getProjectName('/some/path/simple-folder');
      assert.strictEqual(result, 'folder');
    });

    it('should handle paths with only dashes', () => {
      const result = getProjectName('/path/---');
      assert.ok(typeof result === 'string');
    });
  });

  describe('getClaudeProjectsDir', () => {
    it('should return path under home directory', () => {
      const projectsDir = getClaudeProjectsDir();
      assert.ok(projectsDir.startsWith(os.homedir()));
      assert.ok(projectsDir.includes('.claude'));
      assert.ok(projectsDir.includes('projects'));
    });
  });

  describe('findAgentFile', () => {
    before(() => {
      // Create mock project structure
      const projectFolder = '-test-project';
      const projectDir = path.join(MOCK_PROJECTS_DIR, projectFolder);
      fs.mkdirSync(projectDir, { recursive: true });

      // Create agent file
      fs.writeFileSync(
        path.join(projectDir, 'agent-abc123.jsonl'),
        '{"type": "test"}\n'
      );
    });

    it('should return null for non-existent agent', () => {
      const result = findAgentFile('nonexistent');
      assert.strictEqual(result, null);
    });

    it('should normalize agent ID with prefix', () => {
      // The function should strip 'agent-' prefix
      const result1 = findAgentFile('agent-xyz');
      const result2 = findAgentFile('xyz');
      // Both should behave the same (both null since xyz doesn't exist)
      assert.strictEqual(result1, result2);
    });

    it('F6: should return null for traversal attempts and other invalid IDs', () => {
      // Path traversal
      assert.strictEqual(findAgentFile('../../../etc/passwd'), null, 'traversal should return null');
      assert.strictEqual(findAgentFile('agent-../../../etc/passwd'), null, 'agent- traversal should return null');
      // Uppercase hex (not a valid Claude agent ID)
      assert.strictEqual(findAgentFile('ABC123'), null, 'uppercase ID should return null');
      // Non-hex characters
      assert.strictEqual(findAgentFile('xyz-invalid'), null, 'non-hex ID should return null');
      // Empty string
      assert.strictEqual(findAgentFile(''), null, 'empty ID should return null');
    });
  });

  describe('findRecentAgentFiles', () => {
    it('should return empty array when no projects exist', async () => {
      // Create a temp empty projects dir
      const emptyProjectsDir = path.join(TEST_DIR, 'empty-projects');
      fs.mkdirSync(emptyProjectsDir, { recursive: true });

      // findRecentAgentFiles uses the real projects dir, so test behavior
      const result = await findRecentAgentFiles(10);
      assert.ok(Array.isArray(result));
    });

    it('should respect limit parameter', async () => {
      const result = await findRecentAgentFiles(5);
      assert.ok(result.length <= 5);
    });

    it('should return sorted by modification time', async () => {
      const result = await findRecentAgentFiles(10);
      // Results should be sorted newest first - we can't easily test this
      // without mocking, but verify the structure is correct
      for (const item of result) {
        assert.ok('filePath' in item);
        assert.ok('projectDir' in item);
      }
    });
  });

  describe('Codex scan skip reporting (issues 6f86d9e3, 956c263f, c0c04a45)', () => {
    const CODEX_TEST_DIR = path.join(TEST_DIR, 'codex-scan');
    const originalEnv = { ...process.env };
    let originalStderrWrite: typeof process.stderr.write;
    let captured: string;

    function freshCodexHome(name: string): { codexHome: string; sessionsDir: string } {
      const codexHome = path.join(CODEX_TEST_DIR, name);
      const sessionsDir = path.join(codexHome, 'sessions');
      fs.mkdirSync(sessionsDir, { recursive: true });
      process.env.CODEX_HOME = codexHome;
      return { codexHome, sessionsDir };
    }

    function sessionMetaLine(overrides: Record<string, unknown> = {}): string {
      return JSON.stringify({
        timestamp: '2026-06-08T16:14:05.000Z',
        type: 'session_meta',
        payload: {
          id: 'placeholder',
          cwd: '/test/project',
          thread_source: 'subagent',
          ...overrides,
        },
      });
    }

    before(() => {
      fs.mkdirSync(CODEX_TEST_DIR, { recursive: true });
    });

    after(() => {
      fs.rmSync(CODEX_TEST_DIR, { recursive: true, force: true });
      process.env = originalEnv;
    });

    beforeEach(() => {
      originalStderrWrite = process.stderr.write;
      captured = '';
      process.stderr.write = ((msg: string | Uint8Array) => {
        captured += typeof msg === 'string' ? msg : msg.toString();
        return true;
      }) as typeof process.stderr.write;
    });

    afterEach(() => {
      process.stderr.write = originalStderrWrite;
    });

    it('reads a session_meta first line longer than 8KB (live finding 2026-09-03: every real rollout on the dev machine exceeded the old fixed 8192-byte read)', async () => {
      const { sessionsDir } = freshCodexHome('long-meta');
      // ~20KB first line: the filename carries no id suffix, so only the
      // session_meta.payload.id fallback can find it.
      const line = sessionMetaLine({ id: 'long-meta-id-0001', padding: 'x'.repeat(20000) });
      assert.ok(Buffer.byteLength(line) > 8192, 'fixture must exceed the old 8KB read');
      fs.writeFileSync(path.join(sessionsDir, 'rollout-2026-06-08T16-14-05-long.jsonl'), line + '\n');

      const byId = await findCodexAgentFile('long-meta-id-0001');
      assert.ok(byId, 'id fallback must find a rollout whose session_meta line exceeds 8KB');
      assert.strictEqual(byId.projectDir, '/test/project');
      const recent = await findRecentCodexAgentFiles(5);
      assert.strictEqual(recent.length, 1, 'thread_source=subagent must be read from a >8KB session_meta');
      assert.strictEqual(captured, '', `a readable long first line must not be reported as a skip, got:\n${captured}`);
    });

    it('control: a first line beyond the 1 MiB cap is recorded as a skip naming the file, not parsed', async () => {
      const { sessionsDir } = freshCodexHome('over-cap');
      const line = sessionMetaLine({ id: 'over-cap-id', padding: 'x'.repeat(1024 * 1024 + 100) });
      const filePath = path.join(sessionsDir, 'rollout-2026-06-08T16-14-05-overcap.jsonl');
      fs.writeFileSync(filePath, line + '\n');

      const byId = await findCodexAgentFile('over-cap-id');
      assert.strictEqual(byId, null);
      assert.ok(captured.includes(filePath), `skip must name the file, got:\n${captured}`);
      assert.ok(/exceeds/.test(captured), `skip must name the cap, got:\n${captured}`);
    });

    it('T1: scanning more than CODEX_SCAN_NOTICE_THRESHOLD files emits exactly one size notice naming the count', async () => {
      const { sessionsDir } = freshCodexHome('over-threshold');
      const fileCount = 1001; // THRESHOLD (1000) + 1
      for (let i = 0; i < fileCount; i++) {
        fs.writeFileSync(path.join(sessionsDir, `rollout-${i}.jsonl`), '');
      }

      const result = await findCodexAgentFile('nonexistent-agent-id');
      assert.strictEqual(result, null);

      const noticeLines = captured.split('\n').filter((l) => /scanning \d+ Codex session files/.test(l));
      assert.strictEqual(noticeLines.length, 1, `Expected exactly one size notice, got:\n${captured}`);
      assert.ok(noticeLines[0]?.includes(String(fileCount)), `Notice should name the count ${fileCount}, got: ${noticeLines[0]}`);
    });

    it('T2: an unreadable sessions/ subdirectory beside a readable rollout does not hide the readable file, and stderr names the skipped subdirectory', async () => {
      if (process.getuid?.() === 0) {
        return;
      }
      const { sessionsDir } = freshCodexHome('unreadable-subdir');
      const targetId = '019eaa28-8e2d-73a2-840f-a00d6cc8795f';

      const readableDir = path.join(sessionsDir, 'readable');
      fs.mkdirSync(readableDir, { recursive: true });
      const targetFile = path.join(readableDir, `rollout-2026-06-08-${targetId}.jsonl`);
      fs.writeFileSync(targetFile, sessionMetaLine({ id: targetId }));

      const blockedDir = path.join(sessionsDir, 'blocked');
      fs.mkdirSync(blockedDir, { recursive: true });
      fs.chmodSync(blockedDir, 0o000);

      try {
        const result = await findCodexAgentFile(targetId);
        assert.ok(result, 'the readable rollout file must still be found');
        assert.strictEqual(result.filePath, targetFile);
        assert.ok(captured.includes(blockedDir), `stderr should name the unreadable subdirectory, got:\n${captured}`);
      } finally {
        fs.chmodSync(blockedDir, 0o700);
      }
    });

    it('Fix 7 (a): a rollout file matching the id suffix but chmod 0o000 is still returned by filename match, and stderr names the unreadable file', async () => {
      if (process.getuid?.() === 0) {
        return;
      }
      const { sessionsDir } = freshCodexHome('unreadable-file');
      const targetId = '019eaa28-8e2d-73a2-840f-a00d6cc8795f';
      const targetFile = path.join(sessionsDir, `rollout-2026-06-08-${targetId}.jsonl`);
      fs.writeFileSync(targetFile, sessionMetaLine({ id: targetId }));
      fs.chmodSync(targetFile, 0o000);

      try {
        const result = await findCodexAgentFile(targetId);
        assert.ok(result, 'filename-suffix match must still return a location even though the file cannot be read');
        assert.strictEqual(result.filePath, targetFile);
        assert.ok(captured.includes(targetFile), `stderr should name the unreadable file, got:\n${captured}`);
      } finally {
        fs.chmodSync(targetFile, 0o700);
      }
    });

    it('Fix 7 (b): a rollout file whose first line is not JSON at all is reported with a parse reason', async () => {
      const { sessionsDir } = freshCodexHome('malformed-json');
      const badFile = path.join(sessionsDir, 'rollout-bad.jsonl');
      fs.writeFileSync(badFile, 'not json at all\n');
      // A second, unrelated valid file so the id lookup falls through both
      // loops without an early match (forces readCodexSessionMeta to run on
      // badFile in the id-fallback loop too).
      fs.writeFileSync(path.join(sessionsDir, 'rollout-ok.jsonl'), sessionMetaLine({ id: 'other-id' }));

      const result = await findCodexAgentFile('id-that-does-not-exist');
      assert.strictEqual(result, null);
      assert.ok(captured.includes(badFile), `stderr should name the malformed file, got:\n${captured}`);
    });

    it('Fix 7 (c) NEGATIVE: a rollout file whose first line is valid JSON with a different record type produces no stderr', async () => {
      const { sessionsDir } = freshCodexHome('turn-context-only');
      const filePath = path.join(sessionsDir, 'rollout-turn-context.jsonl');
      fs.writeFileSync(filePath, JSON.stringify({
        timestamp: '2026-06-08T16:14:05.250Z',
        type: 'turn_context',
        payload: { model: 'gpt-5.5', cwd: '/test/project' },
      }) + '\n');

      const result = await findCodexAgentFile('id-that-does-not-exist');
      assert.strictEqual(result, null);
      assert.strictEqual(captured, '', `A shape-mismatch (not session_meta) must not be reported as a skip, got:\n${captured}`);
    });
  });

  describe('findRecentCodexAgentFiles smoke test (post Fix 6/7 refactor)', () => {
    const CODEX_TEST_DIR = path.join(TEST_DIR, 'codex-recent-smoke');
    const originalEnv = { ...process.env };

    before(() => {
      fs.mkdirSync(CODEX_TEST_DIR, { recursive: true });
      process.env.CODEX_HOME = CODEX_TEST_DIR;
    });

    after(() => {
      fs.rmSync(CODEX_TEST_DIR, { recursive: true, force: true });
      process.env = originalEnv;
    });

    it('returns an empty array when the sessions directory does not exist, without emitting stderr', async () => {
      const originalWrite = process.stderr.write;
      let captured = '';
      process.stderr.write = ((msg: string | Uint8Array) => {
        captured += typeof msg === 'string' ? msg : msg.toString();
        return true;
      }) as typeof process.stderr.write;

      try {
        const result = await findRecentCodexAgentFiles(10);
        assert.deepStrictEqual(result, []);
        assert.strictEqual(captured, '', `A missing sessions dir (Codex never used) must stay silent, got:\n${captured}`);
      } finally {
        process.stderr.write = originalWrite;
      }
    });
  });
});
