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
import { extractCodexAgentMetrics } from './codex-extractor.js';

const CODEX_UUIDV7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REQUIRED_AGENT_MESSAGE_FIELDS = 'timestamp, type, agentId, sessionId, cwd, version, gitBranch';

function resolveProvider(agentId: string, provider: ExtractOptions['provider'] = 'auto'): 'claude' | 'codex' {
  if (provider === 'claude' || provider === 'codex') return provider;
  return CODEX_UUIDV7_PATTERN.test(agentId) ? 'codex' : 'claude';
}

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
  // `slug` was dropped from subagent transcripts in Claude Code 2.1.145; treat as optional
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
  if (resolveProvider(agentId, options.provider) === 'codex') {
    return extractCodexAgentMetrics(agentId);
  }

  // Find the agent file
  const location = findAgentFile(agentId, options.projectPath);
  if (!location) {
    return null;
  }

  return extractMetricsFromFile(location.filePath);
}

/** Safely coerce a value to a number, returning 0 for non-numeric values */
function safeNum(v: unknown): number {
  return typeof v === 'number' && !isNaN(v) ? v : 0;
}

/** Mutable accumulators used during JSONL parsing */
interface MetricsAccumulator {
  firstMessage: RawAgentMessage | null;
  lastMessage: RawAgentMessage | null;
  models: Set<string>;
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  toolUseCount: number;
  toolBreakdown: Record<string, number>;
  errorCount: number;
}

function createAccumulator(): MetricsAccumulator {
  return {
    firstMessage: null,
    lastMessage: null,
    models: new Set(),
    messageCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    toolUseCount: 0,
    toolBreakdown: {},
    errorCount: 0,
  };
}

/** Accumulate token usage from a message's usage field */
function accumulateTokens(acc: MetricsAccumulator, usage: NonNullable<RawAgentMessage['message']>['usage']): void {
  if (!usage) return;
  acc.inputTokens += safeNum(usage.input_tokens);
  acc.outputTokens += safeNum(usage.output_tokens);
  acc.cacheCreationTokens += safeNum(usage.cache_creation_input_tokens);
  acc.cacheReadTokens += safeNum(usage.cache_read_input_tokens);
}

/** Count tool uses from assistant message content blocks */
function accumulateToolUses(acc: MetricsAccumulator, content: unknown[]): void {
  for (const block of content) {
    if (isToolUseBlock(block)) {
      acc.toolUseCount++;
      const toolName = block.name || 'unknown';
      acc.toolBreakdown[toolName] = (acc.toolBreakdown[toolName] || 0) + 1;
    }
  }
}

/** Process a single validated message into the accumulator */
function processMessage(acc: MetricsAccumulator, message: RawAgentMessage): void {
  acc.messageCount++;

  if (!acc.firstMessage) acc.firstMessage = message;
  acc.lastMessage = message;

  if (message.message?.model) {
    acc.models.add(message.message.model);
  }

  accumulateTokens(acc, message.message?.usage);

  if (message.type === 'assistant' && message.message?.content && Array.isArray(message.message.content)) {
    accumulateToolUses(acc, message.message.content);
  }

  if (message.type === 'tool_result' && message.toolUseResult?.is_error) {
    acc.errorCount++;
  }
}

/**
 * Build the final AgentMetrics object from a completed accumulator.
 * @precondition acc.firstMessage and acc.lastMessage must be non-null (caller validates)
 */
function buildMetrics(acc: MetricsAccumulator): AgentMetrics {
  if (!acc.firstMessage || !acc.lastMessage) {
    throw new Error('buildMetrics called with empty accumulator — no messages were processed');
  }
  const first = acc.firstMessage;
  const last = acc.lastMessage;
  const durationMs = calculateDuration(first.timestamp, last.timestamp);

  return {
    harness: 'claude-code',
    agent_id: first.agentId,
    session_id: first.sessionId,
    slug: first.slug ?? first.agentId,
    model: acc.models.size > 0 ? acc.models.values().next().value! : 'unknown',
    git_branch: first.gitBranch,
    cwd: first.cwd,
    claude_code_version: first.version,
    prompt_id: typeof first.promptId === 'string' ? first.promptId : null,
    start_time: first.timestamp,
    end_time: last.timestamp,
    duration_ms: durationMs,
    duration_formatted: formatDuration(durationMs),
    tokens: {
      input: acc.inputTokens,
      output: acc.outputTokens,
      cache_creation: acc.cacheCreationTokens,
      cache_read: acc.cacheReadTokens,
      // Canonical effective total (see TokenMetrics.total_effective in types.ts):
      // (input − cached_input) + output_gross + cache_creation. Claude's `input`
      // is already non-cached (cache reads are the separate cache_read field) and
      // it has no cached_input term (0), so this is commensurable with the Codex
      // formula in codex-extractor.ts, which carries cached_input instead.
      total_effective: acc.inputTokens + acc.cacheCreationTokens + acc.outputTokens,
      total_raw: acc.inputTokens + acc.outputTokens + acc.cacheCreationTokens + acc.cacheReadTokens,
    },
    execution: {
      message_count: acc.messageCount,
      tool_use_count: acc.toolUseCount,
      tool_breakdown: acc.toolBreakdown,
      error_count: acc.errorCount,
    },
  };
}

