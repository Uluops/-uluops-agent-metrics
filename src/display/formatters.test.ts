/**
 * Display Formatters Tests
 *
 * Tests for CLI display formatting functions.
 * All formatters return strings for testability.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  formatBufferStatus,
  formatBufferList,
  formatBufferSession,
  formatReport,
  formatAgentList,
  formatAgentListError,
  formatAgentCompare,
  formatLogStatus,
  type AgentListItem,
  type CompareItem,
  type LogDisplayStats,
} from './formatters.js';
import type { BufferEntry } from '../buffer.js';
import type { AgentMetrics } from '../types.js';

// Test configuration with isolated temp directory
const TEST_DIR = path.join(os.tmpdir(), 'agent-metrics-formatters-test-' + Date.now());
const MOCK_BUFFER_PATH = path.join(TEST_DIR, 'test-buffer.jsonl');

/**
 * Create a mock AgentMetrics object for testing
 */
function createMockMetrics(overrides: Partial<AgentMetrics> = {}): AgentMetrics {
  return {
    agent_id: 'abc1234',
    session_id: 'session-123',
    slug: 'test-session',
    model: 'claude-sonnet-4-5-20250929',
    git_branch: 'main',
    cwd: '/test/project',
    claude_code_version: '1.0.0',
    prompt_id: null,
    start_time: '2026-01-09T10:00:00.000Z',
    end_time: '2026-01-09T10:05:00.000Z',
    duration_ms: 300000,
    duration_formatted: '5m 0s',
    tokens: {
      input: 1000,
      output: 500,
      cache_creation: 200,
      cache_read: 5000,
      total_effective: 1700,
      total_raw: 6700,
    },
    execution: {
      message_count: 10,
      tool_use_count: 5,
      tool_breakdown: { Read: 3, Bash: 2 },
      error_count: 0,
    },
    ...overrides,
  };
}

/**
 * Create a mock BufferEntry for testing
 */
function createMockBufferEntry(overrides: Partial<BufferEntry> = {}): BufferEntry {
  const metrics = overrides.metrics || createMockMetrics();
  return {
    agent_id: 'abc1234',
    session_id: 'session-123',
    captured_at: '2026-01-09T10:05:00.000Z',
    end_time: metrics.end_time,
    expires_at: '2026-01-10T10:05:00.000Z',
    metrics,
    agent_name: 'test-agent',
    project_path: '/home/user/test-project',
    ...overrides,
  };
}

