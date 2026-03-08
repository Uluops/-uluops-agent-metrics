/**
 * Display Formatters
 *
 * Shared display/formatting functions for CLI output.
 * All formatters return strings for testability.
 */

import { getBufferStats, type BufferEntry } from '../buffer.js';
import { formatDuration, formatTokens, formatModelName } from '../utils.js';
import type { AgentMetrics } from '../types.js';

/**
 * Format buffer statistics as a displayable string.
 *
 * @param title - Title to display at the top
 * @returns Formatted string ready for console output
 */
export function formatBufferStatus(title: string): string {
  const stats = getBufferStats();
  const lines: string[] = [];

  lines.push(title);
  lines.push('═'.repeat(50));
  lines.push('');
  lines.push(`Total entries:     ${stats.totalEntries}`);
  lines.push(`Valid entries:     ${stats.validEntries}`);
  lines.push(`Expired entries:   ${stats.expiredEntries}`);
  lines.push(`Unique sessions:   ${stats.uniqueSessions}`);
  lines.push(`Unique agents:     ${stats.uniqueAgents}`);
  lines.push(`Buffer size:       ${(stats.bufferSizeBytes / 1024).toFixed(1)} KB`);
  lines.push('');
  if (stats.oldestEntry) {
    lines.push(`Oldest entry:      ${stats.oldestEntry}`);
  }
  if (stats.newestEntry) {
    lines.push(`Newest entry:      ${stats.newestEntry}`);
  }

  return lines.join('\n');
}

/**
 * Display buffer status to console.
 * Convenience wrapper for backward compatibility.
 *
 * @param title - Title to display at the top of the output
 */
export function displayBufferStatus(title: string): void {
  console.log(formatBufferStatus(title));
}

/**
 * Format buffer entries as a table.
 *
 * @param entries - Buffer entries to format
 * @returns Formatted table string
 */
export function formatBufferList(entries: BufferEntry[]): string {
  if (entries.length === 0) {
    return 'No buffered entries found.';
  }

  const lines: string[] = [];
  lines.push('Buffered Metrics');
  lines.push('═'.repeat(100));
  lines.push('');
  lines.push(
    'Agent ID   │  Validator                  │  Duration  │  Tokens    │  Captured'
  );
  lines.push('─'.repeat(100));

  for (const entry of entries) {
    const validatorName = (entry.validator_name || 'unknown').slice(0, 25).padEnd(25);
    const duration = entry.metrics.duration_formatted.padEnd(8);
    const tokens = formatTokens(entry.metrics.tokens.total_effective).padEnd(8);
    const captured = new Date(entry.captured_at).toLocaleString().slice(0, 20);

    lines.push(
      `${entry.agent_id.padEnd(10)}  │  ${validatorName}  │  ${duration}  │  ${tokens}  │  ${captured}`
    );
  }

  lines.push('');
  lines.push(`Total: ${entries.length} entries`);

  return lines.join('\n');
}

/**
 * Format buffer session entries as a table with totals.
 *
 * @param sessionId - Session ID being displayed
 * @param entries - Buffer entries for the session
 * @returns Formatted table string
 */
export function formatBufferSession(sessionId: string, entries: BufferEntry[]): string {
  if (entries.length === 0) {
    return `No buffered entries found for session: ${sessionId}`;
  }

  const lines: string[] = [];
  lines.push(`Session: ${sessionId}`);
  lines.push('═'.repeat(90));
  lines.push('');

  let totalDuration = 0;
  let totalTokens = 0;

  for (const entry of entries) {
    const validatorName = (entry.validator_name || 'unknown').padEnd(25);
    const dur = entry.metrics.duration_formatted.padEnd(8);
    const tok = formatTokens(entry.metrics.tokens.total_effective).padEnd(8);
    lines.push(`${entry.agent_id}  │  ${validatorName}  │  ${dur}  │  ${tok}`);
    totalDuration += entry.metrics.duration_ms;
    totalTokens += entry.metrics.tokens.total_effective;
  }

  lines.push('─'.repeat(90));
  const totalLabel = 'TOTAL'.padEnd(10);
  const empty = ''.padEnd(25);
  const durStr = formatDuration(totalDuration).padEnd(8);
  const tokStr = formatTokens(totalTokens).padEnd(8);
  lines.push(`${totalLabel}  │  ${empty}  │  ${durStr}  │  ${tokStr}`);

  return lines.join('\n');
}

