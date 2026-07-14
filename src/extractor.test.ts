/**
 * Extractor Module Tests
 *
 * Tests for extracting metrics from Claude Code agent JSONL files.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  extractMetricsFromFile,
  extractAgentMetrics,
  extractMultipleAgentMetrics,
  formatMetricsSummary,
  toTrackerFormat,
} from './extractor.js';
import { BASE_MESSAGE, createTestMetrics } from './test-utils.js';

// Test configuration with isolated temp directory
const TEST_DIR = path.join(os.tmpdir(), 'agent-metrics-extractor-test-' + Date.now());

// Sample JSONL content representing a minimal agent session
function createSampleJSONL(options: {
  agentId?: string;
  sessionId?: string;
  messageCount?: number;
  includeToolUse?: boolean;
  includeError?: boolean;
} = {}): string {
  const agentId = options.agentId || 'test-agent-123';
  const sessionId = options.sessionId || 'session-uuid-456';
  const baseTime = Date.now();

  const lines: string[] = [];

  // First message (user)
  lines.push(JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    userType: 'external',
    cwd: '/test/project',
    sessionId,
    version: '2.1.0',
    gitBranch: 'main',
    agentId,
    slug: 'test-session',
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'Test message' }],
    },
    uuid: 'uuid-1',
    timestamp: new Date(baseTime).toISOString(),
  }));

  // Assistant response with usage
  lines.push(JSON.stringify({
    parentUuid: 'uuid-1',
    isSidechain: false,
    userType: 'external',
    cwd: '/test/project',
    sessionId,
    version: '2.1.0',
    gitBranch: 'main',
    agentId,
    slug: 'test-session',
    type: 'assistant',
    message: {
      role: 'assistant',
      content: options.includeToolUse ? [
        { type: 'text', text: 'Let me read that file.' },
        { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/test/file.ts' } },
      ] : [
        { type: 'text', text: 'Here is my response.' },
      ],
      model: 'claude-sonnet-4-5-20250929',
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 2000,
        cache_read_input_tokens: 5000,
      },
    },
    uuid: 'uuid-2',
    timestamp: new Date(baseTime + 1000).toISOString(),
  }));

  // Tool result (if tool use included)
  if (options.includeToolUse) {
    lines.push(JSON.stringify({
      parentUuid: 'uuid-2',
      isSidechain: false,
      userType: 'external',
      cwd: '/test/project',
      sessionId,
      version: '2.1.0',
      gitBranch: 'main',
      agentId,
      slug: 'test-session',
      type: 'tool_result',
      toolUseResult: {
        is_error: options.includeError || false,
        content: options.includeError ? 'File not found' : 'File contents here',
      },
      uuid: 'uuid-3',
      timestamp: new Date(baseTime + 2000).toISOString(),
    }));
  }

  // Additional messages if requested
  const msgCount = options.messageCount || 3;
  for (let i = lines.length; i < msgCount; i++) {
    lines.push(JSON.stringify({
      parentUuid: `uuid-${i}`,
      isSidechain: false,
      userType: 'external',
      cwd: '/test/project',
      sessionId,
      version: '2.1.0',
      gitBranch: 'main',
      agentId,
      slug: 'test-session',
      type: i % 2 === 0 ? 'user' : 'assistant',
      message: {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: [{ type: 'text', text: `Message ${i}` }],
        ...(i % 2 === 1 ? {
          model: 'claude-sonnet-4-5-20250929',
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 200,
          },
        } : {}),
      },
      uuid: `uuid-${i + 1}`,
      timestamp: new Date(baseTime + i * 1000).toISOString(),
    }));
  }

  return lines.join('\n');
}

describe('Extractor Module', () => {
  const originalEnv = { ...process.env };

  before(() => {
    // Create test directory
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  after(() => {
    // Cleanup test directory
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    process.env = originalEnv;
  });

  describe('extractMetricsFromFile', () => {
    it('should extract metrics from valid JSONL file', async () => {
      const filePath = path.join(TEST_DIR, 'valid-session.jsonl');
      fs.writeFileSync(filePath, createSampleJSONL());

      const metrics = await extractMetricsFromFile(filePath);

      assert.ok(metrics);
      assert.strictEqual(metrics.harness, 'claude-code');
      assert.strictEqual(metrics.agent_id, 'test-agent-123');
      assert.strictEqual(metrics.session_id, 'session-uuid-456');
      assert.strictEqual(metrics.model, 'claude-sonnet-4-5-20250929');
      assert.strictEqual(metrics.git_branch, 'main');
      assert.strictEqual(metrics.cwd, '/test/project');
    });

    it('should accumulate token usage correctly', async () => {
      const filePath = path.join(TEST_DIR, 'token-test.jsonl');
      fs.writeFileSync(filePath, createSampleJSONL({ messageCount: 5 }));

      const metrics = await extractMetricsFromFile(filePath);

      // First assistant message: 1000 input, 500 output, 2000 cache creation, 5000 cache read
      // Additional messages add 100 input, 50 output per assistant message
      assert.ok(metrics.tokens.input >= 1000);
      assert.ok(metrics.tokens.output >= 500);
      assert.ok(metrics.tokens.cache_creation >= 2000);
      assert.ok(metrics.tokens.cache_read >= 5000);

      // Verify effective and raw totals are calculated correctly
      assert.strictEqual(
        metrics.tokens.total_effective,
        metrics.tokens.input + metrics.tokens.cache_creation + metrics.tokens.output
      );
      assert.strictEqual(
        metrics.tokens.total_raw,
        metrics.tokens.input + metrics.tokens.output + metrics.tokens.cache_creation + metrics.tokens.cache_read
      );
    });

    it('should handle assistant messages without usage field', async () => {
      // Test that undefined usage field doesn't break extraction
      const baseTime = Date.now();
      const lines = [
        JSON.stringify({
          ...BASE_MESSAGE,
          type: 'user',
          message: { role: 'user', content: 'test' },
          timestamp: new Date(baseTime).toISOString(),
        }),
        // Assistant message WITHOUT usage field
        JSON.stringify({
          ...BASE_MESSAGE,
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Response without usage' }],
            model: 'claude-sonnet-4-5-20250929',
            // No usage field
          },
          timestamp: new Date(baseTime + 1000).toISOString(),
        }),
        // Another assistant WITH usage
        JSON.stringify({
          ...BASE_MESSAGE,
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Response with usage' }],
            model: 'claude-sonnet-4-5-20250929',
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
          timestamp: new Date(baseTime + 2000).toISOString(),
        }),
      ];

      const filePath = path.join(TEST_DIR, 'undefined-usage-test.jsonl');
      fs.writeFileSync(filePath, lines.join('\n'));

      const metrics = await extractMetricsFromFile(filePath);

      // Should only count tokens from the message that has usage
      assert.strictEqual(metrics.tokens.input, 100, 'Should only count defined usage');
      assert.strictEqual(metrics.tokens.output, 50, 'Should only count defined usage');
      assert.strictEqual(metrics.execution.message_count, 3, 'Should count all messages');
    });

    it('should count tool uses correctly', async () => {
      const filePath = path.join(TEST_DIR, 'tool-use-test.jsonl');
      fs.writeFileSync(filePath, createSampleJSONL({ includeToolUse: true }));

      const metrics = await extractMetricsFromFile(filePath);

      assert.strictEqual(metrics.execution.tool_use_count, 1);
      assert.strictEqual(metrics.execution.tool_breakdown['Read'], 1);
    });

    it('should count errors correctly', async () => {
      const filePath = path.join(TEST_DIR, 'error-test.jsonl');
      fs.writeFileSync(filePath, createSampleJSONL({ includeToolUse: true, includeError: true }));

      const metrics = await extractMetricsFromFile(filePath);

      assert.strictEqual(metrics.execution.error_count, 1);
    });

    it('should NOT count is_error: false as an error (false-positive prevention)', async () => {
      // This test verifies that tool results with is_error: false don't increment error_count
      // Regression test for false-positive error detection
      const baseTime = Date.now();
      const lines = [
        JSON.stringify({
          ...BASE_MESSAGE,
          type: 'user',
          message: { role: 'user', content: 'test' },
          timestamp: new Date(baseTime).toISOString(),
        }),
        JSON.stringify({
          ...BASE_MESSAGE,
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Reading file' },
              { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/test/file.ts' } },
            ],
            model: 'claude-sonnet-4-5-20250929',
            usage: { input_tokens: 100, output_tokens: 50 },
          },
          timestamp: new Date(baseTime + 1000).toISOString(),
        }),
        // Tool result with explicit is_error: false
        JSON.stringify({
          ...BASE_MESSAGE,
          type: 'tool_result',
          toolUseResult: {
            is_error: false, // Explicit false - should NOT count as error
            content: 'File contents here',
          },
          timestamp: new Date(baseTime + 2000).toISOString(),
        }),
      ];

      const filePath = path.join(TEST_DIR, 'false-positive-error-test.jsonl');
      fs.writeFileSync(filePath, lines.join('\n'));

      const metrics = await extractMetricsFromFile(filePath);

      assert.strictEqual(
        metrics.execution.error_count,
        0,
        'is_error: false should NOT increment error_count'
      );
    });

    it('should NOT count missing is_error field as an error', async () => {
      // Tool results without is_error field should default to non-error
      const baseTime = Date.now();
      const lines = [
        JSON.stringify({
          ...BASE_MESSAGE,
          type: 'user',
          message: { role: 'user', content: 'test' },
          timestamp: new Date(baseTime).toISOString(),
        }),
        JSON.stringify({
          ...BASE_MESSAGE,
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} },
            ],
            model: 'claude-sonnet-4-5-20250929',
            usage: { input_tokens: 100, output_tokens: 50 },
          },
          timestamp: new Date(baseTime + 1000).toISOString(),
        }),
        // Tool result without is_error field
        JSON.stringify({
          ...BASE_MESSAGE,
          type: 'tool_result',
          toolUseResult: {
            // No is_error field at all
            content: 'Success result',
          },
          timestamp: new Date(baseTime + 2000).toISOString(),
        }),
      ];

      const filePath = path.join(TEST_DIR, 'missing-is-error-test.jsonl');
      fs.writeFileSync(filePath, lines.join('\n'));

      const metrics = await extractMetricsFromFile(filePath);

      assert.strictEqual(
        metrics.execution.error_count,
        0,
        'Missing is_error field should NOT count as error'
      );
    });

    it('should only count tool_use blocks, not text blocks (tool type verification)', async () => {
      // This test verifies that only blocks with type: 'tool_use' are counted
      // Text blocks should NOT be counted as tool uses
      const baseTime = Date.now();
      const lines = [
        JSON.stringify({
          ...BASE_MESSAGE,
          type: 'user',
          message: { role: 'user', content: 'test' },
          timestamp: new Date(baseTime).toISOString(),
        }),
        JSON.stringify({
          ...BASE_MESSAGE,
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'First I will explain something.' },
              { type: 'text', text: 'Then I will explain more.' },
              { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/a.ts' } },
              { type: 'text', text: 'Now reading another file.' },
              { type: 'tool_use', id: 'tool-2', name: 'Grep', input: { pattern: 'test' } },
            ],
            model: 'claude-sonnet-4-5-20250929',
            usage: { input_tokens: 100, output_tokens: 50 },
          },
          timestamp: new Date(baseTime + 1000).toISOString(),
        }),
      ];

      const filePath = path.join(TEST_DIR, 'tool-type-check-test.jsonl');
      fs.writeFileSync(filePath, lines.join('\n'));

      const metrics = await extractMetricsFromFile(filePath);

      // Should only count actual tool_use blocks (2), not text blocks (3)
      assert.strictEqual(
        metrics.execution.tool_use_count,
        2,
        'Should only count tool_use blocks, not text blocks'
      );
      assert.strictEqual(metrics.execution.tool_breakdown['Read'], 1);
      assert.strictEqual(metrics.execution.tool_breakdown['Grep'], 1);
      assert.strictEqual(
        metrics.execution.tool_breakdown['text'],
        undefined,
        'Text blocks should NOT appear in tool breakdown'
      );
    });

    it('should handle mixed content blocks correctly', async () => {
      // Comprehensive test with various block types
      const baseTime = Date.now();
      const lines = [
        JSON.stringify({
          ...BASE_MESSAGE,
          type: 'user',
          message: { role: 'user', content: 'test' },
          timestamp: new Date(baseTime).toISOString(),
        }),
        JSON.stringify({
          ...BASE_MESSAGE,
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Thinking...' },
              { type: 'tool_use', id: 't1', name: 'Read', input: {} },
              { type: 'tool_use', id: 't2', name: 'Read', input: {} },
              { type: 'tool_use', id: 't3', name: 'Bash', input: {} },
            ],
            model: 'claude-sonnet-4-5-20250929',
            usage: { input_tokens: 100, output_tokens: 50 },
          },
          timestamp: new Date(baseTime + 1000).toISOString(),
        }),
      ];

      const filePath = path.join(TEST_DIR, 'mixed-content-blocks-test.jsonl');
      fs.writeFileSync(filePath, lines.join('\n'));

      const metrics = await extractMetricsFromFile(filePath);

      assert.strictEqual(metrics.execution.tool_use_count, 3, 'Should count 3 tool_use blocks');
      assert.strictEqual(metrics.execution.tool_breakdown['Read'], 2, 'Read should be used twice');
      assert.strictEqual(metrics.execution.tool_breakdown['Bash'], 1, 'Bash should be used once');
    });

    it('should calculate duration correctly', async () => {
      const filePath = path.join(TEST_DIR, 'duration-test.jsonl');
      fs.writeFileSync(filePath, createSampleJSONL({ messageCount: 5 }));

      const metrics = await extractMetricsFromFile(filePath);

      // 5 messages at 1000ms intervals: duration = (5-1) * 1000 = 4000ms
      assert.strictEqual(metrics.duration_ms, 4000, 'Duration should be 4000ms for 5 messages at 1s intervals');
      assert.strictEqual(typeof metrics.duration_formatted, 'string');
      assert.ok(metrics.duration_formatted.length > 0, 'Formatted duration should not be empty');
    });

    it('should handle empty file gracefully', async () => {
      const filePath = path.join(TEST_DIR, 'empty.jsonl');
      fs.writeFileSync(filePath, '');

      await assert.rejects(
        () => extractMetricsFromFile(filePath),
        /No valid messages found/
      );
    });

    it('should wrap missing file errors with package guidance', async () => {
      const filePath = path.join(TEST_DIR, 'missing-agent.jsonl');

      await assert.rejects(
        () => extractMetricsFromFile(filePath),
        /Unable to read agent metrics file/
      );
    });

    it('should handle file with only whitespace', async () => {
      const filePath = path.join(TEST_DIR, 'whitespace.jsonl');
      fs.writeFileSync(filePath, '   \n\n   \n');

      await assert.rejects(
        () => extractMetricsFromFile(filePath),
        /No valid messages found/
      );
    });

    it('should skip malformed lines and continue', async () => {
      const filePath = path.join(TEST_DIR, 'mixed-valid.jsonl');
      const validContent = createSampleJSONL();
      const lines = validContent.split('\n');
      // Insert malformed lines
      lines.splice(1, 0, 'not valid json');
      lines.splice(3, 0, '{ incomplete json');
      fs.writeFileSync(filePath, lines.join('\n'));

      // Should still extract metrics from valid lines
      const metrics = await extractMetricsFromFile(filePath);
      assert.ok(metrics);
      assert.strictEqual(metrics.agent_id, 'test-agent-123');
    });

    it('should handle file with only malformed lines', async () => {
      const filePath = path.join(TEST_DIR, 'all-malformed.jsonl');
      fs.writeFileSync(filePath, 'not json\nalso not json\n{broken');

      await assert.rejects(
        () => extractMetricsFromFile(filePath),
        /No valid messages found/
      );
    });

    it('should handle truncated JSON mid-value (partial string)', async () => {
      const filePath = path.join(TEST_DIR, 'truncated-string.jsonl');
      const validContent = createSampleJSONL();
      // Append a line that is valid JSON object but truncated mid-string
      fs.writeFileSync(filePath, validContent + '\n{"agentId":"trun');

      const metrics = await extractMetricsFromFile(filePath);
      assert.ok(metrics, 'Should still extract valid metrics despite truncated line');
      assert.strictEqual(metrics.agent_id, 'test-agent-123');
    });

    it('should handle lines with unicode replacement characters', async () => {
      const filePath = path.join(TEST_DIR, 'unicode-replacement.jsonl');
      const validContent = createSampleJSONL();
      // Append a line with unicode replacement characters
      fs.writeFileSync(filePath, validContent + '\n{"agent\uFFFD":"bad"}\n');

      const metrics = await extractMetricsFromFile(filePath);
      assert.ok(metrics, 'Should still extract valid metrics despite unicode-damaged line');
      assert.strictEqual(metrics.agent_id, 'test-agent-123');
    });

    it('should handle valid JSON objects missing required fields gracefully', async () => {
      const filePath = path.join(TEST_DIR, 'missing-fields.jsonl');
      const validContent = createSampleJSONL();
      // Append valid JSON but without required agent message fields
      const invalidLines = [
        '{"type":"assistant","timestamp":"2026-01-01T00:00:00Z"}', // missing agentId, sessionId, etc
        '{"agentId":"a","sessionId":"s","type":"user"}', // missing timestamp, cwd, version, gitBranch
      ].join('\n');
      fs.writeFileSync(filePath, validContent + '\n' + invalidLines + '\n');

      const warnings: string[] = [];
      const origWrite = process.stderr.write;
      process.stderr.write = ((chunk: string | Uint8Array) => {
        warnings.push(chunk.toString());
        return true;
      }) as typeof process.stderr.write;
      try {
        const metrics = await extractMetricsFromFile(filePath);
        assert.ok(metrics, 'Should extract valid metrics and skip invalid entries');
        assert.strictEqual(metrics.agent_id, 'test-agent-123');
        assert.ok(
          warnings.some((warning) => warning.includes('expected timestamp, type, agentId, sessionId, cwd, version, gitBranch')),
          'Should explain the expected minimum fields'
        );
      } finally {
        process.stderr.write = origWrite;
      }
    });

    it('should accept messages without slug (Claude Code 2.1.145+ format)', async () => {
      // Claude Code 2.1.145 dropped the `slug` field from subagent transcript messages.
      // The extractor must still parse these and fall back to agentId for the slug.
      const filePath = path.join(TEST_DIR, 'no-slug.jsonl');
      const slugless = JSON.stringify({
        type: 'assistant',
        timestamp: '2026-05-28T23:12:46.877Z',
        agentId: 'abc1234567890def0',
        sessionId: 'session-xyz',
        cwd: '/tmp',
        version: '2.1.145',
        gitBranch: 'main',
        message: {
          role: 'assistant',
          content: [],
          model: 'claude-opus-4-7',
          usage: { input_tokens: 10, output_tokens: 20 },
        },
      });
      fs.writeFileSync(filePath, slugless + '\n' + slugless + '\n');

      const metrics = await extractMetricsFromFile(filePath);
      assert.ok(metrics, 'Should extract metrics from slug-less transcript');
      assert.strictEqual(metrics.agent_id, 'abc1234567890def0');
      assert.strictEqual(metrics.slug, 'abc1234567890def0', 'slug should fall back to agentId');
      assert.strictEqual(metrics.claude_code_version, '2.1.145');
    });

    it('should count message count correctly', async () => {
      const filePath = path.join(TEST_DIR, 'count-test.jsonl');
      fs.writeFileSync(filePath, createSampleJSONL({ messageCount: 10 }));

      const metrics = await extractMetricsFromFile(filePath);

      assert.strictEqual(metrics.execution.message_count, 10);
    });
  });

  describe('extractAgentMetrics provider dispatch', () => {
    it('routes UUIDv7 agent IDs to Codex in auto mode', async () => {
      const codexHome = path.join(TEST_DIR, 'codex-home');
      const sessionsDir = path.join(codexHome, 'sessions', '2026', '06', '08');
      const agentId = '019eaa28-8e2d-73a2-840f-a00d6cc8795f';
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.writeFileSync(path.join(sessionsDir, `rollout-2026-06-08T16-14-05-${agentId}.jsonl`), [
        JSON.stringify({
          timestamp: '2026-06-08T16:14:05.000Z',
          type: 'session_meta',
          payload: {
            id: agentId,
            parent_thread_id: '019eaa27-f755-7cb2-84fa-bd1aa685d69e',
            cwd: '/test/project',
            cli_version: '0.137.0',
            thread_source: 'subagent',
            timestamp: '2026-06-08T16:14:05.000Z',
          },
        }),
        JSON.stringify({
          timestamp: '2026-06-08T16:14:06.000Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 10,
                cached_input_tokens: 2,
                output_tokens: 3,
                reasoning_output_tokens: 1,
                total_tokens: 14,
              },
            },
          },
        }),
        JSON.stringify({
          timestamp: '2026-06-08T16:14:07.000Z',
          type: 'event_msg',
          payload: { type: 'task_complete', duration_ms: 2000 },
        }),
      ].join('\n'));

      process.env.CODEX_HOME = codexHome;

      const metrics = await extractAgentMetrics(agentId);

      assert.ok(metrics);
      assert.strictEqual(metrics.harness, 'codex');
      // (input − cached_input) + output = (10 − 2) + 3 = 11. reasoning_output (1) is a
      // subset of gross output and is NOT added (was the +reasoning double-count). §3.3.
      assert.strictEqual(metrics.tokens.total_effective, 11);
      assert.strictEqual(metrics.tokens.reasoning_output, 1);
    });

    it('routes non-UUIDv7 IDs to Claude in auto mode', async () => {
      const claudeHome = path.join(TEST_DIR, 'claude-home');
      const projectDir = path.join(claudeHome, '.claude', 'projects', '-test-project');
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'agent-abc1234.jsonl'), createSampleJSONL({ agentId: 'abc1234' }));
      process.env.HOME = claudeHome;

      const metrics = await extractAgentMetrics('abc1234');

      assert.ok(metrics);
      assert.strictEqual(metrics.harness, 'claude-code');
      assert.strictEqual(metrics.agent_id, 'abc1234');
    });

    it('honors explicit provider override', async () => {
      const metrics = await extractAgentMetrics('abc1234', { provider: 'codex' });

      assert.strictEqual(metrics, null);
    });
  });

  describe('formatMetricsSummary', () => {
    it('should format metrics as human-readable summary', async () => {
      const filePath = path.join(TEST_DIR, 'format-test.jsonl');
      fs.writeFileSync(filePath, createSampleJSONL({ includeToolUse: true }));

      const metrics = await extractMetricsFromFile(filePath);
      const summary = formatMetricsSummary(metrics);

      // Verify exact section headers present
      assert.match(summary, /Agent Metrics: test-agent-123/);
      assert.match(summary, /┌─ Identification/);
      assert.match(summary, /┌─ Context/);
      assert.match(summary, /┌─ Timing/);
      assert.match(summary, /┌─ Tokens/);
      assert.match(summary, /┌─ Execution/);
      assert.match(summary, /┌─ Tool Breakdown/);
      assert.match(summary, /Read: /);
      // Verify model appears in context section
      assert.match(summary, /Model:\s+claude-sonnet-4-5-20250929/);
    });

    it('should include all token types', async () => {
      const filePath = path.join(TEST_DIR, 'token-format-test.jsonl');
      fs.writeFileSync(filePath, createSampleJSONL());

      const metrics = await extractMetricsFromFile(filePath);
      const summary = formatMetricsSummary(metrics);

      assert.ok(summary.includes('Input:'));
      assert.ok(summary.includes('Output:'));
      assert.ok(summary.includes('Cache Create:'));
      assert.ok(summary.includes('Cache Read:'));
      assert.ok(summary.includes('Effective:'));
      assert.ok(summary.includes('Raw Total:'));
    });
  });

  describe('toTrackerFormat', () => {
    it('should convert metrics to tracker-compatible format with full cache breakdown', async () => {
      const filePath = path.join(TEST_DIR, 'tracker-test.jsonl');
      fs.writeFileSync(filePath, createSampleJSONL());

      const metrics = await extractMetricsFromFile(filePath);
      const trackerFormat = toTrackerFormat(metrics, 'code-validator');

      assert.strictEqual(trackerFormat.name, 'code-validator');
      assert.strictEqual(trackerFormat.model, metrics.model);
      assert.strictEqual(trackerFormat.duration_ms, metrics.duration_ms);

      // Full token breakdown for validation tracker
      assert.strictEqual(trackerFormat.tokens.input_tokens, metrics.tokens.input);
      assert.strictEqual(trackerFormat.tokens.output_tokens, metrics.tokens.output);
      assert.strictEqual(trackerFormat.tokens.cache_creation_tokens, metrics.tokens.cache_creation);
      assert.strictEqual(trackerFormat.tokens.cache_read_tokens, metrics.tokens.cache_read);
      assert.strictEqual(trackerFormat.tokens.total_effective_tokens, metrics.tokens.total_effective);
    });

    it('carries harness + cross-harness components through the wire (§1.2 fix)', () => {
      const metrics = createTestMetrics({
        harness: 'codex',
        tokens: {
          input: 100, output: 50, cache_creation: 0, cache_read: 0,
          cached_input: 20, reasoning_output: 8, thinking: 0, tool: 3,
          total_effective: 130, total_raw: 158,
        },
      });

      const trackerFormat = toTrackerFormat(metrics, 'codex-agent');

      // Previously these died at the wire (§1.2) — now they survive.
      assert.strictEqual(trackerFormat.harness, 'codex');
      assert.strictEqual(trackerFormat.tokens.cached_input_tokens, 20);
      assert.strictEqual(trackerFormat.tokens.reasoning_output_tokens, 8);
      assert.strictEqual(trackerFormat.tokens.tool_tokens, 3);
    });
  });

  describe('Token Formula Verification', () => {
    /**
     * These tests explicitly verify the token calculation formulas:
     * - total_effective = input + cache_creation + output
     * - total_raw = input + output + cache_creation + cache_read
     *
     * This ensures mutations to the formulas would be caught.
     */

    it('should calculate total_effective as input + cache_creation + output', async () => {
      // Create a minimal JSONL with known token values
      const baseTime = Date.now();
      const lines = [
        JSON.stringify({
          ...BASE_MESSAGE,
          type: 'user',
          message: { role: 'user', content: 'test' },
          timestamp: new Date(baseTime).toISOString(),
        }),
        JSON.stringify({
          ...BASE_MESSAGE,
          type: 'assistant',
          message: {
            role: 'assistant',
            content: 'response',
            model: 'claude-sonnet-4-5-20250929',
            usage: {
              input_tokens: 1000,
              output_tokens: 500,
              cache_creation_input_tokens: 2000,
              cache_read_input_tokens: 5000,
            },
          },
          timestamp: new Date(baseTime + 1000).toISOString(),
        }),
      ];

      const filePath = path.join(TEST_DIR, 'formula-effective-test.jsonl');
      fs.writeFileSync(filePath, lines.join('\n'));

      const metrics = await extractMetricsFromFile(filePath);

      // Verify individual token values match what we set
      assert.strictEqual(metrics.tokens.input, 1000, 'Input tokens should be 1000');
      assert.strictEqual(metrics.tokens.output, 500, 'Output tokens should be 500');
      assert.strictEqual(metrics.tokens.cache_creation, 2000, 'Cache creation should be 2000');
      assert.strictEqual(metrics.tokens.cache_read, 5000, 'Cache read should be 5000');

      // Verify the formula: total_effective = input + cache_creation + output
      const expectedEffective = 1000 + 2000 + 500; // = 3500
      assert.strictEqual(
        metrics.tokens.total_effective,
        expectedEffective,
        `total_effective should be ${expectedEffective} (input + cache_creation + output)`
      );

      // Also verify it equals the sum of individual components
      assert.strictEqual(
        metrics.tokens.total_effective,
        metrics.tokens.input + metrics.tokens.cache_creation + metrics.tokens.output,
        'total_effective should equal input + cache_creation + output'
      );
    });

    it('should calculate total_raw as sum of all token types', async () => {
      const baseTime = Date.now();
      const lines = [
        JSON.stringify({
          ...BASE_MESSAGE,
          type: 'user',
          message: { role: 'user', content: 'test' },
          timestamp: new Date(baseTime).toISOString(),
        }),
        JSON.stringify({
          ...BASE_MESSAGE,
          type: 'assistant',
          message: {
            role: 'assistant',
            content: 'response',
            model: 'claude-sonnet-4-5-20250929',
            usage: {
              input_tokens: 100,
              output_tokens: 200,
              cache_creation_input_tokens: 300,
              cache_read_input_tokens: 400,
            },
          },
          timestamp: new Date(baseTime + 1000).toISOString(),
        }),
      ];

      const filePath = path.join(TEST_DIR, 'formula-raw-test.jsonl');
      fs.writeFileSync(filePath, lines.join('\n'));

      const metrics = await extractMetricsFromFile(filePath);

      // Verify the formula: total_raw = input + output + cache_creation + cache_read
      const expectedRaw = 100 + 200 + 300 + 400; // = 1000
      assert.strictEqual(
        metrics.tokens.total_raw,
        expectedRaw,
        `total_raw should be ${expectedRaw} (all token types summed)`
      );

      // Also verify it equals the sum
      assert.strictEqual(
        metrics.tokens.total_raw,
        metrics.tokens.input + metrics.tokens.output + metrics.tokens.cache_creation + metrics.tokens.cache_read,
        'total_raw should equal input + output + cache_creation + cache_read'
      );
    });

    it('should correctly exclude cache_read from total_effective', async () => {
      const baseTime = Date.now();
      const lines = [
        JSON.stringify({
          ...BASE_MESSAGE,
          type: 'user',
          message: { role: 'user', content: 'test' },
          timestamp: new Date(baseTime).toISOString(),
        }),
        JSON.stringify({
          ...BASE_MESSAGE,
          type: 'assistant',
          message: {
            role: 'assistant',
            content: 'response',
            model: 'claude-sonnet-4-5-20250929',
            usage: {
              input_tokens: 1000,
              output_tokens: 500,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 10000, // Large cache read that should NOT be in effective
            },
          },
          timestamp: new Date(baseTime + 1000).toISOString(),
        }),
      ];

      const filePath = path.join(TEST_DIR, 'cache-read-exclusion-test.jsonl');
      fs.writeFileSync(filePath, lines.join('\n'));

      const metrics = await extractMetricsFromFile(filePath);

      // cache_read should NOT be included in effective total
      assert.strictEqual(metrics.tokens.cache_read, 10000, 'Cache read should be 10000');
      assert.strictEqual(
        metrics.tokens.total_effective,
        1500, // Only input (1000) + output (500), no cache_creation
        'total_effective should NOT include cache_read'
      );

      // But total_raw should include it
      assert.strictEqual(
        metrics.tokens.total_raw,
        11500, // input (1000) + output (500) + cache_read (10000)
        'total_raw should include cache_read'
      );

      // Verify the difference is exactly cache_read
      assert.strictEqual(
        metrics.tokens.total_raw - metrics.tokens.total_effective,
        metrics.tokens.cache_read,
        'Difference between total_raw and total_effective should equal cache_read'
      );
    });

    it('should accumulate tokens across multiple assistant messages', async () => {
      const baseTime = Date.now();
      const lines = [
        JSON.stringify({
          ...BASE_MESSAGE,
          type: 'user',
          message: { role: 'user', content: 'test' },
          timestamp: new Date(baseTime).toISOString(),
        }),
        // First assistant message
        JSON.stringify({
          ...BASE_MESSAGE,
          type: 'assistant',
          message: {
            role: 'assistant',
            content: 'first response',
            model: 'claude-sonnet-4-5-20250929',
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              cache_creation_input_tokens: 200,
              cache_read_input_tokens: 0,
            },
          },
          timestamp: new Date(baseTime + 1000).toISOString(),
        }),
        JSON.stringify({
          ...BASE_MESSAGE,
          type: 'user',
          message: { role: 'user', content: 'continue' },
          timestamp: new Date(baseTime + 2000).toISOString(),
        }),
        // Second assistant message
        JSON.stringify({
          ...BASE_MESSAGE,
          type: 'assistant',
          message: {
            role: 'assistant',
            content: 'second response',
            model: 'claude-sonnet-4-5-20250929',
            usage: {
              input_tokens: 150,
              output_tokens: 75,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 200,
            },
          },
          timestamp: new Date(baseTime + 3000).toISOString(),
        }),
      ];

      const filePath = path.join(TEST_DIR, 'accumulate-test.jsonl');
      fs.writeFileSync(filePath, lines.join('\n'));

      const metrics = await extractMetricsFromFile(filePath);

      // Tokens should be accumulated across messages
      assert.strictEqual(metrics.tokens.input, 100 + 150, 'Input should accumulate');
      assert.strictEqual(metrics.tokens.output, 50 + 75, 'Output should accumulate');
      assert.strictEqual(metrics.tokens.cache_creation, 200 + 0, 'Cache creation should accumulate');
      assert.strictEqual(metrics.tokens.cache_read, 0 + 200, 'Cache read should accumulate');

      // Verify totals
      assert.strictEqual(
        metrics.tokens.total_effective,
        250 + 200 + 125, // input + cache_creation + output
        'total_effective should be sum of accumulated input + cache_creation + output'
      );
      assert.strictEqual(
        metrics.tokens.total_raw,
        250 + 125 + 200 + 200, // all tokens
        'total_raw should be sum of all accumulated tokens'
      );
    });
  });

  describe('extractMultipleAgentMetrics', () => {
    it('should return metrics for valid IDs and null for invalid', async () => {
      // Create a valid agent file
      const validFile = path.join(TEST_DIR, 'multi-valid.jsonl');
      fs.writeFileSync(validFile, createSampleJSONL({ agentId: 'abc123' }));

      // extractMultipleAgentMetrics searches by agent ID via findAgentFile,
      // which scans ~/.claude/projects. We test the parallel execution and
      // Map structure by passing IDs that won't be found (no mock projects dir)
      const results = await extractMultipleAgentMetrics(['nonexistent1', 'nonexistent2']);
      assert.ok(results instanceof Map);
      assert.strictEqual(results.size, 2);
      assert.strictEqual(results.get('nonexistent1'), null);
      assert.strictEqual(results.get('nonexistent2'), null);
    });

    it('should return empty map for empty input', async () => {
      const results = await extractMultipleAgentMetrics([]);
      assert.ok(results instanceof Map);
      assert.strictEqual(results.size, 0);
    });
  });
});
