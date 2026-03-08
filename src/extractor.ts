/**
 * Core extraction logic for agent metrics
 */

import * as fs from 'node:fs';
import * as readline from 'node:readline';
import type {
  AgentMetrics,
  TokenMetrics,
  ExecutionMetrics,
  RawAgentMessage,
  ContentBlock,
  ExtractOptions,
} from './types.js';
import { isToolUseBlock } from './types.js';
import {
  findAgentFile,
  formatDuration,
  formatNumber,
  calculateDuration,
} from './utils.js';

/**
 * Validate that a parsed object has the minimum required RawAgentMessage fields.
 *
 * This performs runtime validation after JSON.parse to ensure the data
 * matches the expected structure. We check only the fields that are
 * actually used during metrics extraction.
 *
 * @param obj - The parsed JSON object to validate
 * @returns true if the object has valid RawAgentMessage structure
 */
function hasStringProperty(obj: Record<string, unknown>, key: string): boolean {
  return typeof obj[key] === 'string';
}

function isValidAgentMessage(obj: unknown): obj is RawAgentMessage {
  if (!obj || typeof obj !== 'object') return false;
  const msg = obj as Record<string, unknown>; // safe: guarded by typeof check above

  // Required for all messages: timing and identification
  if (!hasStringProperty(msg, 'timestamp')) return false;
  if (!hasStringProperty(msg, 'type')) return false;

  // Required for first message: session metadata
  if (!hasStringProperty(msg, 'agentId')) return false;
  if (!hasStringProperty(msg, 'sessionId')) return false;
  if (!hasStringProperty(msg, 'slug')) return false;
  if (!hasStringProperty(msg, 'cwd')) return false;
  if (!hasStringProperty(msg, 'version')) return false;
  if (!hasStringProperty(msg, 'gitBranch')) return false;

  return true;
}

/**
 * Extract metrics from an agent session file
 *
 * @param agentId - The agent ID to extract metrics for
 * @param options - Extraction options
 * @returns AgentMetrics object or null if agent file not found
 */
export async function extractAgentMetrics(
  agentId: string,
  options: ExtractOptions = {}
): Promise<AgentMetrics | null> {
  // Find the agent file
  const location = findAgentFile(agentId, options.projectPath);
  if (!location) {
    return null;
  }

  return extractMetricsFromFile(location.filePath);
}

/**
 * Extract metrics directly from a file path
 *
 * @param filePath - Path to the agent JSONL file
 * @returns AgentMetrics object
 */
export async function extractMetricsFromFile(
  filePath: string
): Promise<AgentMetrics> {
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  // Accumulators
  let firstMessage: RawAgentMessage | null = null;
  let lastMessage: RawAgentMessage | null = null;
  const models = new Set<string>();

  // Token accumulators
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalCacheReadTokens = 0;

  // Execution accumulators
  let messageCount = 0;
  let toolUseCount = 0;
  const toolBreakdown: Record<string, number> = {};
  let errorCount = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;

    try {
      const parsed = JSON.parse(line);
      if (!isValidAgentMessage(parsed)) {
        process.stderr.write(`Warning: Skipping message with missing required fields in ${filePath}\n`);
        continue;
      }
      const message = parsed; // Now properly validated as RawAgentMessage
      messageCount++;

      // Track first and last messages for timing
      if (!firstMessage) {
        firstMessage = message;
      }
      lastMessage = message;

      // Track model
      if (message.message?.model) {
        models.add(message.message.model);
      }

      // Accumulate token usage
      if (message.message?.usage) {
        const usage = message.message.usage;
        totalInputTokens += usage.input_tokens || 0;
        totalOutputTokens += usage.output_tokens || 0;
        totalCacheCreationTokens += usage.cache_creation_input_tokens || 0;
        totalCacheReadTokens += usage.cache_read_input_tokens || 0;
      }

      // Count tool uses from assistant messages
      if (message.type === 'assistant' && message.message?.content && Array.isArray(message.message.content)) {
        const content = message.message.content;
        for (const block of content) {
          if (isToolUseBlock(block)) {
            toolUseCount++;
            const toolName = block.name || 'unknown';
            toolBreakdown[toolName] = (toolBreakdown[toolName] || 0) + 1;
          }
        }
      }

      // Count errors from tool results
      if (message.type === 'tool_result' && message.toolUseResult?.is_error) {
        errorCount++;
      }
    } catch (err) {
      // Log malformed lines so users have visibility into data issues
      process.stderr.write(`Warning: Skipping malformed JSONL line in ${filePath}: ${err instanceof Error ? err.message : 'parse error'}\n`);
      continue;
    }
  }

  // Handle empty or invalid files
  if (!firstMessage || !lastMessage) {
    throw new Error(`No valid messages found in ${filePath}`);
  }

  // Calculate timing
  const durationMs = calculateDuration(firstMessage.timestamp, lastMessage.timestamp);

  // Build token metrics
  const tokens: TokenMetrics = {
    input: totalInputTokens,
    output: totalOutputTokens,
    cache_creation: totalCacheCreationTokens,
    cache_read: totalCacheReadTokens,
    total_effective: totalInputTokens + totalCacheCreationTokens + totalOutputTokens,
    total_raw: totalInputTokens + totalOutputTokens + totalCacheCreationTokens + totalCacheReadTokens,
  };

  // Build execution metrics
  const execution: ExecutionMetrics = {
    message_count: messageCount,
    tool_use_count: toolUseCount,
    tool_breakdown: toolBreakdown,
    error_count: errorCount,
  };

  // Determine primary model (most commonly used)
  const model = models.size > 0 ? Array.from(models)[0] : 'unknown';

  // Build final metrics object
  const metrics: AgentMetrics = {
    agent_id: firstMessage.agentId,
    session_id: firstMessage.sessionId,
    slug: firstMessage.slug,
    model,
    git_branch: firstMessage.gitBranch,
    cwd: firstMessage.cwd,
    claude_code_version: firstMessage.version,
    start_time: firstMessage.timestamp,
    end_time: lastMessage.timestamp,
    duration_ms: durationMs,
    duration_formatted: formatDuration(durationMs),
    tokens,
    execution,
  };

  return metrics;
}

