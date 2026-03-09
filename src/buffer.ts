/**
 * Agent Metrics Buffer
 *
 * Global buffer for storing captured agent metrics.
 * Designed for future Redis migration - all operations go through this interface.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { AgentMetrics } from './types.js';
import { logMetricsCapture, logBufferOperation } from './logger.js';

/**
 * Buffer entry stored in the global metrics buffer
 */
export interface BufferEntry {
  /** Agent ID */
  agent_id: string;
  /** Session ID that spawned this agent */
  session_id: string;
  /** Timestamp when metrics were captured (hook fired) */
  captured_at: string;
  /** When the agent actually finished (from metrics.end_time) */
  end_time: string;
  /** TTL expiry timestamp */
  expires_at: string;
  /** Full metrics data */
  metrics: AgentMetrics;
  /** Optional agent name (if detected from transcript) */
  agent_name?: string;
  /** Optional project path */
  project_path?: string;
}

/**
 * Buffer configuration
 */
export interface BufferConfig {
  /** Path to buffer file */
  bufferPath: string;
  /** Default TTL in milliseconds (default: 24 hours) */
  defaultTTL: number;
  /** Lock acquisition timeout in milliseconds (default: 5000) */
  lockTimeoutMs?: number;
}

const DEFAULT_CONFIG: BufferConfig = {
  bufferPath: path.join(os.homedir(), '.claude', 'agent-metrics-buffer.jsonl'),
  defaultTTL: 24 * 60 * 60 * 1000, // 24 hours
};

/**
 * Buffer statistics returned by getBufferStats
 */
export interface BufferStats {
  /** Total number of entries in the buffer */
  totalEntries: number;
  /** Number of non-expired entries */
  validEntries: number;
  /** Number of expired entries */
  expiredEntries: number;
  /** Number of unique session IDs */
  uniqueSessions: number;
  /** Number of unique agent IDs */
  uniqueAgents: number;
  /** ISO timestamp of oldest entry, or null if empty */
  oldestEntry: string | null;
  /** ISO timestamp of newest entry, or null if empty */
  newestEntry: string | null;
  /** Size of buffer file in bytes */
  bufferSizeBytes: number;
}

/**
 * Serialize a single entry to a JSONL line (with newline).
 */
function toJsonlLine(entry: BufferEntry): string {
  return JSON.stringify(entry) + '\n';
}

/**
 * Serialize multiple entries to JSONL content.
 * Returns empty string for empty array.
 */
