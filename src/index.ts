/**
 * Agent Metrics
 *
 * Extract accurate metrics from Claude Code and Codex agent session files.
 *
 * This module provides:
 * - Extraction functions for agent metrics
 * - Buffer management for auto-captured metrics
 * - Formatting utilities for display and tracker integration
 * - Logger configuration
 *
 * CLI usage: Run `agent-metrics` command (see cli.ts)
 * Programmatic usage: Import functions from this module
 */

// Core extraction functions
export {
  extractAgentMetrics,
  extractMetricsFromFile,
  extractMultipleAgentMetrics,
  formatMetricsSummary,
  toTrackerFormat,
} from './extractor.js';

export type { TrackerTokens, TrackerFormat } from './extractor.js';

// Utility functions
export {
  findAgentFile,
  findRecentAgentFiles,
  findCodexAgentFile,
  findRecentCodexAgentFiles,
  getClaudeProjectsDir,
  getCodexSessionsDir,
  sanitizePathAsFolderName,
  getProjectName,
  extractAgentIdFromFilename,
  extractCodexAgentIdFromFilename,
  parseTimestamp,
  calculateDuration,
  formatDuration,
  formatTokens,
  formatNumber,
  formatModelName,
} from './utils.js';

// Types
export type {
  AgentMetrics,
  TokenMetrics,
  ExecutionMetrics,
  ExtractOptions,
  ExtractFormat,
  MetricsProvider,
  BufferFormat,
  AgentFileLocation,
} from './types.js';

// Buffer functions
export {
  appendToBuffer,
  readBuffer,
  readValidEntries,
  queryBuffer,
  getAllForSession,
  getLatestForSession,
  clearSession,
  clearAgents,
  cleanupExpired,
  getBufferStats,
  entriesToTrackerFormat,
} from './buffer.js';

export type { BufferEntry, BufferConfig, BufferStats, TrackerAgentFormat } from './buffer.js';

// Logger functions
export {
  configureLogger,
  getLoggerConfig,
  readRecentLogs,
  getLogStats,
  debug as logDebug,
  info as logInfo,
  warn as logWarn,
  error as logError,
  logMetricsCapture,
  logBufferOperation,
} from './logger.js';

export type { LogLevel, LoggerConfig, LogStats } from './logger.js';