/**
 * Extract metrics directly from a file path.
 *
 * Streams the JSONL file line-by-line, validates each message,
 * and accumulates token, tool, and timing metrics.
 *
 * @param filePath - Path to the agent JSONL file
 * @returns AgentMetrics object
 * @throws Error if no valid messages found in the file
 */
export async function extractMetricsFromFile(
  filePath: string
): Promise<AgentMetrics> {
  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read agent metrics file "${filePath}": ${message}`);
  }

  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  const acc = createAccumulator();

  for await (const line of rl) {
    if (!line.trim()) continue;

    try {
      const parsed = JSON.parse(line);
      if (!isValidAgentMessage(parsed)) {
        process.stderr.write(`Warning: Skipping message with missing required fields in ${filePath}; expected ${REQUIRED_AGENT_MESSAGE_FIELDS}\n`);
        continue;
      }
      processMessage(acc, parsed);
    } catch (err) {
      process.stderr.write(`Warning: Skipping malformed JSONL line in ${filePath}: ${err instanceof Error ? err.message : 'parse error'}\n`);
      continue;
    }
  }

  if (!acc.firstMessage || !acc.lastMessage) {
    throw new Error(`No valid messages found in ${filePath}`);
  }

  return buildMetrics(acc);
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
  const entries = await Promise.all(
    agentIds.map(async (id) => [id, await extractAgentMetrics(id, options)] as const)
  );
  return new Map(entries);
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
    `│  Harness:     ${metrics.harness}`,
    `│  Branch:      ${metrics.git_branch ?? 'n/a'}`,
    `│  Version:     ${metrics.claude_code_version ?? metrics.codex_cli_version ?? 'unknown'}`,
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
    ...(metrics.tokens.cached_input !== undefined ? [`│  Cached Input:${formatNumber(metrics.tokens.cached_input)}`] : []),
    ...(metrics.tokens.reasoning_output !== undefined ? [`│  Reasoning:   ${formatNumber(metrics.tokens.reasoning_output)}`] : []),
    ...(metrics.tokens.thinking !== undefined ? [`│  Thinking:    ${formatNumber(metrics.tokens.thinking)}`] : []),
    ...(metrics.tokens.tool !== undefined ? [`│  Tool:        ${formatNumber(metrics.tokens.tool)}`] : []),
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
  /** Cross-harness components (v0.6.0). Undefined → stored NULL. Subsets of gross output, never added. */
  cached_input_tokens?: number;
  reasoning_output_tokens?: number;
  thinking_tokens?: number;
  tool_tokens?: number;
}

/**
 * Tracker-compatible metrics format
 */
export interface TrackerFormat {
  name: string;
  /** Transcript/agent provenance id (v0.7.0). Joins tracker rows to buffer entries and transcripts. */
  agent_id: string;
  model: string;
  /** Producing harness (v0.6.0). claude-code | codex. */
  harness?: string;
  tokens: TrackerTokens;
  duration_ms: number;
}

/**
 * Convert metrics to tracker-compatible format.
 *
 * Lossy boundary by design: `total_raw` and `model_provider` are intentionally
 * dropped here. The tracker's agent-token schema has no field for either, and
 * both are reconstructable downstream — `total_raw` from the emitted components
 * and the provider from the preserved `harness`/`model`. Re-pricing components
 * (cached_input, reasoning_output, thinking, tool) ARE preserved (v0.6.0).
 *
 * @param metrics - AgentMetrics object
 * @param agentName - Name of the agent
 * @returns Object ready for validation tracker
 */
export function toTrackerFormat(
  metrics: AgentMetrics,
  agentName: string
): TrackerFormat {
  return {
    name: agentName,
    agent_id: metrics.agent_id,
    model: metrics.model,
    harness: metrics.harness,
    tokens: {
      input_tokens: metrics.tokens.input,
      output_tokens: metrics.tokens.output,
      cache_creation_tokens: metrics.tokens.cache_creation,
      cache_read_tokens: metrics.tokens.cache_read,
      total_effective_tokens: metrics.tokens.total_effective,
      cached_input_tokens: metrics.tokens.cached_input,
      reasoning_output_tokens: metrics.tokens.reasoning_output,
      thinking_tokens: metrics.tokens.thinking,
      tool_tokens: metrics.tokens.tool,
    },
    duration_ms: metrics.duration_ms,
  };
}
