/**
 * Agent Metrics Logger
 *
 * Simple file-based logging for agent metrics capture events.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { AgentMetrics } from './types.js';

/**
 * Log severity level. Ordered debug < info < warn < error; `LoggerConfig.minLevel`
 * is a floor — entries below it are dropped, entries at or above it are written.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Process-wide logger configuration. Mutated only via {@link configureLogger}
 * and read via {@link getLoggerConfig}; never assign to a module-level config
 * object directly.
 */
export interface LoggerConfig {
  /** Path to log file */
  logPath: string;
  /** Minimum log level to write */
  minLevel: LogLevel;
  /** Whether logging is enabled */
  enabled: boolean;
  /** Maximum log file size in bytes before rotation (default: 10MB) */
  maxFileSize: number;
  /** Number of rotated files to keep (default: 3) */
  maxFiles: number;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const DEFAULT_CONFIG: LoggerConfig = {
  logPath: path.join(os.homedir(), '.claude', 'agent-metrics.log'),
  minLevel: 'info',
  enabled: true,
  maxFileSize: 10 * 1024 * 1024, // 10MB
  maxFiles: 3,
};

/**
 * Log file statistics returned by getLogStats
 */
export interface LogStats {
  /** Whether the log file exists */
  exists: boolean;
  /** Size of log file in bytes */
  sizeBytes: number;
  /** Number of lines in the log file */
  lineCount: number;
  /** ISO timestamp of oldest log entry, or null if empty */
  oldestEntry: string | null;
  /** ISO timestamp of newest log entry, or null if empty */
  newestEntry: string | null;
  /** Number of rotated log files */
  rotatedFiles: number;
  /**
   * Set when the file exists (existsSync succeeded) but stat-ing or reading it
   * failed — e.g. EACCES, EISDIR, or the rotation race where rotateLogFile
   * renames the file between existsSync and statSync. When set,
   * lineCount/oldestEntry/newestEntry are reset to their unknown values
   * (0/null/null) rather than left at a stale or partial read; sizeBytes is
   * trustworthy only if statSync itself succeeded (it stays 0 otherwise).
   */
  readError?: string;
}

let currentConfig: LoggerConfig = { ...DEFAULT_CONFIG };

/**
 * Type guard for {@link LogLevel}. Uses `hasOwnProperty` rather than the `in`
 * operator so inherited Object.prototype keys (e.g. `'constructor'`) cannot
 * pass as a valid level.
 */
function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(LOG_LEVELS, value);
}