function toJsonlContent(entries: BufferEntry[]): string {
  if (entries.length === 0) return '';
  return entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

/**
 * Validate that a parsed object has the required BufferEntry shape.
 * Returns true if valid, false if missing required fields.
 * Note: end_time is optional for backwards compatibility with older entries.
 */
function isValidBufferEntry(obj: unknown): obj is BufferEntry {
  if (!obj || typeof obj !== 'object') return false;
  const entry = obj as Record<string, unknown>; // safe: guarded by typeof check above

  // Check required string fields
  if (typeof entry.agent_id !== 'string') return false;
  if (typeof entry.session_id !== 'string') return false;
  if (typeof entry.captured_at !== 'string') return false;
  if (typeof entry.expires_at !== 'string') return false;

  // Check metrics object exists
  if (!entry.metrics || typeof entry.metrics !== 'object') return false;

  // Backfill end_time from metrics if missing (backwards compatibility)
  if (!entry.end_time && entry.metrics) {
    const metrics = entry.metrics as Record<string, unknown>;
    if (typeof metrics.end_time === 'string') {
      entry.end_time = metrics.end_time;
    }
  }

  return true;
}

/**
 * Ensure buffer directory exists
 */
function ensureBufferDir(config: BufferConfig = DEFAULT_CONFIG): void {
  const dir = path.dirname(config.bufferPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Acquire a file lock for safe concurrent access.
 * Uses a spinlock with exponential backoff.
 *
 * ## Why Busy-Wait?
 *
 * This function uses a synchronous busy-wait loop instead of async delay
 * because it's called from `appendToBuffer()` which must be synchronous.
 * The synchronous requirement comes from the Claude Code SubagentStop hook
 * context, where the hook handler must complete before returning the
 * JSON response to stdout.
 *
 * Node.js provides no built-in synchronous sleep. Alternatives considered:
 *
 * 1. **Atomics.wait()**: Requires SharedArrayBuffer, unavailable in this context
 * 2. **child_process.spawnSync('sleep')**: Works but adds 5-10ms overhead per call
 * 3. **Async/Promise-based**: Would require making appendToBuffer async,
 *    breaking the hook's synchronous contract
 *
 * The busy-wait is acceptable here because:
 * - Lock contention is rare (one hook per agent completion)
 * - Exponential backoff caps at 100ms, limiting CPU spin time
 * - Total wait time is bounded by maxWaitMs (default 5s)
 * - The 30-second stale lock detection handles dead processes
 *
 * If profiling shows this as a hot path, consider the spawnSync approach
 * or converting the hook to async if Claude Code supports it.
 *
 * @param lockPath - Path to the lock file
 * @param maxWaitMs - Maximum time to wait for lock acquisition
 * @returns true if lock acquired, false if timeout
 */
function acquireLock(lockPath: string, maxWaitMs: number = 5000): boolean {
  const startTime = Date.now();
  let delay = 10;

  while (Date.now() - startTime < maxWaitMs) {
    try {
      // Exclusive create - fails if file exists
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      return true;
    } catch (err) {
      // Check if lock is stale (holder process died)
      try {
        const stat = fs.statSync(lockPath);
        // If lock is older than 30 seconds, assume it's stale
        if (Date.now() - stat.mtimeMs > 30000) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        // Lock file was removed, retry
        continue;
      }

      // Wait with exponential backoff (see function doc for busy-wait rationale)
      const waitTime = Math.min(delay, 100);
      const endWait = Date.now() + waitTime;
      while (Date.now() < endWait) {
        // Busy-wait: synchronous delay required for hook context
      }
      delay = Math.min(delay * 2, 100);
    }
  }

  return false;
}

/**
 * Release a file lock
 */
function releaseLock(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Lock already released or never acquired
  }
}

/**
 * Append a metrics entry to the buffer.
 * Uses file locking to prevent race conditions with concurrent writers.
 *
 * @param metrics - The agent metrics to store
 * @param options - Optional configuration for the buffer entry
 * @param options.agentName - Name of the agent that produced these metrics
 * @param options.projectPath - Project path where the agent ran
 * @param options.ttlMs - Time-to-live in milliseconds (default: 24 hours)
 * @param options.config - Buffer configuration override
 * @param options.source - Source of capture: 'hook', 'cli', or 'api'
 * @returns The created buffer entry
 */
export function appendToBuffer(
  metrics: AgentMetrics,
  options: {
    agentName?: string;
    projectPath?: string;
    ttlMs?: number;
    config?: BufferConfig;
    /** Source of the capture: 'hook', 'cli', or 'api' */
    source?: 'hook' | 'cli' | 'api';
  } = {}
): BufferEntry {
  const config = options.config || DEFAULT_CONFIG;
  const ttl = options.ttlMs ?? config.defaultTTL;

  ensureBufferDir(config);

  const now = new Date();
  const entry: BufferEntry = {
    agent_id: metrics.agent_id,
    session_id: metrics.session_id,
    captured_at: now.toISOString(),
    end_time: metrics.end_time,
    expires_at: new Date(now.getTime() + ttl).toISOString(),
    metrics,
    agent_name: options.agentName,
    project_path: options.projectPath,
  };

  // Acquire lock for safe concurrent access
  const lockPath = config.bufferPath + '.lock';
  const lockTimeoutMs = config.lockTimeoutMs ?? 5000;
  const lockAcquired = acquireLock(lockPath, lockTimeoutMs);

  if (!lockAcquired) {
    process.stderr.write(`Warning: Could not acquire lock for ${config.bufferPath}, proceeding without lock\n`);
  }

  try {
    // Append to JSONL file
    fs.appendFileSync(config.bufferPath, toJsonlLine(entry), 'utf-8');

    // Log the metrics capture
    logMetricsCapture(
      metrics.agent_id,
      metrics.session_id,
      {
        model: metrics.model,
        duration_ms: metrics.duration_ms,
        tokens: metrics.tokens,
        execution: metrics.execution,
      },
      {
        agentName: options.agentName,
        projectPath: options.projectPath,
        source: options.source || 'api',
      }
    );

    logBufferOperation('append', {
      agent_id: metrics.agent_id,
      buffer_path: config.bufferPath,
    });
  } finally {
    if (lockAcquired) {
      releaseLock(lockPath);
    }
  }

  return entry;
}

/**
 * Read all entries from the buffer (including expired).
 *
 * @param config - Buffer configuration (optional, uses defaults)
 * @returns Array of all buffer entries, including expired ones
 */
export function readBuffer(config: BufferConfig = DEFAULT_CONFIG): BufferEntry[] {
  if (!fs.existsSync(config.bufferPath)) {
    return [];
  }

  const content = fs.readFileSync(config.bufferPath, 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);

  const entries: BufferEntry[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (isValidBufferEntry(parsed)) {
        entries.push(parsed);
      } else {
        process.stderr.write('Warning: Skipping buffer entry with missing required fields\n');
      }
    } catch (err) {
      // Log malformed lines so users have visibility into data issues
      process.stderr.write(`Warning: Skipping malformed buffer entry: ${err instanceof Error ? err.message : 'parse error'}\n`);
    }
  }

  return entries;
}

/**
 * Read only non-expired entries from the buffer.
 *
 * @param config - Buffer configuration (optional, uses defaults)
 * @returns Array of valid (non-expired) buffer entries
 */
export function readValidEntries(config: BufferConfig = DEFAULT_CONFIG): BufferEntry[] {
  const now = new Date();
  return readBuffer(config).filter(
    (entry) => new Date(entry.expires_at) > now
  );
}

/**
 * Query buffer entries by various criteria.
 *
 * @param query - Query filters
 * @param query.sessionId - Filter by session ID
 * @param query.agentId - Filter by agent ID
 * @param query.agentName - Filter by validator name
 * @param query.projectPath - Filter by project path
 * @param query.since - Only include entries captured after this date
 * @param query.endTimeAfter - Only include entries where agent finished after this date
 * @param query.endTimeBefore - Only include entries where agent finished before this date
 * @param query.includeExpired - Include expired entries (default: false)
 * @param config - Buffer configuration (optional, uses defaults)
 * @returns Array of matching buffer entries
 */
export function queryBuffer(
  query: {
    sessionId?: string;
    agentId?: string;
    agentName?: string;
    projectPath?: string;
    since?: Date;
    endTimeAfter?: Date;
    endTimeBefore?: Date;
    includeExpired?: boolean;
  },
  config: BufferConfig = DEFAULT_CONFIG
): BufferEntry[] {
  const entries = query.includeExpired
    ? readBuffer(config)
    : readValidEntries(config);

  return entries.filter((entry) => {
    if (query.sessionId && entry.session_id !== query.sessionId) return false;
    if (query.agentId && entry.agent_id !== query.agentId) return false;
    if (query.agentName && entry.agent_name !== query.agentName) return false;
    if (query.projectPath && entry.project_path !== query.projectPath) return false;
    if (query.since && new Date(entry.captured_at) < query.since) return false;
    // Filter by agent end_time (when the agent actually finished)
    const endTime = entry.end_time || entry.metrics.end_time;
    if (query.endTimeAfter && endTime && new Date(endTime) < query.endTimeAfter) return false;
    if (query.endTimeBefore && endTime && new Date(endTime) > query.endTimeBefore) return false;
    return true;
  });
}

/**
 * Get the most recent entry for a session.
 *
 * @param sessionId - The session ID to look up
 * @param config - Buffer configuration (optional, uses defaults)
 * @returns The most recent buffer entry for the session, or null if not found
 */
export function getLatestForSession(
  sessionId: string,
  config: BufferConfig = DEFAULT_CONFIG
): BufferEntry | null {
  const entries = queryBuffer({ sessionId }, config);
  if (entries.length === 0) return null;

  // Sort by captured_at descending
  entries.sort((a, b) =>
    new Date(b.captured_at).getTime() - new Date(a.captured_at).getTime()
  );

  return entries[0] ?? null;
}

/**
 * Get all entries for a session (for multi-validator workflows).
 * Returns entries sorted by capture time (oldest first).
 *
 * @param sessionId - The session ID to look up
 * @param config - Buffer configuration (optional, uses defaults)
 * @returns Array of buffer entries for the session, sorted chronologically
 */
export function getAllForSession(
  sessionId: string,
  config: BufferConfig = DEFAULT_CONFIG
): BufferEntry[] {
  return queryBuffer({ sessionId }, config).sort((a, b) =>
    new Date(a.captured_at).getTime() - new Date(b.captured_at).getTime()
  );
}

/**
 * Execute a function while holding the buffer file lock.
 * Acquires the lock, runs the function, then releases.
 */
function withFileLock<T>(config: BufferConfig, fn: () => T): T {
  const lockPath = config.bufferPath + '.lock';
  const lockAcquired = acquireLock(lockPath, config.lockTimeoutMs ?? 5000);

  try {
    return fn();
  } finally {
    if (lockAcquired) {
      releaseLock(lockPath);
    }
  }
}

/**
 * Remove expired entries from the buffer (garbage collection).
 *
 * @param config - Buffer configuration (optional, uses defaults)
 * @returns Number of entries removed
 */
export function cleanupExpired(config: BufferConfig = DEFAULT_CONFIG): number {
  return withFileLock(config, () => {
    const allEntries = readBuffer(config);
    const now = new Date();
    const validEntries = allEntries.filter((entry) => new Date(entry.expires_at) > now);
    const removedCount = allEntries.length - validEntries.length;

    if (removedCount > 0) {
      fs.writeFileSync(config.bufferPath, toJsonlContent(validEntries), 'utf-8');
    }

    return removedCount;
  });
}

/**
 * Clear all entries for a session (after successful save to tracker).
 *
 * @param sessionId - The session ID to clear
 * @param config - Buffer configuration (optional, uses defaults)
 * @returns Number of entries removed
 */
export function clearSession(
  sessionId: string,
  config: BufferConfig = DEFAULT_CONFIG
): number {
  return withFileLock(config, () => {
    const allEntries = readBuffer(config);
    const remaining = allEntries.filter((e) => e.session_id !== sessionId);
    const removedCount = allEntries.length - remaining.length;

    if (removedCount > 0) {
      fs.writeFileSync(config.bufferPath, toJsonlContent(remaining), 'utf-8');
    }

    return removedCount;
  });
}

/**
 * Clear specific agent entries (after processing).
 *
 * @param agentIds - Array of agent IDs to remove
 * @param config - Buffer configuration (optional, uses defaults)
 * @returns Number of entries removed
 */
export function clearAgents(
  agentIds: string[],
  config: BufferConfig = DEFAULT_CONFIG
): number {
  return withFileLock(config, () => {
    const allEntries = readBuffer(config);
    const remaining = allEntries.filter((e) => !agentIds.includes(e.agent_id));
    const removedCount = allEntries.length - remaining.length;

    if (removedCount > 0) {
      fs.writeFileSync(config.bufferPath, toJsonlContent(remaining), 'utf-8');
    }

    return removedCount;
  });
}

/**
 * Get buffer statistics.
 *
 * @param config - Buffer configuration (optional, uses defaults)
 * @returns Object containing buffer statistics
 */
export function getBufferStats(config: BufferConfig = DEFAULT_CONFIG): BufferStats {
  const all = readBuffer(config);
  const now = new Date();

  // Single pass to collect unique sessions/agents and count valid entries
  const sessions = new Set<string>();
  const agents = new Set<string>();
  let validCount = 0;
  let oldest: string | null = null;
  let newest: string | null = null;

  for (const entry of all) {
    sessions.add(entry.session_id);
    agents.add(entry.agent_id);

    if (new Date(entry.expires_at) > now) {
      validCount++;
    }

    // Track oldest/newest by timestamp comparison
    if (!oldest || entry.captured_at < oldest) {
      oldest = entry.captured_at;
    }
    if (!newest || entry.captured_at > newest) {
      newest = entry.captured_at;
    }
  }

  let bufferSize = 0;
  try {
    bufferSize = fs.statSync(config.bufferPath).size;
  } catch {
    // File doesn't exist
  }

  return {
    totalEntries: all.length,
    validEntries: validCount,
    expiredEntries: all.length - validCount,
    uniqueSessions: sessions.size,
    uniqueAgents: agents.size,
    oldestEntry: oldest,
    newestEntry: newest,
    bufferSizeBytes: bufferSize,
  };
}

/**
 * Tracker-compatible validator format
 */
export interface TrackerAgentFormat {
  name: string;
  model: string;
  tokens: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_tokens: number;
    cache_read_tokens: number;
    total_effective_tokens: number;
  };
  duration_ms: number;
}

/**
 * Convert buffer entries to validation tracker format.
 *
 * This format is ready for use with save_run and includes
 * the full cache token breakdown.
 *
 * @param entries - Buffer entries to convert
 * @returns Array of tracker-compatible validator objects
 */
export function entriesToTrackerFormat(entries: BufferEntry[]): TrackerAgentFormat[] {
  return entries.map((e) => ({
    name: e.agent_name || 'unknown',
    model: e.metrics.model,
    tokens: {
      input_tokens: e.metrics.tokens.input,
      output_tokens: e.metrics.tokens.output,
      cache_creation_tokens: e.metrics.tokens.cache_creation,
      cache_read_tokens: e.metrics.tokens.cache_read,
      total_effective_tokens: e.metrics.tokens.total_effective,
    },
    duration_ms: e.metrics.duration_ms,
  }));
}
