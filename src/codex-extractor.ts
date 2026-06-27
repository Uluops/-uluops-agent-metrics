/**
 * Codex JSONL extraction logic.
 */

import * as fs from 'node:fs';
import * as readline from 'node:readline';
import type { AgentMetrics } from './types.js';
import { findCodexAgentFile, calculateDuration, formatDuration } from './utils.js';

interface CodexRecord {
  type?: string;
  timestamp?: string;
  payload?: Record<string, unknown>;
}

interface CodexTokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

interface CodexAccumulator {
  sessionMeta: Record<string, unknown> | null;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  model: string | null;
  cwd: string | null;
  tokenUsage: CodexTokenUsage | null;
  taskCompleteCount: number;
  singleTurnDurationMs: number | null;
  timeToFirstTokenMs: number | undefined;
  finalMessage: string | undefined;
  messageCount: number;
  toolUseCount: number;
  toolBreakdown: Record<string, number>;
  reasoningRecordCount: number;
  errorCount: number;
  validRecordCount: number;
}

function createAccumulator(): CodexAccumulator {
  return {
    sessionMeta: null,
    firstTimestamp: null,
    lastTimestamp: null,
    model: null,
    cwd: null,
    tokenUsage: null,
    taskCompleteCount: 0,
    singleTurnDurationMs: null,
    timeToFirstTokenMs: undefined,
    finalMessage: undefined,
    messageCount: 0,
    toolUseCount: 0,
    toolBreakdown: {},
    reasoningRecordCount: 0,
    errorCount: 0,
    validRecordCount: 0,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function safeNum(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function safeString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function normalizeToolName(name: unknown): string {
  const raw = typeof name === 'string' && name.length > 0 ? name : 'unknown';
  const dot = raw.lastIndexOf('.');
  return dot >= 0 ? raw.slice(dot + 1) : raw;
}

function parseRecord(line: string): CodexRecord | null {
  const parsed = JSON.parse(line) as unknown;
  const record = asRecord(parsed);
  if (!record) return null;
  return {
    type: safeString(record.type),
    timestamp: safeString(record.timestamp),
    payload: asRecord(record.payload) ?? undefined,
  };
}

function extractTokenUsage(payload: Record<string, unknown>): CodexTokenUsage | null {
  const info = asRecord(payload.info);
  const total = asRecord(info?.total_token_usage);
  if (!total) return null;
  return {
    input_tokens: safeNum(total.input_tokens),
    cached_input_tokens: safeNum(total.cached_input_tokens),
    output_tokens: safeNum(total.output_tokens),
    reasoning_output_tokens: safeNum(total.reasoning_output_tokens),
    total_tokens: safeNum(total.total_tokens),
  };
}

function isFailedToolOutput(payload: Record<string, unknown>): boolean {
  if (payload.is_error === true || payload.success === false) return true;
  const output = payload.output;
  const parsed = typeof output === 'string' ? tryParseJson(output) : asRecord(output);
  if (!parsed) return false;
  return parsed.is_error === true || parsed.success === false;
}

function tryParseJson(value: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

function processEvent(acc: CodexAccumulator, payload: Record<string, unknown>): void {
  const payloadType = safeString(payload.type);

  if (payloadType === 'token_count') {
    acc.tokenUsage = extractTokenUsage(payload);
    return;
  }

  if (payloadType === 'task_complete') {
    acc.taskCompleteCount++;
    const duration = safeNum(payload.duration_ms);
    if (acc.taskCompleteCount === 1) {
      acc.singleTurnDurationMs = duration;
      const ttft = payload.time_to_first_token_ms;
      if (typeof ttft === 'number' && Number.isFinite(ttft)) {
        acc.timeToFirstTokenMs = ttft;
      }
    }
    const finalMessage = safeString(payload.last_agent_message);
    if (finalMessage) {
      acc.finalMessage = finalMessage;
    }
    return;
  }

  if (payloadType === 'task_failed' || payloadType === 'task_error') {
    acc.errorCount++;
  }
}

function processResponseItem(acc: CodexAccumulator, payload: Record<string, unknown>): void {
  const payloadType = safeString(payload.type);

  if (payloadType === 'message') {
    acc.messageCount++;
    return;
  }

  if (payloadType === 'reasoning') {
    acc.reasoningRecordCount++;
    return;
  }

  if (payloadType === 'function_call' || payloadType === 'custom_tool_call' || payloadType === 'tool_search_call') {
    acc.toolUseCount++;
    const toolName = normalizeToolName(payload.name);
    acc.toolBreakdown[toolName] = (acc.toolBreakdown[toolName] || 0) + 1;
    return;
  }

  if (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output') {
    if (isFailedToolOutput(payload)) {
      acc.errorCount++;
    }
  }
}

function processRecord(acc: CodexAccumulator, record: CodexRecord): void {
  acc.validRecordCount++;
  if (record.timestamp) {
    acc.firstTimestamp ??= record.timestamp;
    acc.lastTimestamp = record.timestamp;
  }

  const payload = record.payload;
  if (!payload) return;

  if (record.type === 'session_meta') {
    acc.sessionMeta = payload;
    const timestamp = safeString(payload.timestamp);
    if (timestamp) acc.firstTimestamp = timestamp;
    const cwd = safeString(payload.cwd);
    if (cwd) acc.cwd = cwd;
    return;
  }

  if (record.type === 'turn_context') {
    const model = safeString(payload.model);
    if (model) acc.model = model;
    const cwd = safeString(payload.cwd);
    if (cwd) acc.cwd = cwd;
    return;
  }

  if (record.type === 'event_msg') {
    processEvent(acc, payload);
    return;
  }

  if (record.type === 'response_item') {
    processResponseItem(acc, payload);
  }
}

function buildMetrics(acc: CodexAccumulator): AgentMetrics {
  if (!acc.sessionMeta || acc.validRecordCount === 0) {
    throw new Error('No valid Codex session records found');
  }

  const usage = acc.tokenUsage ?? {};
  const input = safeNum(usage.input_tokens);
  const cachedInput = safeNum(usage.cached_input_tokens);
  const output = safeNum(usage.output_tokens);
  const reasoningOutput = safeNum(usage.reasoning_output_tokens);
  const rawTotal = safeNum(usage.total_tokens);

  const agentId = safeString(acc.sessionMeta.id) ?? 'unknown';
  const parentThreadId = safeString(acc.sessionMeta.parent_thread_id) ?? agentId;
  const startTime = safeString(acc.sessionMeta.timestamp) ?? acc.firstTimestamp ?? new Date(0).toISOString();
  const endTime = acc.lastTimestamp ?? startTime;
  const durationMs = acc.taskCompleteCount === 1 && acc.singleTurnDurationMs !== null
    ? acc.singleTurnDurationMs
    : calculateDuration(startTime, endTime);

  return {
    provider: 'codex',
    agent_id: agentId,
    session_id: parentThreadId,
    parent_thread_id: parentThreadId,
    slug: safeString(acc.sessionMeta.agent_nickname) ?? agentId,
    model: acc.model ?? 'unknown',
    cwd: acc.cwd ?? safeString(acc.sessionMeta.cwd) ?? '',
    codex_cli_version: safeString(acc.sessionMeta.cli_version),
    model_provider: safeString(acc.sessionMeta.model_provider),
    prompt_id: null,
    start_time: startTime,
    end_time: endTime,
    duration_ms: durationMs,
    duration_formatted: formatDuration(durationMs),
    time_to_first_token_ms: acc.timeToFirstTokenMs,
    tokens: {
      input,
      output,
      cache_creation: 0,
      cache_read: 0,
      cached_input: cachedInput,
      reasoning_output: reasoningOutput,
      total_effective: input - cachedInput + output + reasoningOutput,
      total_raw: rawTotal,
    },
    execution: {
      message_count: acc.messageCount,
      tool_use_count: acc.toolUseCount,
      tool_breakdown: acc.toolBreakdown,
      error_count: acc.errorCount,
      reasoning_record_count: acc.reasoningRecordCount,
    },
    final_message: acc.finalMessage,
  };
}

export async function extractCodexMetricsFromFile(filePath: string): Promise<AgentMetrics> {
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  const acc = createAccumulator();

  for await (const line of rl) {
    if (!line.trim()) continue;

    try {
      const record = parseRecord(line);
      if (!record) {
        process.stderr.write(`Warning: Skipping Codex JSONL record with invalid shape in ${filePath}\n`);
        continue;
      }
      processRecord(acc, record);
    } catch (err) {
      process.stderr.write(`Warning: Skipping malformed Codex JSONL line in ${filePath}: ${err instanceof Error ? err.message : 'parse error'}\n`);
    }
  }

  return buildMetrics(acc);
}

export async function extractCodexAgentMetrics(agentId: string): Promise<AgentMetrics | null> {
  const location = await findCodexAgentFile(agentId);
  if (!location) return null;
  return extractCodexMetricsFromFile(location.filePath);
}
