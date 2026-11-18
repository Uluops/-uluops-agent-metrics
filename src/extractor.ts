/**
 * Core extraction logic for agent metrics
 */

import * as fs from 'node:fs';
import type {
  AgentMetrics,
  RawAgentMessage,
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
import { readJsonlLines } from './jsonl.js';

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

/** The record types this extractor reads. Anything else is a harness record, not a message. */
const MESSAGE_TYPES: ReadonlySet<string> = new Set(['user', 'assistant', 'tool_result']);

/**
 * A record that fails the field check but is not a message and carries no usage, so skipping
 * it loses nothing and needs no warning. Claude Code ≥ 2.1.3xx writes `api-request`,
 * `api-request-blob` and `api-request-shape` records into subagent transcripts without
 * `cwd`/`gitBranch` (the blob also without `timestamp`/`version`). Measured 2026-11-18:
 * 69,596 such lines in 1,912 of 2,472 transcripts, none with usage, and they were the ONLY
 * lines failing the check. Each one printed a warning, so `-f tracker` emitted dozens of
 * lines of stderr per agent and buried the warnings that matter (0.13.1). A message-typed
 * line, an untyped line, or any line carrying `message.usage` still warns: losing one of
 * those loses data.
 */
function isSilentNonMessage(obj: unknown): boolean {
  if (!obj || typeof obj !== 'object') return false;
  const rec = obj as Record<string, unknown>; // safe: guarded by typeof check above
  if (typeof rec['type'] !== 'string' || MESSAGE_TYPES.has(rec['type'])) return false;
  const message = rec['message'];
  return !(message && typeof message === 'object' && 'usage' in message);
}

/**
 * Extract metrics from an agent session file
 *
 * @param agentId - The agent ID to extract metrics for
 * @param options - Extraction options
 * @returns AgentMetrics object or null if the agent file could not be found
 * @throws Error if the agent file WAS found but could not be read or contained
 *   no valid messages/records (Claude: extractMetricsFromFile; Codex:
 *   extractCodexMetricsFromFile) — null means "not there", a throw means
 *   "there, but unusable"
 * @see README.md § Core Extraction Functions
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

/** One API response's usage, as four non-negative-or-zero numbers. */
interface UsageSnap {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

/** What the fold keeps per response: the first, latest and highest usage seen on its lines. */
interface ResponseUsage {
  first: UsageSnap;
  last: UsageSnap;
  high: UsageSnap;
  conflicted: boolean;
  regressed: boolean;
}

/** Mutable accumulators used during JSONL parsing */
interface MetricsAccumulator {
  firstMessage: RawAgentMessage | null;
  lastMessage: RawAgentMessage | null;
  models: Set<string>;
  lineCount: number;
  /** user and tool_result lines: each is its own message. Other record types are not counted. */
  otherLines: number;
  /** Distinct assistant responses, keyed as `responseKey` keys them. */
  assistantResponses: Set<string>;
  /** Usage per response (8fe868d4): summed once per key in buildMetrics, never per line. */
  responses: Map<string, ResponseUsage>;
  toolUseCount: number;
  toolBreakdown: Record<string, number>;
  errorCount: number;
}

function createAccumulator(): MetricsAccumulator {
  return {
    firstMessage: null,
    lastMessage: null,
    models: new Set(),
    lineCount: 0,
    otherLines: 0,
    assistantResponses: new Set(),
    responses: new Map(),
    toolUseCount: 0,
    toolBreakdown: {},
    errorCount: 0,
  };
}

/**
 * Which API response a line belongs to (spec R1): `message.id`, else the top-level
 * `requestId`, else the line itself. Claude Code writes one line per content block
 * (thinking, text, each tool_use) and repeats the response's id and full `usage` on every
 * one, so the id, not the line, is the unit usage is counted in. The prefixes keep an id and
 * a requestId that happen to be equal strings apart.
 */
function responseKey(message: RawAgentMessage, line: number): string {
  const id: unknown = message.message?.id;
  if (typeof id === 'string' && id !== '') return `id:${id}`;
  // Never written by Claude Code; keyed rather than dropped to requestId, where two distinct
  // numeric ids sharing a requestId would merge (code-auditor, review run #11).
  if (typeof id === 'number' && Number.isFinite(id)) return `id:${String(id)}`;
  if (typeof message.requestId === 'string' && message.requestId !== '') return `req:${message.requestId}`;
  return `line:${String(line)}`;
}

const SNAP_KEYS = ['input', 'output', 'cacheCreation', 'cacheRead'] as const;
const USAGE_FIELD: Readonly<Record<(typeof SNAP_KEYS)[number], string>> = {
  input: 'input_tokens',
  output: 'output_tokens',
  cacheCreation: 'cache_creation_input_tokens',
  cacheRead: 'cache_read_input_tokens',
};

/**
 * A line's usage, field by field: a finite number where the line carries one, `undefined`
 * where it does not (absent, string, NaN, Infinity). Last-wins must never let a malformed or
 * partial later repeat replace a good earlier value with 0. Under 0.12.1's per-line sum such a
 * line cost only its own share; under last-wins it would zero the whole response (code-auditor,
 * review run #11). So a missing field carries the previous value forward, and a `usage` that is
 * not an object is ignored.
 */
function fieldsOf(usage: unknown): Partial<UsageSnap> | null {
  if (typeof usage !== 'object' || usage === null || Array.isArray(usage)) return null;
  const u = usage as Record<string, unknown>; // safe: object, non-null, non-array checked above
  const out: Partial<UsageSnap> = {};
  for (const k of SNAP_KEYS) {
    const v = u[USAGE_FIELD[k]];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/**
 * Record a line's usage against its response (tracker 8fe868d4; spec R2). The LAST repeat
 * wins: measured 2026-10-30 over 1,944 transcripts, repeats that differ (11,101 responses)
 * differ only in `output_tokens`, always non-decreasing, the last line the maximum. Early
 * lines carry partial output; first-wins would undercount by 9.8 M effective tokens. A repeat
 * that differs from the first marks the response `conflicted` (expected); a repeat lower than
 * an earlier one in any component marks it `regressed` (never observed: it would mean Claude
 * Code changed how it writes usage, and last-wins could undercount). Both are counted so that
 * change shows up as a number.
 */
function recordUsage(acc: MetricsAccumulator, key: string, usage: unknown): void {
  const fields = fieldsOf(usage);
  if (!fields) return;
  const seen = acc.responses.get(key);
  if (!seen) {
    const now: UsageSnap = { input: fields.input ?? 0, output: fields.output ?? 0, cacheCreation: fields.cacheCreation ?? 0, cacheRead: fields.cacheRead ?? 0 };
    acc.responses.set(key, { first: now, last: now, high: now, conflicted: false, regressed: false });
    return;
  }
  const now: UsageSnap = {
    input: fields.input ?? seen.last.input,
    output: fields.output ?? seen.last.output,
    cacheCreation: fields.cacheCreation ?? seen.last.cacheCreation,
    cacheRead: fields.cacheRead ?? seen.last.cacheRead,
  };
  const differs = SNAP_KEYS.some(k => now[k] !== seen.first[k]);
  const falls = SNAP_KEYS.some(k => now[k] < seen.high[k]);
  acc.responses.set(key, {
    first: seen.first,
    last: now,
    high: {
      input: Math.max(now.input, seen.high.input),
      output: Math.max(now.output, seen.high.output),
      cacheCreation: Math.max(now.cacheCreation, seen.high.cacheCreation),
      cacheRead: Math.max(now.cacheRead, seen.high.cacheRead),
    },
    conflicted: seen.conflicted || differs,
    regressed: seen.regressed || falls,
  });
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

/**
 * Process a single validated message into the accumulator. Usage and the message count are
 * per response; tool, error, model and timing counts stay per line/block (spec R3): each
 * content block appears on exactly one line, so those were never duplicated.
 */
function processMessage(acc: MetricsAccumulator, message: RawAgentMessage): void {
  const key = responseKey(message, acc.lineCount);
  acc.lineCount++;
  // G2: messages are assistant responses plus user and tool_result lines. Other record types
  // that pass validation (e.g. `attachment`, `system`) are lines, not messages (0.13.1).
  if (message.type === 'assistant') acc.assistantResponses.add(key);
  else if (message.type === 'user' || message.type === 'tool_result') acc.otherLines++;

  if (!acc.firstMessage) acc.firstMessage = message;
  acc.lastMessage = message;

  if (message.message?.model) {
    acc.models.add(message.message.model);
  }

  recordUsage(acc, key, message.message?.usage);

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

  let input = 0, output = 0, cacheCreation = 0, cacheRead = 0, conflicts = 0, regressions = 0;
  for (const r of acc.responses.values()) {
    input += r.last.input;
    output += r.last.output;
    cacheCreation += r.last.cacheCreation;
    cacheRead += r.last.cacheRead;
    if (r.conflicted) conflicts++;
    if (r.regressed) regressions++;
  }

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
      input,
      output,
      cache_creation: cacheCreation,
      cache_read: cacheRead,
      // Canonical effective total (see TokenMetrics.total_effective in types.ts):
      // (input − cached_input) + output_gross + cache_creation. Claude's `input`
      // is already non-cached (cache reads are the separate cache_read field) and
      // it has no cached_input term (0), so this is commensurable with the Codex
      // formula in codex-extractor.ts, which carries cached_input instead.
      total_effective: input + cacheCreation + output,
      total_raw: input + output + cacheCreation + cacheRead,
      counting: 'per-response',
    },
    execution: {
      message_count: acc.assistantResponses.size + acc.otherLines,
      line_count: acc.lineCount,
      usage_conflicts: conflicts,
      usage_regressions: regressions,
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
    throw new Error(`Unable to read agent metrics file "${filePath}": ${message}`, { cause: error });
  }


  const acc = createAccumulator();

  for await (const line of readJsonlLines(filePath)) {
    if (!line.trim()) continue;

    try {
      const parsed = JSON.parse(line);
      if (!isValidAgentMessage(parsed)) {
        if (!isSilentNonMessage(parsed)) {
          process.stderr.write(`Warning: Skipping message with missing required fields in ${filePath}; expected ${REQUIRED_AGENT_MESSAGE_FIELDS}\n`);
        }
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
 * @returns Map of agent ID to metrics. A null value means no metrics for
 *   that id — either the agent file wasn't found, or extraction failed (in
 *   which case a diagnostic naming the id and the failure reason is written
 *   to stderr, mirroring commands/core.ts's compare command). One id's
 *   failure never prevents the others from resolving.
 * @see README.md § Core Extraction Functions
 */
export async function extractMultipleAgentMetrics(
  agentIds: string[],
  options: ExtractOptions = {}
): Promise<Map<string, AgentMetrics | null>> {
  const settled = await Promise.allSettled(
    agentIds.map(async (id) => [id, await extractAgentMetrics(id, options)] as const)
  );
  const entries = settled.map((result, i) => {
    if (result.status === 'fulfilled') return result.value;
    const id = agentIds[i]!;
    process.stderr.write(`Error reading agent ${id}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}\n`);
    return [id, null] as const;
  });
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
  /** The version of the definition that ran (v0.12.0, X4-2); omitted when it could not be named. */
  definition_version?: string;
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
  agentName: string,
  definitionVersion?: string,
): TrackerFormat {
  return {
    ...(definitionVersion !== undefined ? { definition_version: definitionVersion } : {}),
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
