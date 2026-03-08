/**
 * Shared Test Utilities
 *
 * Common test factories, fixtures, and constants used across test files.
 * Centralizes test data creation to ensure consistency and reduce duplication.
 */

import type { AgentMetrics } from './types.js';

// ============================================================================
// Test Constants
// ============================================================================

/** Default test model name */
export const TEST_MODEL = 'claude-sonnet-4-5-20250929';

/** Default test session ID prefix */
export const TEST_SESSION_PREFIX = 'test-session';

/** Default test agent ID prefix */
export const TEST_AGENT_PREFIX = 'test-agent';

/** Default TTL for test buffer entries (1 minute) */
export const TEST_TTL_MS = 60_000;

/** Default test duration in milliseconds */
export const TEST_DURATION_MS = 1_000;

/** Standard test token counts */
export const TEST_TOKENS = {
  input: 100,
  output: 50,
  cache_creation: 200,
  cache_read: 500,
  total_effective: 350,
  total_raw: 850,
} as const;

/** Standard test execution metrics */
export const TEST_EXECUTION = {
  message_count: 10,
  tool_use_count: 5,
  tool_breakdown: { Read: 3, Edit: 2 },
  error_count: 0,
} as const;

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Generate a random ID suffix for test uniqueness.
 */
export function randomId(): string {
  return Math.random().toString(36).slice(2, 8);
}

/**
 * Create test AgentMetrics with sensible defaults.
 * All values can be overridden via the overrides parameter.
 *
 * @param overrides - Partial AgentMetrics to override defaults
 * @returns Complete AgentMetrics object
 */
export function createTestMetrics(overrides: Partial<AgentMetrics> = {}): AgentMetrics {
  return {
    agent_id: `${TEST_AGENT_PREFIX}-${randomId()}`,
    session_id: `${TEST_SESSION_PREFIX}-${randomId()}`,
    slug: 'test-slug',
    model: TEST_MODEL,
    git_branch: 'main',
    cwd: '/test/path',
    claude_code_version: '2.0.0',
    start_time: new Date().toISOString(),
    end_time: new Date().toISOString(),
    duration_ms: TEST_DURATION_MS,
    duration_formatted: '1s',
    tokens: { ...TEST_TOKENS },
    execution: { ...TEST_EXECUTION },
    ...overrides,
  };
}

/**
 * Create JSONL content for a valid agent session file.
 * Used for testing extractors that read agent session files.
 *
 * @param agentId - Agent ID to use
 * @param sessionId - Session ID to use
 * @param baseTime - Base timestamp (defaults to now)
 * @returns JSONL string with user and assistant messages
 */
export function createAgentJSONL(
  agentId: string,
  sessionId: string,
  baseTime: number = Date.now()
): string {
  const lines = [
    JSON.stringify({
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
      message: { role: 'user', content: [{ type: 'text', text: 'Test' }] },
      uuid: 'uuid-1',
      timestamp: new Date(baseTime).toISOString(),
    }),
    JSON.stringify({
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
        content: [{ type: 'text', text: 'Response' }],
        model: TEST_MODEL,
        usage: {
          input_tokens: TEST_TOKENS.input,
          output_tokens: TEST_TOKENS.output,
          cache_creation_input_tokens: TEST_TOKENS.cache_creation,
          cache_read_input_tokens: TEST_TOKENS.cache_read,
        },
      },
      uuid: 'uuid-2',
      timestamp: new Date(baseTime + TEST_DURATION_MS).toISOString(),
    }),
  ];
  return lines.join('\n');
}

/**
 * Base message fields required by all raw agent messages.
 * Used in extractor tests to ensure fixtures have all required fields.
 */
export const BASE_MESSAGE = {
  sessionId: 'test-session',
  agentId: 'test-agent',
  cwd: '/test',
  version: '2.1.0',
  gitBranch: 'main',
  slug: 'test-session',
} as const;
