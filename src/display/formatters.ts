/**
 * Display Formatters
 *
 * Shared display/formatting functions for CLI output.
 * All formatters return strings for testability.
 */

import { getBufferStats, type BufferEntry, type BufferStats } from '../buffer.js';
import { formatDuration, formatTokens, formatModelName } from '../utils.js';
import type { AgentMetrics } from '../types.js';

/**
 * Format buffer statistics as a displayable string.
 *
 * @param title - Title to display at the top
 * @param stats - Buffer statistics to format (fetched live if not provided)
 * @returns Formatted string ready for console output
 */
export function formatBufferStatus(title: string, stats: BufferStats): string {
  const s = stats;
  const lines: string[] = [];

  lines.push(title);
  lines.push('═'.repeat(50));
  lines.push('');
  lines.push(`Total entries:     ${s.totalEntries}`);
  lines.push(`Valid entries:     ${s.validEntries}`);
  lines.push(`Expired entries:   ${s.expiredEntries} (eligible for GC on next capture)`);
  lines.push(`Unique sessions:   ${s.uniqueSessions}`);
  lines.push(`Unique agents:     ${s.uniqueAgents}`);
  lines.push(`Buffer size:       ${(s.bufferSizeBytes / 1024).toFixed(1)} KB`);
  lines.push('');
  if (s.oldestEntry) {
    lines.push(`Oldest entry:      ${s.oldestEntry}`);
  }
  if (s.newestEntry) {
    lines.push(`Newest entry:      ${s.newestEntry}`);
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
  const stats = getBufferStats();
  console.log(formatBufferStatus(title, stats));
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
    'Agent ID   │  Agent Name                 │  Duration  │  Tokens    │  Captured'
  );
  lines.push('─'.repeat(100));

  for (const entry of entries) {
    const agentName = (entry.agent_name || projectName(entry.project_path) || entry.agent_id)
      .slice(0, 25)
      .padEnd(25);
    const duration = entry.metrics.duration_formatted.padEnd(8);
    const tokens = formatTokens(entry.metrics.tokens.total_effective).padEnd(8);
    const captured = new Date(entry.captured_at).toLocaleString().slice(0, 20);

    lines.push(
      `${entry.agent_id.padEnd(10)}  │  ${agentName}  │  ${duration}  │  ${tokens}  │  ${captured}`
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
    const agentName = (entry.agent_name || 'unknown').padEnd(25);
    const dur = entry.metrics.duration_formatted.padEnd(8);
    const tok = formatTokens(entry.metrics.tokens.total_effective).padEnd(8);
    lines.push(`${entry.agent_id}  │  ${agentName}  │  ${dur}  │  ${tok}`);
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
/**
 * Compute cache hit rate as a percentage.
 * Formula: cache_read / (cache_read + cache_creation + input) * 100
 */
function cacheHitRate(tokens: { cache_read: number; cache_creation: number; input: number }): number {
  const total = tokens.cache_read + tokens.cache_creation + tokens.input;
  if (total === 0) return 0;
  return Math.round((tokens.cache_read / total) * 100);
}

/**
 * Extract a readable project name from a full path.
 * Uses the last path segment (directory name) without truncation.
 */
function projectName(projectPath: string | undefined): string {
  if (!projectPath) return '';
  const segments = projectPath.split('/').filter(Boolean);
  return segments[segments.length - 1] || '';
}

/**
 * Format a single report row for an entry.
 */
function formatReportRow(entry: BufferEntry, indent: string = ''): string {
  const name = (entry.agent_name || projectName(entry.project_path) || entry.agent_id).slice(0, 24).padEnd(24);
  const modelShort = formatModelName(entry.metrics.model).padEnd(10);
  const duration = entry.metrics.duration_formatted.padEnd(8);
  const tokens = formatTokens(entry.metrics.tokens.total_effective).padEnd(8);
  const cache = `${cacheHitRate(entry.metrics.tokens).toString()}%`.padStart(5);
  const tools = entry.metrics.execution.tool_use_count.toString().padStart(5);
  const id = indent ? entry.agent_id.slice(0, 16).padEnd(16) : entry.agent_id.padEnd(18);

  return `${indent}${id}  │  ${name}  │  ${modelShort}  │  ${duration}  │  ${tokens}  │  ${cache}  │  ${tools}`;
}

export function formatReport(entries: BufferEntry[]): string {
  if (entries.length === 0) {
    return 'No metrics captured yet.';
  }

  const lines: string[] = [];
  const W = 110;
  lines.push('Recent Agent Metrics');
  lines.push('═'.repeat(W));
  lines.push('');
  lines.push(
    'Agent ID            │  Agent Name              │  Model      │  Duration  │  Tokens   │  Cache  │  Tools'
  );
  lines.push('─'.repeat(W));

  let totalDuration = 0;
  let totalTokens = 0;
  let totalTools = 0;

  // Group entries by prompt_id for workflow grouping
  const groups = new Map<string, BufferEntry[]>();
  const ungrouped: BufferEntry[] = [];

  for (const entry of entries) {
    const pid = entry.prompt_id;
    if (pid) {
      const group = groups.get(pid) ?? [];
      group.push(entry);
      groups.set(pid, group);
    } else {
      ungrouped.push(entry);
    }
  }

  // Render grouped entries (groups with 2+ agents get a header)
  for (const [, group] of groups) {
    if (group.length >= 2) {
      const groupDuration = group.reduce((sum, e) => sum + e.metrics.duration_ms, 0);
      const groupTokens = group.reduce((sum, e) => sum + e.metrics.tokens.total_effective, 0);
      const project = projectName(group[0]?.project_path);
      lines.push(`  ┌ ${project} (${group.length} agents, ${formatDuration(groupDuration)} total, ${formatTokens(groupTokens)} tokens)`);
      for (const entry of group) {
        lines.push(formatReportRow(entry, '  │ '));
        totalDuration += entry.metrics.duration_ms;
        totalTokens += entry.metrics.tokens.total_effective;
        totalTools += entry.metrics.execution.tool_use_count;
      }
      lines.push('  └');
    } else {
      // Single-agent "group" — render flat
      for (const entry of group) {
        lines.push(formatReportRow(entry));
        totalDuration += entry.metrics.duration_ms;
        totalTokens += entry.metrics.tokens.total_effective;
        totalTools += entry.metrics.execution.tool_use_count;
      }
    }
  }

  // Render ungrouped entries
  for (const entry of ungrouped) {
    lines.push(formatReportRow(entry));
    totalDuration += entry.metrics.duration_ms;
    totalTokens += entry.metrics.tokens.total_effective;
    totalTools += entry.metrics.execution.tool_use_count;
  }

  lines.push('─'.repeat(W));
  const totLabel = 'TOTAL'.padEnd(18);
  const totEmpty = ''.padEnd(24);
  const totModelEmpty = ''.padEnd(10);
  const totDur = formatDuration(totalDuration).padEnd(8);
  const totTok = formatTokens(totalTokens).padEnd(8);
  const totCache = ''.padStart(5);
  const totToolsStr = totalTools.toString().padStart(5);
  lines.push(`${totLabel}  │  ${totEmpty}  │  ${totModelEmpty}  │  ${totDur}  │  ${totTok}  │  ${totCache}  │  ${totToolsStr}`);
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

  // Summary of found vs not-found
  const foundCount = items.filter(i => i.metrics).length;
  const notFoundCount = items.length - foundCount;
  if (notFoundCount > 0) {
    lines.push('');
    lines.push(`  ${foundCount} found, ${notFoundCount} not found`);
    lines.push('');
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
export interface LogDisplayStats {
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
export function formatLogStatus(stats: LogDisplayStats): string {
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
