/**
 * Agent Metrics Buffer
 *
 * Global buffer for storing captured agent metrics.
 * Designed for future Redis migration - all operations go through this interface.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { AgentMetrics } from './types.js';
import { logMetricsCapture, logBufferOperation } from './logger.js';
import { acquireLock, releaseLock, withFileLock } from './lock.js';

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
  /** Prompt ID — shared by all agents from the same user message (workflow grouping) */
  prompt_id?: string;
}

/**
 * Buffer configuration
 */
export interface BufferConfig {
  /** Path to buffer file */
  bufferPath: string;
  /** Default TTL in milliseconds (default: 30 days, matching Claude Code transcript retention) */
  defaultTTL: number;
  /** Lock acquisition timeout in milliseconds (default: 5000) */
  lockTimeoutMs?: number;
}

function defaultConfig(): BufferConfig {
  return {
    bufferPath: path.join(os.homedir(), '.claude', 'agent-metrics-buffer.jsonl'),
    // 30 days, aligned with Claude Code's transcript retention (cleanupPeriodDays
    // default). The buffer is a cache over transcripts; expiring entries while
    // their source transcripts still exist just forces re-extraction for no
    // storage win (~1KB/entry). Entries are GC'd opportunistically on append.
    defaultTTL: 30 * 24 * 60 * 60 * 1000,
  };
}

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

  // F5: metrics.tokens must exist. Consumers (entriesToTrackerFormat) dereference
  // metrics.tokens.* unconditionally; an entry with `metrics` but no `tokens` would
  // TypeError-crash them — and one bad entry takes down the whole save_run batch.
  const metrics = entry.metrics as Record<string, unknown>;
  if (!metrics.tokens || typeof metrics.tokens !== 'object') return false;

  // The five core token fields must be NUMBERS, not merely present: a
  // `tokens: {}` entry would pass an existence check but flow undefined
  // token counts into tracker rows. This guard defends the data, not just
  // the TypeError. (Optional cross-harness components stay optional.)
  const tokens = metrics.tokens as Record<string, unknown>;
  for (const field of ['input', 'output', 'cache_creation', 'cache_read', 'total_effective']) {
    if (typeof tokens[field] !== 'number') return false;
  }

  return true;
}

/**
 * Ensure buffer directory exists
 */