/**
 * Format recent metrics report as a table with totals.
 *
 * @param entries - Buffer entries to display
 * @returns Formatted table string
 */
export function formatReport(entries: BufferEntry[]): string {
  if (entries.length === 0) {
    return 'No metrics captured yet.';
  }

  const lines: string[] = [];
  lines.push('Recent Agent Metrics');
  lines.push('═'.repeat(85));
  lines.push('');
  lines.push(
    'Agent ID   │  Model        │  Duration  │  Tokens    │  Tools  │  Project'
  );
  lines.push('─'.repeat(85));

  let totalDuration = 0;
  let totalTokens = 0;
  let totalTools = 0;

  for (const entry of entries) {
    const modelShort = formatModelName(entry.metrics.model).padEnd(12);
    const duration = entry.metrics.duration_formatted.padEnd(8);
    const tokens = formatTokens(entry.metrics.tokens.total_effective).padEnd(8);
    const tools = entry.metrics.execution.tool_use_count.toString().padStart(5);
    const project = (entry.project_path || '')
      .split('/')
      .slice(-2)
      .join('/')
      .slice(0, 20);

    lines.push(
      `${entry.agent_id.padEnd(10)}  │  ${modelShort}  │  ${duration}  │  ${tokens}  │  ${tools}  │  ${project}`
    );

    totalDuration += entry.metrics.duration_ms;
    totalTokens += entry.metrics.tokens.total_effective;
    totalTools += entry.metrics.execution.tool_use_count;
  }

  lines.push('─'.repeat(85));
  const totLabel = 'TOTAL'.padEnd(10);
  const totEmpty = ''.padEnd(12);
  const totDur = formatDuration(totalDuration).padEnd(8);
  const totTok = formatTokens(totalTokens).padEnd(8);
  const totToolsStr = totalTools.toString().padStart(5);
  lines.push(`${totLabel}  │  ${totEmpty}  │  ${totDur}  │  ${totTok}  │  ${totToolsStr}  │`);
  lines.push('');
  lines.push(`Showing ${entries.length} entries`);

  return lines.join('\n');
}

/**
 * Agent list item for formatting
 */
export interface AgentListItem {
  agentId: string;
  metrics: AgentMetrics;
  projectName: string;
}

/**
 * Format agent list as a table.
 *
 * @param items - Agent list items to format
 * @returns Formatted table string
 */
export function formatAgentList(items: AgentListItem[]): string {
  if (items.length === 0) {
    return 'No agent files found.';
  }

  const lines: string[] = [];
  lines.push('Recent Agent Runs');
  lines.push('═'.repeat(80));
  lines.push('');

  for (const item of items) {
    const duration = item.metrics.duration_formatted.padEnd(8);
    const tokens = formatTokens(item.metrics.tokens.total_effective).padEnd(7);
    const tools = item.metrics.execution.tool_use_count.toString().padStart(2);
    lines.push(`${item.agentId}  │  ${duration}  │  ${tokens}  │  ${tools} tools  │  ${item.projectName}`);
  }

  lines.push('');
  lines.push('Use `agent-metrics extract <agent-id>` for detailed metrics');

  return lines.join('\n');
}

/**
 * Format error for agent list item that failed to load.
 *
 * @param agentId - Agent ID that failed
 * @param projectName - Project name
 * @returns Formatted error line
 */
export function formatAgentListError(agentId: string, projectName: string): string {
  return `${agentId}  │  (error reading file)  │  ${projectName}`;
}

/**
 * Comparison item for formatting
 */
export interface CompareItem {
  agentId: string;
  metrics: AgentMetrics | null;
}