/** `maxFiles` must be a positive integer (at least 1 rotated file kept). */
function isValidMaxFiles(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/** `maxFileSize` must be a finite number strictly greater than 0 bytes. */
function isValidMaxFileSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Configure the logger with partial settings. Unspecified fields retain their current values.
 *
 * Without `exactOptionalPropertyTypes` in tsconfig, callers can pass `undefined`
 * or an invalid `minLevel`/`maxFiles`/`maxFileSize` and still typecheck. Such
 * keys are rejected here — warned to stderr and the current value retained
 * (never silently falling back to DEFAULT_CONFIG, which would loosen a value
 * a caller deliberately set) — rather than thrown, since this module must
 * never fail its host on bad input. `maxFiles` must be an integer >= 1;
 * `maxFileSize` must be a finite number > 0. Sibling keys in the same call
 * are unaffected and still applied.
 *
 * @param config - Partial configuration to merge with current settings
 * @see README.md § Logger Functions
 */
export function configureLogger(config: Partial<LoggerConfig>): void {
  const patch: Partial<LoggerConfig> = { ...config };

  for (const key of Object.keys(patch) as (keyof LoggerConfig)[]) {
    if (patch[key] === undefined) {
      process.stderr.write(`Warning: configureLogger ignored "${key}": received undefined\n`);
      delete patch[key];
    }
  }

  if ('minLevel' in patch && !isLogLevel(patch.minLevel)) {
    process.stderr.write(`Warning: configureLogger ignored "minLevel": received ${JSON.stringify(patch.minLevel)}\n`);
    delete patch.minLevel;
  }

  if ('maxFiles' in patch && !isValidMaxFiles(patch.maxFiles)) {
    process.stderr.write(`Warning: configureLogger ignored "maxFiles": received ${JSON.stringify(patch.maxFiles)}; expected an integer >= 1\n`);
    delete patch.maxFiles;
  }

  if ('maxFileSize' in patch && !isValidMaxFileSize(patch.maxFileSize)) {
    process.stderr.write(`Warning: configureLogger ignored "maxFileSize": received ${JSON.stringify(patch.maxFileSize)}; expected a finite number > 0\n`);
    delete patch.maxFileSize;
  }

  currentConfig = { ...currentConfig, ...patch };
}

/**
 * Get a copy of the current logger configuration.
 *
 * @returns A copy of the current LoggerConfig
 */
export function getLoggerConfig(): LoggerConfig {
  return { ...currentConfig };
}

/**
 * Ensure log directory exists
 */
function ensureLogDir(): void {
  const dir = path.dirname(currentConfig.logPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Rotate log files if needed
 */
function rotateIfNeeded(): void {
  try {
    if (!fs.existsSync(currentConfig.logPath)) {
      return;
    }

    const stats = fs.statSync(currentConfig.logPath);
    if (stats.size < currentConfig.maxFileSize) {
      return;
    }

    // Rotate existing files
    for (let i = currentConfig.maxFiles - 1; i >= 1; i--) {
      const oldPath = `${currentConfig.logPath}.${i}`;
      const newPath = `${currentConfig.logPath}.${i + 1}`;
      if (fs.existsSync(oldPath)) {
        if (i === currentConfig.maxFiles - 1) {
          fs.unlinkSync(oldPath); // Delete oldest
        } else {
          fs.renameSync(oldPath, newPath);
        }
      }
    }

    // Rotate current to .1
    fs.renameSync(currentConfig.logPath, `${currentConfig.logPath}.1`);
  } catch (err) {
    process.stderr.write(`Warning: Log rotation failed: ${err instanceof Error ? err.message : 'unknown error'}\n`);
  }
}

/**
 * Format a log entry
 */
function formatLogEntry(
  level: LogLevel,
  message: string,
  data?: Record<string, unknown>
): string {
  const timestamp = new Date().toISOString();
  const levelStr = level.toUpperCase().padEnd(5);

  let entry = `[${timestamp}] ${levelStr} ${message}`;

  if (data && Object.keys(data).length > 0) {
    entry += ` ${JSON.stringify(data)}`;
  }

  return entry + '\n';
}

/**
 * Write a log entry
 */
function writeLog(level: LogLevel, message: string, data?: Record<string, unknown>): void {
  if (!currentConfig.enabled) {
    return;
  }

  if (LOG_LEVELS[level] < LOG_LEVELS[currentConfig.minLevel]) {
    return;
  }

  try {
    ensureLogDir();
    rotateIfNeeded();

    const entry = formatLogEntry(level, message, data);
    fs.appendFileSync(currentConfig.logPath, entry, 'utf-8');
  } catch (err) {
    // Log to stderr as fallback
    process.stderr.write(`Failed to write to log file: ${err instanceof Error ? err.message : 'unknown error'}\n`);
  }
}

/**
 * Log a message at debug level.
 *
 * @param message - The log message
 * @param data - Optional structured data to include
 */
export function debug(message: string, data?: Record<string, unknown>): void {
  writeLog('debug', message, data);
}

/**
 * Log a message at info level.
 *
 * @param message - The log message
 * @param data - Optional structured data to include
 */
export function info(message: string, data?: Record<string, unknown>): void {
  writeLog('info', message, data);
}

/**
 * Log a message at warn level.
 *
 * @param message - The log message
 * @param data - Optional structured data to include
 */
export function warn(message: string, data?: Record<string, unknown>): void {
  writeLog('warn', message, data);
}

/**
 * Log a message at error level.
 *
 * @param message - The log message
 * @param data - Optional structured data to include
 */
export function error(message: string, data?: Record<string, unknown>): void {
  writeLog('error', message, data);
}

/**
 * Options for {@link logMetricsCapture}. In-file only — deliberately not
 * exported from index.ts to minimize the public surface.
 */
interface MetricsCaptureOptions {
  agentName?: string;
  projectPath?: string;
  source?: 'hook' | 'cli' | 'api';
}

/**
 * Log a structured metrics capture event at info level.
 *
 * @param agentId - The agent ID that was captured
 * @param sessionId - The session ID (truncated to 12 chars in output)
 * @param metrics - Metrics data to log (model, duration, tokens, execution)
 * @param options - Optional metadata (agent name, project path, source)
 *
 * @example
 * logMetricsCapture('agent-abc123', 'session-xyz', metrics, {
 *   agentName: 'code-validator',
 *   source: 'hook',
 * });
 */
export function logMetricsCapture(
  agentId: string,
  sessionId: string,
  metrics: Pick<AgentMetrics, 'model' | 'duration_ms' | 'tokens' | 'execution'>,
  options?: MetricsCaptureOptions
): void {
  info('Metrics captured', {
    agent_id: agentId,
    session_id: sessionId.slice(0, 12) + '...',
    model: metrics.model,
    duration_ms: metrics.duration_ms,
    tokens_effective: metrics.tokens?.total_effective,
    tokens_input: metrics.tokens?.input,
    tokens_output: metrics.tokens?.output,
    tool_uses: metrics.execution?.tool_use_count,
    errors: metrics.execution?.error_count,
    agent: options?.agentName,
    project: options?.projectPath,
    source: options?.source || 'unknown',
  });
}

/**
 * Log a buffer operation at debug level.
 *
 * @param operation - The buffer operation type
 * @param details - Structured details about the operation
 */
export function logBufferOperation(
  operation: 'append' | 'read' | 'query' | 'cleanup' | 'clear',
  details: Record<string, unknown>
): void {
  debug(`Buffer ${operation}`, details);
}

/**
 * Read the most recent log entries from the log file.
 *
 * @param lines - Number of lines to return (default: 50)
 * @returns Array of log entry strings, or empty array if file doesn't exist
 */
export function readRecentLogs(lines: number = 50): string[] {
  try {
    if (lines <= 0 || !fs.existsSync(currentConfig.logPath)) {
      return [];
    }

    const content = fs.readFileSync(currentConfig.logPath, 'utf-8');
    const allLines = content.trim().split('\n').filter(Boolean);
    return allLines.slice(-lines);
  } catch {
    return [];
  }
}

/**
 * Get statistics about the current log file.
 *
 * @returns LogStats with file size, line count, timestamps, and rotation info
 */
export function getLogStats(): LogStats {
  const stats: LogStats = {
    exists: false,
    sizeBytes: 0,
    lineCount: 0,
    oldestEntry: null,
    newestEntry: null,
    rotatedFiles: 0,
  };

  if (fs.existsSync(currentConfig.logPath)) {
    stats.exists = true;

    // stat/read are a separate failure mode from existsSync above (EACCES,
    // EISDIR, or the rotation race: rotateLogFile renames the file between
    // existsSync and statSync/readFileSync). A failure must not leave
    // sizeBytes/lineCount/oldestEntry/newestEntry at a stale or
    // partially-computed value — reset them to their unknown state and
    // record why. sizeBytes survives only when statSync itself succeeded.
    try {
      stats.sizeBytes = fs.statSync(currentConfig.logPath).size;
      const content = fs.readFileSync(currentConfig.logPath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      stats.lineCount = lines.length;

      if (lines.length > 0) {
        // Extract timestamp from first and last lines
        const timestampRegex = /^\[([^\]]+)\]/;
        const firstMatch = lines[0]?.match(timestampRegex);
        const lastMatch = lines[lines.length - 1]?.match(timestampRegex);
        stats.oldestEntry = firstMatch?.[1] || null;
        stats.newestEntry = lastMatch?.[1] || null;
      }
    } catch (err) {
      stats.lineCount = 0;
      stats.oldestEntry = null;
      stats.newestEntry = null;
      stats.readError = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Warning: Failed to read log file for stats: ${stats.readError}\n`);
    }
  }

  // Count rotated files
  for (let i = 1; i <= currentConfig.maxFiles; i++) {
    if (fs.existsSync(`${currentConfig.logPath}.${i}`)) {
      stats.rotatedFiles++;
    }
  }

  return stats;
}