function ensureBufferDir(config: BufferConfig = defaultConfig()): void {
  const dir = path.dirname(config.bufferPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Check if a buffer entry has expired relative to a given time */
function isExpired(entry: BufferEntry, now: Date): boolean {
  return new Date(entry.expires_at) <= now;
}

/**
 * Minimum interval between opportunistic GC runs triggered by appendToBuffer.
 * GC reads and rewrites the full buffer — running it on every append wastes I/O
 * and creates lock contention when agents fire in bursts. With a 60s gate, GC
 * runs at most once per minute (the buffer grows by at most a few KB between
 * runs, and TTL is 30 days). Callers needing immediate GC invoke cleanupExpired
 * directly.
 */
const GC_INTERVAL_MS = 60_000;
/** Timestamp of the last successful opportunistic GC run (module-level, process-scoped). */
let lastGcAt = 0;

/**
 * Append a metrics entry to the buffer.
 * Uses file locking to prevent race conditions with concurrent writers.
 *
 * @param metrics - The agent metrics to store
 * @param options - Optional configuration for the buffer entry
 * @param options.agentName - Name of the agent that produced these metrics
 * @param options.projectPath - Project path where the agent ran
 * @param options.ttlMs - Time-to-live in milliseconds (default: 30 days)
 * @param options.config - Buffer configuration override
 * @param options.source - Source of capture: 'hook', 'cli', or 'api'
 * @returns The created buffer entry, or null if the append was skipped because
 *   the buffer lock could not be acquired (fail-closed under lock contention)
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
): BufferEntry | null {
  const config = options.config || defaultConfig();
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
    prompt_id: metrics.prompt_id ?? undefined,
  };

  // Acquire lock for safe concurrent access
  const lockPath = config.bufferPath + '.lock';
  const lockTimeoutMs = config.lockTimeoutMs ?? 5000;
  const lockAcquired = acquireLock(lockPath, lockTimeoutMs);

  if (!lockAcquired) {
    // Fail closed. Under sustained parallel-SubagentStop contention an unlocked
    // appendFileSync of a multi-KB line can interleave with a concurrent writer
    // and corrupt both lines (readBuffer then silently drops them — losing two
    // metrics plus leaving garbage). Skipping loses at most this one best-effort
    // metric, deterministically, and never corrupts another writer's entry. The
    // 5s exponential-backoff retry in acquireLock has already run, so this only
    // fires when the lock is genuinely stuck.
    process.stderr.write(
      `Warning: Could not acquire lock for ${config.bufferPath} within ${lockTimeoutMs}ms; skipping metric capture to avoid buffer corruption\n`
    );
    return null;
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

  // Opportunistic GC. Must run after the append lock is released —
  // cleanupExpired takes the same (non-reentrant) file lock. Best-effort:
  // a GC failure must never fail the capture that triggered it.
  // Time-gated: skip if GC ran within GC_INTERVAL_MS to avoid full
  // read+rewrite on every append during agent bursts. Callers needing
  // immediate GC invoke cleanupExpired() directly.
  const nowMs = Date.now();
  if (nowMs - lastGcAt >= GC_INTERVAL_MS) {
    try {
      cleanupExpired(config);
      lastGcAt = nowMs;
    } catch {
      // ignore — next append retries
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
export function readBuffer(config: BufferConfig = defaultConfig()): BufferEntry[] {
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
        // Backfill end_time from metrics if missing (backwards compatibility)
        if (!parsed.end_time && typeof parsed.metrics.end_time === 'string') {
          parsed.end_time = parsed.metrics.end_time;
        }
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
export function readValidEntries(config: BufferConfig = defaultConfig()): BufferEntry[] {
  const now = new Date();
  return readBuffer(config).filter((entry) => !isExpired(entry, now));
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
  config: BufferConfig = defaultConfig()
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
  config: BufferConfig = defaultConfig()
): BufferEntry | null {
  const entries = queryBuffer({ sessionId }, config);
  if (entries.length === 0) return null;

  // Single-pass max by captured_at — O(n) instead of O(n log n) sort
  return entries.reduce((latest, entry) =>
    entry.captured_at > latest.captured_at ? entry : latest
  );
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
  config: BufferConfig = defaultConfig()
): BufferEntry[] {
  return queryBuffer({ sessionId }, config).sort((a, b) =>
    new Date(a.captured_at).getTime() - new Date(b.captured_at).getTime()
  );
}

/**
 * Remove buffer entries matching a predicate, under file lock.
 * Reads all entries, keeps those where `keep` returns true, writes back.
 *
 * @param keep - Predicate: return true to keep the entry, false to remove it
 * @param config - Buffer configuration
 * @returns Number of entries removed
 */
function removeWhere(
  keep: (entry: BufferEntry) => boolean,
  config: BufferConfig = defaultConfig(),
): number {
  return withFileLock(config.bufferPath + '.lock', config.lockTimeoutMs ?? 5000, () => {
    const allEntries = readBuffer(config);
    const remaining = allEntries.filter(keep);
    const removedCount = allEntries.length - remaining.length;

    if (removedCount > 0) {
      // Atomic rewrite: write to a sibling temp file then rename into place.
      // A direct writeFileSync truncates-then-writes, so a crash or ENOSPC
      // mid-write would leave the buffer empty or half-written, losing all
      // still-buffered un-shipped metrics (the lock guards concurrency, not
      // crash-atomicity). rename(2) on the same filesystem is atomic, so a
      // crash leaves either the complete old file or the complete new one.
      // Same pattern as the log rotation in logger.ts.
      // Unique temp name per writer: withFileLock is fail-closed, but the
      // 30s stale-lock reclaim (lock.ts) can still hand two live writers
      // the lock when a slow holder exceeds the staleness threshold
      // mid-rewrite. A shared '.tmp' would let them interleave writes into
      // the same file and rename a half-written temp over the buffer,
      // truncating everything. Unique names confine the damage to
      // last-rename-wins (stale snapshot), never a corrupt file. Do NOT
      // simplify to a shared temp name while the stale-reclaim window exists.
      const tmpPath = `${config.bufferPath}.${process.pid}.${randomUUID()}.tmp`;
      fs.writeFileSync(tmpPath, toJsonlContent(remaining), 'utf-8');
      fs.renameSync(tmpPath, config.bufferPath);
    }

    return removedCount;
  });
}

/**
 * Write agent names onto matching buffer entries, under file lock.
 *
 * Used by the extract command to persist caller-supplied names
 * (--agent-name/--agent-names) back to the buffer, so entries captured
 * nameless (no [agent:name] tag) become name-complete for later queries.
 * Caller-supplied names are authoritative and overwrite existing ones.
 *
 * @param names - Map of agent_id to agent name
 * @param config - Buffer configuration (optional, uses defaults)
 * @returns Number of entries updated
 */
export function annotateBufferEntries(
  names: Record<string, string>,
  config: BufferConfig = defaultConfig(),
): number {
  return withFileLock(config.bufferPath + '.lock', config.lockTimeoutMs ?? 5000, () => {
    const allEntries = readBuffer(config);
    let updated = 0;

    for (const entry of allEntries) {
      const name = names[entry.agent_id];
      if (name && entry.agent_name !== name) {
        entry.agent_name = name;
        updated++;
      }
    }

    if (updated > 0) {
      // Same atomic temp-file + rename pattern (and unique-temp-name
      // rationale — stale-reclaim double-holder) as removeWhere.
      const tmpPath = `${config.bufferPath}.${process.pid}.${randomUUID()}.tmp`;
      fs.writeFileSync(tmpPath, toJsonlContent(allEntries), 'utf-8');
      fs.renameSync(tmpPath, config.bufferPath);
    }

    return updated;
  });
}

/**
 * Remove expired entries from the buffer (garbage collection).
 *
 * @param config - Buffer configuration (optional, uses defaults)
 * @returns Number of entries removed
 */
export function cleanupExpired(config: BufferConfig = defaultConfig()): number {
  const now = new Date();
  return removeWhere((entry) => !isExpired(entry, now), config);
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
  config: BufferConfig = defaultConfig()
): number {
  return removeWhere((entry) => entry.session_id !== sessionId, config);
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
  config: BufferConfig = defaultConfig()
): number {
  return removeWhere((entry) => !agentIds.includes(entry.agent_id), config);
}

/**
 * Get buffer statistics.
 *
 * @param config - Buffer configuration (optional, uses defaults)
 * @returns Object containing buffer statistics
 */
export function getBufferStats(config: BufferConfig = defaultConfig()): BufferStats {
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

    if (!isExpired(entry, now)) {
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
  /** Transcript/agent provenance id (v0.7.0). Joins tracker rows to buffer entries and transcripts. */
  agent_id?: string;
  model: string;
  /** Producing harness (v0.6.0). claude-code | codex. */
  harness?: string;
  tokens: {
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
  return entries
    // F5: defense-in-depth — skip any entry missing metrics.tokens rather than
    // TypeError-crash the whole batch (readBuffer already validates, but this
    // function is public and may receive entries from other sources).
    .filter((e) => e?.metrics?.tokens != null)
    .map((e) => ({
    // Fall back to agent_id, not 'unknown': tracker saves enforce unique
    // agent names per run, so multiple nameless entries under a literal
    // 'unknown' would collide (409). The id is unique and joinable.
    name: e.agent_name || e.agent_id,
    agent_id: e.agent_id,
    model: e.metrics.model,
    harness: e.metrics.harness,
    tokens: {
      input_tokens: e.metrics.tokens.input,
      output_tokens: e.metrics.tokens.output,
      cache_creation_tokens: e.metrics.tokens.cache_creation,
      cache_read_tokens: e.metrics.tokens.cache_read,
      total_effective_tokens: e.metrics.tokens.total_effective,
      cached_input_tokens: e.metrics.tokens.cached_input,
      reasoning_output_tokens: e.metrics.tokens.reasoning_output,
      thinking_tokens: e.metrics.tokens.thinking,
      tool_tokens: e.metrics.tokens.tool,
    },
    duration_ms: e.metrics.duration_ms,
  }));
}
