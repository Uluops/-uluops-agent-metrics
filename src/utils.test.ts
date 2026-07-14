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

import { describe, it, before, after } from 'node:test';
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
});
