/**
 * Agent Metrics Logger
 *
 * Simple file-based logging for agent metrics capture events.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

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
}

let currentConfig: LoggerConfig = { ...DEFAULT_CONFIG };

/**
 * Configure the logger
 */
export function configureLogger(config: Partial<LoggerConfig>): void {
  currentConfig = { ...currentConfig, ...config };
}

/**
 * Get current logger configuration
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
 * Log at debug level
 */
export function debug(message: string, data?: Record<string, unknown>): void {
  writeLog('debug', message, data);
}

/**
 * Log at info level
 */
export function info(message: string, data?: Record<string, unknown>): void {
  writeLog('info', message, data);
}

/**
 * Log at warn level
 */
export function warn(message: string, data?: Record<string, unknown>): void {
  writeLog('warn', message, data);
}

/**
 * Log at error level
 */
export function error(message: string, data?: Record<string, unknown>): void {
  writeLog('error', message, data);
}

/**
 * Log metrics capture event
 */
export function logMetricsCapture(
  agentId: string,
  sessionId: string,
  metrics: {
    model?: string;
    duration_ms?: number;
    tokens?: {
      input: number;
      output: number;
      cache_creation: number;
      cache_read: number;
      total_effective: number;
    };
    execution?: {
      tool_use_count: number;
      error_count: number;
    };
  },
  options?: {
    validatorName?: string;
    projectPath?: string;
    source?: 'hook' | 'cli' | 'api';
  }
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
    validator: options?.validatorName,
    project: options?.projectPath,
    source: options?.source || 'unknown',
  });
}

/**
 * Log buffer operation
 */
export function logBufferOperation(
  operation: 'append' | 'read' | 'query' | 'cleanup' | 'clear',
  details: Record<string, unknown>
): void {
  debug(`Buffer ${operation}`, details);
}

/**
 * Read recent log entries
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
 * Get log file statistics
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

  try {
    if (fs.existsSync(currentConfig.logPath)) {
      stats.exists = true;
      stats.sizeBytes = fs.statSync(currentConfig.logPath).size;

      const content = fs.readFileSync(currentConfig.logPath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      stats.lineCount = lines.length;

      if (lines.length > 0) {
        // Extract timestamp from first and last lines
        const timestampRegex = /^\[([^\]]+)\]/;
        const firstMatch = lines[0].match(timestampRegex);
        const lastMatch = lines[lines.length - 1].match(timestampRegex);
        stats.oldestEntry = firstMatch?.[1] || null;
        stats.newestEntry = lastMatch?.[1] || null;
      }
    }

    // Count rotated files
    for (let i = 1; i <= currentConfig.maxFiles; i++) {
      if (fs.existsSync(`${currentConfig.logPath}.${i}`)) {
        stats.rotatedFiles++;
      }
    }
  } catch {
    // Ignore errors
  }

  return stats;
}