/**
 * Format agent comparison as a table with totals.
 *
 * @param items - Comparison items to format
 * @returns Formatted table string
 */
export function formatAgentCompare(items: CompareItem[]): string {
  const lines: string[] = [];
  lines.push('Agent Comparison');
  lines.push('═'.repeat(90));
  lines.push('');
  lines.push(
    'Agent ID   │  Duration  │  Effective   │  Output   │  Tools  │  Errors  │  Model'
  );
  lines.push('─'.repeat(90));

  let totalDuration = 0;
  let totalEffective = 0;
  let totalOutput = 0;
  let totalTools = 0;
  let totalErrors = 0;

  for (const item of items) {
    if (!item.metrics) {
      lines.push(`${item.agentId.padEnd(10)}  │  (not found)`);
      continue;
    }

    const modelShort = formatModelName(item.metrics.model);
    const id = item.metrics.agent_id.padEnd(10);
    const dur = item.metrics.duration_formatted.padEnd(8);
    const eff = formatTokens(item.metrics.tokens.total_effective).padEnd(10);
    const out = formatTokens(item.metrics.tokens.output).padEnd(7);
    const tools = item.metrics.execution.tool_use_count.toString().padStart(5);
    const errs = item.metrics.execution.error_count.toString().padStart(6);

    lines.push(`${id}  │  ${dur}  │  ${eff}  │  ${out}  │  ${tools}  │  ${errs}  │  ${modelShort}`);

    totalDuration += item.metrics.duration_ms;
    totalEffective += item.metrics.tokens.total_effective;
    totalOutput += item.metrics.tokens.output;
    totalTools += item.metrics.execution.tool_use_count;
    totalErrors += item.metrics.execution.error_count;
  }

  lines.push('─'.repeat(90));

  const totalLabel = 'TOTAL'.padEnd(10);
  const totalDur = formatDuration(totalDuration).padEnd(8);
  const totalEff = formatTokens(totalEffective).padEnd(10);
  const totalOut = formatTokens(totalOutput).padEnd(7);
  const totalToolsStr = totalTools.toString().padStart(5);
  const totalErrsStr = totalErrors.toString().padStart(6);

  lines.push(`${totalLabel}  │  ${totalDur}  │  ${totalEff}  │  ${totalOut}  │  ${totalToolsStr}  │  ${totalErrsStr}  │`);

  return lines.join('\n');
}

/**
 * Log statistics for formatting
 */
export interface LogStats {
  logPath: string;
  enabled: boolean;
  minLevel: string;
  maxFileSize: number;
  maxFiles: number;
  exists: boolean;
  sizeBytes: number;
  lineCount: number;
  rotatedFiles: number;
  oldestEntry: string | null;
  newestEntry: string | null;
}

/**
 * Format log status as a displayable string.
 *
 * @param stats - Log statistics to format
 * @returns Formatted string
 */
export function formatLogStatus(stats: LogStats): string {
  const lines: string[] = [];

  lines.push('Agent Metrics Log Status');
  lines.push('═'.repeat(50));
  lines.push('');
  lines.push(`Log file:          ${stats.logPath}`);
  lines.push(`Logging enabled:   ${stats.enabled}`);
  lines.push(`Min level:         ${stats.minLevel}`);
  lines.push(`Max file size:     ${(stats.maxFileSize / 1024 / 1024).toFixed(1)} MB`);
  lines.push(`Max rotated files: ${stats.maxFiles}`);
  lines.push('');
  lines.push(`File exists:       ${stats.exists}`);
  if (stats.exists) {
    lines.push(`File size:         ${(stats.sizeBytes / 1024).toFixed(1)} KB`);
    lines.push(`Line count:        ${stats.lineCount}`);
    lines.push(`Rotated files:     ${stats.rotatedFiles}`);
    if (stats.oldestEntry) {
      lines.push(`Oldest entry:      ${stats.oldestEntry}`);
    }
    if (stats.newestEntry) {
      lines.push(`Newest entry:      ${stats.newestEntry}`);
    }
  }

  return lines.join('\n');
}