describe('Display Formatters', () => {
  before(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  after(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('formatBufferStatus', () => {
    it('should include title and all expected fields', () => {
      const result = formatBufferStatus('Test Buffer Status');

      assert.ok(result.includes('Test Buffer Status'), 'Should include the title');
      assert.ok(result.includes('Total entries:'), 'Should include total entries');
      assert.ok(result.includes('Valid entries:'), 'Should include valid entries');
      assert.ok(result.includes('Expired entries:'), 'Should include expired entries');
      assert.ok(result.includes('Unique sessions:'), 'Should include unique sessions');
      assert.ok(result.includes('Unique agents:'), 'Should include unique agents');
      assert.ok(result.includes('Buffer size:'), 'Should include buffer size');
      assert.ok(result.includes('KB'), 'Should show size in KB');
    });

    it('should include separator line', () => {
      const result = formatBufferStatus('Status');
      assert.ok(result.includes('═'), 'Should include separator line');
    });
  });

  describe('formatBufferList', () => {
    it('should return message for empty entries', () => {
      const result = formatBufferList([]);
      assert.strictEqual(result, 'No buffered entries found.');
    });

    it('should format entries as table', () => {
      const entries = [createMockBufferEntry()];
      const result = formatBufferList(entries);

      assert.ok(result.includes('Buffered Metrics'));
      assert.ok(result.includes('Agent ID'));
      assert.ok(result.includes('Agent Name'));
      assert.ok(result.includes('abc1234'));
      assert.ok(result.includes('test-agent'));
      assert.ok(result.includes('Total: 1 entries'));
    });

    it('should truncate long agent names', () => {
      const entries = [
        createMockBufferEntry({
          agent_name: 'this-is-a-very-long-agent-name-that-should-be-truncated-here',
        }),
      ];
      const result = formatBufferList(entries);

      // Should be truncated to 25 chars
      assert.ok(result.includes('this-is-a-very-long-agent'));
      assert.ok(!result.includes('truncated-here'));
    });

    it('should handle missing agent name', () => {
      const entries = [createMockBufferEntry({ agent_name: undefined })];
      const result = formatBufferList(entries);

      assert.ok(result.includes('unknown'));
    });
  });

  describe('formatBufferSession', () => {
    it('should return message for empty session', () => {
      const result = formatBufferSession('session-123', []);
      assert.strictEqual(result, 'No buffered entries found for session: session-123');
    });

    it('should format session entries with totals', () => {
      const entries = [
        createMockBufferEntry({ agent_id: 'agent1' }),
        createMockBufferEntry({ agent_id: 'agent2' }),
      ];
      const result = formatBufferSession('session-123', entries);

      assert.ok(result.includes('Session: session-123'));
      assert.ok(result.includes('agent1'));
      assert.ok(result.includes('agent2'));
      assert.ok(result.includes('TOTAL'));
    });
  });

  describe('formatReport', () => {
    it('should return message for no metrics', () => {
      const result = formatReport([]);
      assert.strictEqual(result, 'No metrics captured yet.');
    });

    it('should format report with model and project', () => {
      const entries = [createMockBufferEntry()];
      const result = formatReport(entries);

      assert.ok(result.includes('Recent Agent Metrics'));
      assert.ok(result.includes('Model'));
      assert.ok(result.includes('sonnet-4-5')); // Formatted model name
      assert.ok(result.includes('Tools'));
      assert.ok(result.includes('TOTAL'));
      assert.ok(result.includes('Showing 1 entries'));
    });

    it('should calculate totals correctly', () => {
      const entries = [
        createMockBufferEntry({
          metrics: createMockMetrics({ duration_ms: 60000, tokens: { input: 500, output: 300, cache_creation: 200, cache_read: 0, total_effective: 1000, total_raw: 1000 } }),
        }),
        createMockBufferEntry({
          metrics: createMockMetrics({ duration_ms: 120000, tokens: { input: 1000, output: 600, cache_creation: 400, cache_read: 0, total_effective: 2000, total_raw: 2000 } }),
        }),
      ];
      const result = formatReport(entries);

      assert.ok(result.includes('TOTAL'));
      assert.ok(result.includes('3m')); // 60s + 120s = 180s = 3m
      assert.ok(result.includes('3.0k')); // 1000 + 2000 = 3000 tokens
    });
  });

  describe('formatAgentList', () => {
    it('should return message for empty list', () => {
      const result = formatAgentList([]);
      assert.strictEqual(result, 'No agent files found.');
    });

    it('should format agent list items', () => {
      const items: AgentListItem[] = [
        { agentId: 'abc1234', metrics: createMockMetrics(), projectName: 'test-project' },
      ];
      const result = formatAgentList(items);

      assert.ok(result.includes('Recent Agent Runs'));
      assert.ok(result.includes('abc1234'));
      assert.ok(result.includes('test-project'));
      assert.ok(result.includes('tools'));
      assert.ok(result.includes('agent-metrics extract'));
    });
  });

  describe('formatAgentListError', () => {
    it('should format error line correctly', () => {
      const result = formatAgentListError('abc1234', 'test-project');
      assert.ok(result.includes('abc1234'));
      assert.ok(result.includes('error reading file'));
      assert.ok(result.includes('test-project'));
    });
  });

  describe('formatAgentCompare', () => {
    it('should format comparison table', () => {
      const items: CompareItem[] = [
        { agentId: 'agent1', metrics: createMockMetrics({ agent_id: 'agent1' }) },
        { agentId: 'agent2', metrics: createMockMetrics({ agent_id: 'agent2' }) },
      ];
      const result = formatAgentCompare(items);

      assert.ok(result.includes('Agent Comparison'));
      assert.ok(result.includes('agent1'));
      assert.ok(result.includes('agent2'));
      assert.ok(result.includes('Effective'));
      assert.ok(result.includes('Errors'));
      assert.ok(result.includes('TOTAL'));
    });

    it('should handle missing metrics', () => {
      const items: CompareItem[] = [
        { agentId: 'missing', metrics: null },
      ];
      const result = formatAgentCompare(items);

      assert.ok(result.includes('missing'));
      assert.ok(result.includes('not found'));
    });

    it('should calculate totals excluding missing agents', () => {
      const items: CompareItem[] = [
        { agentId: 'agent1', metrics: createMockMetrics({ duration_ms: 60000 }) },
        { agentId: 'missing', metrics: null },
        { agentId: 'agent2', metrics: createMockMetrics({ duration_ms: 60000 }) },
      ];
      const result = formatAgentCompare(items);

      assert.ok(result.includes('TOTAL'));
      assert.ok(result.includes('2m')); // Only valid agents contribute to total
    });
  });

  describe('formatLogStatus', () => {
    it('should format log status for existing file', () => {
      const stats: LogDisplayStats = {
        logPath: '/home/user/.claude/agent-metrics.log',
        enabled: true,
        minLevel: 'info',
        maxFileSize: 10 * 1024 * 1024,
        maxFiles: 5,
        exists: true,
        sizeBytes: 1024,
        lineCount: 50,
        rotatedFiles: 2,
        oldestEntry: '2026-01-08T10:00:00Z',
        newestEntry: '2026-01-09T10:00:00Z',
      };
      const result = formatLogStatus(stats);

      assert.ok(result.includes('Agent Metrics Log Status'));
      assert.ok(result.includes('/home/user/.claude/agent-metrics.log'));
      assert.ok(result.includes('Logging enabled:   true'));
      assert.ok(result.includes('Min level:         info'));
      assert.ok(result.includes('File exists:       true'));
      assert.ok(result.includes('File size:         1.0 KB'));
      assert.ok(result.includes('Line count:        50'));
      assert.ok(result.includes('Oldest entry:'));
      assert.ok(result.includes('Newest entry:'));
    });

    it('should format log status for non-existent file', () => {
      const stats: LogDisplayStats = {
        logPath: '/home/user/.claude/agent-metrics.log',
        enabled: false,
        minLevel: 'warn',
        maxFileSize: 5 * 1024 * 1024,
        maxFiles: 3,
        exists: false,
        sizeBytes: 0,
        lineCount: 0,
        rotatedFiles: 0,
        oldestEntry: null,
        newestEntry: null,
      };
      const result = formatLogStatus(stats);

      assert.ok(result.includes('File exists:       false'));
      assert.ok(!result.includes('File size:'));
      assert.ok(!result.includes('Line count:'));
    });
  });
});