/**
 * Extract metrics for multiple agent IDs
 *
 * @param agentIds - Array of agent IDs to extract metrics for
 * @param options - Extraction options
 * @returns Map of agent ID to metrics (null if not found)
 */
export async function extractMultipleAgentMetrics(
  agentIds: string[],
  options: ExtractOptions = {}
): Promise<Map<string, AgentMetrics | null>> {
  const results = new Map<string, AgentMetrics | null>();

  for (const agentId of agentIds) {
    const metrics = await extractAgentMetrics(agentId, options);
    results.set(agentId, metrics);
  }

  return results;
}

/**
 * Format metrics as a human-readable summary
 *
 * @param metrics - AgentMetrics object
 * @returns Formatted summary string
 */
export function formatMetricsSummary(metrics: AgentMetrics): string {
  const lines: string[] = [
    `Agent Metrics: ${metrics.agent_id}`,
    '═'.repeat(50),
    '',
    '┌─ Identification',
    `│  Agent ID:    ${metrics.agent_id}`,
    `│  Session:     ${metrics.session_id.slice(0, 12)}...`,
    `│  Slug:        ${metrics.slug}`,
    '',
    '┌─ Context',
    `│  Model:       ${metrics.model}`,
    `│  Branch:      ${metrics.git_branch}`,
    `│  Version:     ${metrics.claude_code_version}`,
    '',
    '┌─ Timing',
    `│  Start:       ${metrics.start_time}`,
    `│  End:         ${metrics.end_time}`,
    `│  Duration:    ${metrics.duration_formatted} (${formatNumber(metrics.duration_ms)}ms)`,
    '',
    '┌─ Tokens',
    `│  Input:       ${formatNumber(metrics.tokens.input)}`,
    `│  Output:      ${formatNumber(metrics.tokens.output)}`,
    `│  Cache Create:${formatNumber(metrics.tokens.cache_creation)}`,
    `│  Cache Read:  ${formatNumber(metrics.tokens.cache_read)}`,
    `│  ─────────────`,
    `│  Effective:   ${formatNumber(metrics.tokens.total_effective)} (excl. cache reads)`,
    `│  Raw Total:   ${formatNumber(metrics.tokens.total_raw)}`,
    '',
    '┌─ Execution',
    `│  Messages:    ${formatNumber(metrics.execution.message_count)}`,
    `│  Tool Uses:   ${formatNumber(metrics.execution.tool_use_count)}`,
    `│  Errors:      ${formatNumber(metrics.execution.error_count)}`,
    '',
    '┌─ Tool Breakdown',
  ];

  // Add tool breakdown
  const sortedTools = Object.entries(metrics.execution.tool_breakdown)
    .sort(([, a], [, b]) => b - a);

  for (const [tool, count] of sortedTools) {
    lines.push(`│  ${tool}: ${formatNumber(count)}`);
  }

  return lines.join('\n');
}

/**
 * Tracker-compatible token format with full cache breakdown
 */
export interface TrackerTokens {
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  total_effective_tokens: number;
}

/**
 * Tracker-compatible metrics format
 */
export interface TrackerFormat {
  name: string;
  model: string;
  tokens: TrackerTokens;
  duration_ms: number;
}

/**
 * Convert metrics to tracker-compatible format
 *
 * @param metrics - AgentMetrics object
 * @param validatorName - Name of the validator
 * @returns Object ready for validation tracker
 */
export function toTrackerFormat(
  metrics: AgentMetrics,
  validatorName: string
): TrackerFormat {
  return {
    name: validatorName,
    model: metrics.model,
    tokens: {
      input_tokens: metrics.tokens.input,
      output_tokens: metrics.tokens.output,
      cache_creation_tokens: metrics.tokens.cache_creation,
      cache_read_tokens: metrics.tokens.cache_read,
      total_effective_tokens: metrics.tokens.total_effective,
    },
    duration_ms: metrics.duration_ms,
  };
}
