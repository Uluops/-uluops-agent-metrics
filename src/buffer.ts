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
import { logMetricsCapture, logBufferOperation, warn } from './logger.js';
import { acquireLock, releaseLock, withFileLock, LockAcquisitionError } from './lock.js';

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
  /**
   * Run ID — orchestrator-minted token grouping all agents in one pipeline run.
   * Absent on rows captured before v0.8.0 and on any agent whose prompt lacked
   * a [run:token] tag (same absence semantics as agent_name). This is a
   * buffer-QUERY key only (drives the --run filter); it is deliberately NOT
   * forwarded into the -f tracker output / save_run agents[] payload, whose
   * schema is strict (additionalProperties:false). See ADR-0004.
   */
  run_id?: string;
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
 * Find the first field a parsed object is missing (or has the wrong type
 * for) relative to the required BufferEntry shape. Returns null when the
 * object satisfies every required field.
 *
 * RULE: `isValidBufferEntry`'s `obj is BufferEntry` assertion is a promise
 * to every downstream consumer that dereferences a field unconditionally —
 * formatters.ts:78,115,163,164,167 (metrics.duration_formatted,
 * metrics.tokens.total_effective, metrics.model, metrics.execution.tool_use_count)
 * and entriesToTrackerFormat (metrics.model, metrics.duration_ms). A field
 * added here must be checked here; a field a consumer dereferences without
 * an `if` must be checked here. Optional cross-harness fields (e.g.
 * end_time, agent_name) stay unchecked — consumers already guard them.
 */
function findMissingBufferEntryField(obj: unknown): string | null {
  if (!obj || typeof obj !== 'object') return 'entry (not an object)';
  const entry = obj as Record<string, unknown>; // safe: guarded by typeof check above

  // Check required string fields
  if (typeof entry.agent_id !== 'string') return 'agent_id';
  if (typeof entry.session_id !== 'string') return 'session_id';
  if (typeof entry.captured_at !== 'string') return 'captured_at';
  if (typeof entry.expires_at !== 'string') return 'expires_at';

  // Check metrics object exists
  if (!entry.metrics || typeof entry.metrics !== 'object') return 'metrics';

  // F5: metrics.tokens must exist. Consumers (entriesToTrackerFormat) dereference
  // metrics.tokens.* unconditionally; an entry with `metrics` but no `tokens` would
  // TypeError-crash them — and one bad entry takes down the whole save_run batch.
  const metrics = entry.metrics as Record<string, unknown>;
  if (!metrics.tokens || typeof metrics.tokens !== 'object') return 'metrics.tokens';

  // The five core token fields must be NUMBERS, not merely present: a
  // `tokens: {}` entry would pass an existence check but flow undefined
  // token counts into tracker rows. This guard defends the data, not just
  // the TypeError. (Optional cross-harness components stay optional.)
  const tokens = metrics.tokens as Record<string, unknown>;
  for (const field of ['input', 'output', 'cache_creation', 'cache_read', 'total_effective']) {
    if (typeof tokens[field] !== 'number') return `metrics.tokens.${field}`;
  }

  // formatters.ts and entriesToTrackerFormat dereference these unconditionally.
  if (typeof metrics.model !== 'string') return 'metrics.model';
  if (typeof metrics.duration_ms !== 'number') return 'metrics.duration_ms';
  if (typeof metrics.duration_formatted !== 'string') return 'metrics.duration_formatted';
  if (!metrics.execution || typeof metrics.execution !== 'object') return 'metrics.execution';
  const execution = metrics.execution as Record<string, unknown>;
  if (typeof execution.tool_use_count !== 'number') return 'metrics.execution.tool_use_count';

  return null;
}

/**
 * Validate that a parsed object has the required BufferEntry shape.
 * Returns true if valid, false if missing required fields.
 * Note: end_time is optional for backwards compatibility with older entries.
 */
function isValidBufferEntry(obj: unknown): obj is BufferEntry {
  return findMissingBufferEntryField(obj) === null;
}

/**
 * Ensure buffer directory exists
 */
function ensureBufferDir(config: BufferConfig = defaultConfig()): void {
  const dir = path.dirname(config.bufferPath);
  if (!fs.existsSync(dir)) {
    // mode: 0o700 (spec 05) — owner-only. Masked by umask and ignored if the
    // directory already exists; see fs.appendFileSync sites below for the
    // same caveat on files.
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/**
 * Resolve an entry's expiry instant, or null when no time can be established.
 *
 * `expires_at` is the primary source. When it does not parse (a hand-edited
 * buffer, a future/third-party writer, or corruption — see ADR-0002), expiry
 * is derived from `captured_at + config.defaultTTL`, i.e. the same rule
 * `appendToBuffer` applies at write time. This derivation depends on the
 * READER's `defaultTTL`, not a property stored on the entry — a caller
 * passing a different `defaultTTL` gets a different answer for the same row.
 * When `captured_at` is also unparseable, null means "no expiry can be
 * established, keep the row" (spec 04, Option C).
 */
function entryExpiryMs(entry: BufferEntry, config: BufferConfig): number | null {
  const explicit = new Date(entry.expires_at).getTime();
  if (!Number.isNaN(explicit)) return explicit;
  const captured = new Date(entry.captured_at).getTime();
  if (!Number.isNaN(captured)) return captured + config.defaultTTL;
  return null;
}

/** Check if a buffer entry has expired relative to a given time */
function isExpired(entry: BufferEntry, now: Date, config: BufferConfig): boolean {
  const expiry = entryExpiryMs(entry, config);
  return expiry === null ? false : expiry <= now.getTime();
}

/**
 * Minimum interval between opportunistic GC runs triggered by appendToBuffer.
 * GC reads and rewrites the full buffer — running it on every append wastes I/O
 * and creates lock contention when agents fire in bursts. With a 60s gate, GC
 * runs at most once per minute (the buffer grows by at most a few KB between
 * runs, and TTL is 30 days). Callers needing immediate GC invoke cleanupExpired
 * directly.
 *
 * The throttle is coordinated across processes via a sidecar marker file
 * (`<bufferPath>.gc`, see {@link gcMarkerPath}), not an in-memory variable: the
 * SubagentStop hook (`hook.ts` `main()`, which calls `appendToBuffer`) is a
 * fresh process per invocation — `main()` does not call `process.exit` on its
 * success path, only `main().catch(() => process.exit(1))` on failure
 * (`hook.ts:550`) — so no in-memory state survives between invocations either
 * way (ADR-0002:16-17). A module-level last-GC timestamp would therefore
 * always read as its initial value on the hook path and the gate would
 * always be open (this was the bug proposal 03 fixes). The marker's mtime
 * is the shared clock: the gate is open when the marker is absent or older
 * than GC_INTERVAL_MS, and a successful GC touches it. An unreadable or
 * unwritable marker fails OPEN (treats the gate as open) rather than blocking
 * GC — see the try/catch around the gate check and the marker touch below.
 */
const GC_INTERVAL_MS = 60_000;

/** Path to the cross-process GC-throttle sidecar marker for a given buffer path. */
function gcMarkerPath(bufferPath: string): string {
  return `${bufferPath}.gc`;
}

/**
 * Options for {@link appendToBuffer}.
 */
export interface AppendOptions {
  /** Name of the agent that produced these metrics */
  agentName?: string;
  /** Project path where the agent ran */
  projectPath?: string;
  /** Orchestrator-minted run token; buffer-query key only (not tracker payload) */
  runId?: string;
  /** Time-to-live in milliseconds (default: 30 days) */
  ttlMs?: number;
  /** Buffer configuration override */
  config?: BufferConfig;
  /** Source of the capture: 'hook', 'cli', or 'api' */
  source?: 'hook' | 'cli' | 'api';
}

/**
 * Append a metrics entry to the buffer.
 * Uses file locking to prevent race conditions with concurrent writers.
 *
 * @param metrics - The agent metrics to store
 * @param options - Optional configuration for the buffer entry
 * @returns The created buffer entry, or null if the append was skipped because
 *   the buffer lock could not be acquired (fail-closed under lock contention)
 * @see README.md § Buffer Functions
 */
export function appendToBuffer(
  metrics: AgentMetrics,
  options: AppendOptions = {}
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
    run_id: options.runId,   // undefined when absent → omitted from JSON
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
    // Append to JSONL file. mode: 0o600 (spec 05) applies at creation only —
    // masked by umask and ignored if the file already exists; an existing
    // buffer hardens at its next rewrite instead (see removeWhere /
    // annotateBufferEntries below).
    fs.appendFileSync(config.bufferPath, toJsonlLine(entry), { encoding: 'utf-8', mode: 0o600 });

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
    releaseLock(lockPath);
  }

  // Opportunistic GC. Must run after the append lock is released —
  // cleanupExpired takes the same (non-reentrant) file lock. Best-effort:
  // a GC failure must never fail the capture that triggered it.
  // Time-gated via the cross-process `.gc` sidecar marker (spec 03, Option
  // A): skip if a successful GC touched the marker within GC_INTERVAL_MS, to
  // avoid a full read+rewrite on every append during agent bursts. Callers
  // needing immediate GC invoke cleanupExpired() directly.
  const gcPath = gcMarkerPath(config.bufferPath);
  let gcGateOpen: boolean;
  try {
    gcGateOpen = !fs.existsSync(gcPath) || Date.now() - fs.statSync(gcPath).mtimeMs >= GC_INTERVAL_MS;
  } catch {
    // AUDIT-OK(no_empty_catch): an unreadable/corrupt marker must fail OPEN
    // (run GC) rather than silently block it forever — this degrades to the
    // pre-throttle behaviour, the correct floor (proposal 03 §4, Option A).
    gcGateOpen = true;
  }

  if (gcGateOpen) {
    // A LockAcquisitionError just means another process is GC'ing right now —
    // the next append retries, so it's silently ignored. Any other failure
    // (e.g. the buffer file itself is unreadable) is reported; it will not
    // resolve on retry, and swallowing it silently would let corruption hide.
    try {
      cleanupExpired(config);
      // Touch the marker only after a successful GC. Kept out of the catch
      // above: a marker-write failure is not a GC failure and must not be
      // reported as "buffer GC failed" — it only means the next append may
      // GC again sooner than intended (fails open, never blocks a capture).
      // Do NOT add a lock around the marker — two writers racing on it is a
      // benign, self-correcting race (the file lock inside cleanupExpired
      // already serializes the actual rewrite); adding one would put a
      // second lock acquisition back on the path this option exists to
      // remove.
      try {
        fs.writeFileSync(gcPath, String(Date.now()), { encoding: 'utf-8', mode: 0o600 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Warning: buffer GC marker write failed for ${gcPath}: ${msg}\n`);
      }
    } catch (err) {
      if (!(err instanceof LockAcquisitionError)) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Warning: buffer GC failed for ${config.bufferPath}: ${msg}\n`);
        warn('buffer GC failed', { buffer_path: config.bufferPath, error: msg });
      }
    }
  }

  return entry;
}

/**
 * Parse buffer file content into valid entries plus the raw text of every
 * skipped line (quarantined: well-formed JSON that failed isValidBufferEntry,
 * or JSON that failed to parse at all), in file order. Shared by readBuffer
 * and readBufferWithQuarantine so the two never drift on what counts as
 * skippable.
 */
function parseBufferContent(content: string): { entries: BufferEntry[]; quarantinedLines: string[] } {
  const lines = content.trim().split('\n').filter(Boolean);

  const entries: BufferEntry[] = [];
  const quarantinedLines: string[] = [];
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
        const missingField = findMissingBufferEntryField(parsed);
        process.stderr.write(`Warning: Skipping buffer entry with missing required field: ${missingField}\n`);
        quarantinedLines.push(line);
      }
    } catch (err) {
      // Log malformed lines so users have visibility into data issues
      process.stderr.write(`Warning: Skipping malformed buffer entry: ${err instanceof Error ? err.message : 'parse error'}\n`);
      quarantinedLines.push(line);
    }
  }

  return { entries, quarantinedLines };
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
  return parseBufferContent(content).entries;
}

/**
 * Like readBuffer, but also returns the raw text of every quarantined line
 * (malformed JSON, or valid JSON that failed isValidBufferEntry), in file
 * order. Used exclusively by the rewrite paths (removeWhere,
 * annotateBufferEntries) so a rewrite preserves quarantined rows instead of
 * silently deleting them — readBuffer's own filtering is read-only and never
 * touches the file, but a caller that rewrites the file from readBuffer's
 * output alone would drop every line readBuffer chose not to return.
 */
function readBufferWithQuarantine(
  config: BufferConfig = defaultConfig()
): { entries: BufferEntry[]; quarantinedLines: string[] } {
  if (!fs.existsSync(config.bufferPath)) {
    return { entries: [], quarantinedLines: [] };
  }

  const content = fs.readFileSync(config.bufferPath, 'utf-8');
  return parseBufferContent(content);
}

/**
 * Read only non-expired entries from the buffer.
 *
 * @param config - Buffer configuration (optional, uses defaults)
 * @returns Array of valid (non-expired) buffer entries
 */
export function readValidEntries(config: BufferConfig = defaultConfig()): BufferEntry[] {
  const now = new Date();
  return readBuffer(config).filter((entry) => !isExpired(entry, now, config));
}

/**
 * Query filters for {@link queryBuffer}.
 */
export interface BufferQuery {
  /** Filter by session ID */
  sessionId?: string;
  /** Filter by agent ID */
  agentId?: string;
  /** Filter by validator name */
  agentName?: string;
  /** Filter to a single orchestrator run token (exact match) */
  runId?: string;
  /** Filter by project path */
  projectPath?: string;
  /**
   * Only include entries captured after this date. Fails closed: an entry
   * with an unparseable captured_at is excluded whenever this is set.
   */
  since?: Date;
  /**
   * Only include entries where agent finished after this date. Fails
   * closed: an entry with no parseable end_time (own or backfilled from
   * metrics.end_time) is excluded whenever either end_time bound is set.
   */
  endTimeAfter?: Date;
  /** Only include entries where agent finished before this date. Same fail-closed behavior as endTimeAfter. */
  endTimeBefore?: Date;
  /** Include expired entries (default: false) */
  includeExpired?: boolean;
}

/**
 * Query buffer entries by various criteria.
 *
 * @param query - Query filters
 * @param config - Buffer configuration (optional, uses defaults)
 * @returns Array of matching buffer entries
 * @see README.md § Buffer Functions
 */
export function queryBuffer(
  query: BufferQuery,
  config: BufferConfig = defaultConfig()
): BufferEntry[] {
  const entries = query.includeExpired
    ? readBuffer(config)
    : readValidEntries(config);

  return entries.filter((entry) => {
    if (query.sessionId && entry.session_id !== query.sessionId) return false;
    if (query.agentId && entry.agent_id !== query.agentId) return false;
    if (query.agentName && entry.agent_name !== query.agentName) return false;
    if (query.runId && entry.run_id !== query.runId) return false;
    if (query.projectPath && entry.project_path !== query.projectPath) return false;
    // Fail closed on an unparseable captured_at, same posture as the
    // endTime bounds below: a `since` window is a claim about WHEN the
    // entry was captured, and an unknown/unparseable capture time cannot
    // satisfy it. QUERY-SCOPED — readBuffer/isValidBufferEntry never
    // reject a row for this; it only affects this filtered view.
    if (query.since) {
      const capturedAtMs = new Date(entry.captured_at).getTime();
      if (Number.isNaN(capturedAtMs) || capturedAtMs < query.since.getTime()) return false;
    }
    // Filter by agent end_time (when the agent actually finished). Fail closed: a
    // finish-time window is a claim about WHEN the agent finished, and an unknown or
    // unparseable finish time cannot satisfy it. This exclusion is QUERY-SCOPED — it
    // only applies when an endTime bound is actually requested; an absent end_time
    // stays a legitimate row for readBuffer (isValidBufferEntry deliberately leaves
    // end_time unchecked).
    if (query.endTimeAfter || query.endTimeBefore) {
      const raw = entry.end_time || entry.metrics.end_time;
      const t = raw ? new Date(raw).getTime() : NaN;
      if (Number.isNaN(t)) return false;
      if (query.endTimeAfter && t < query.endTimeAfter.getTime()) return false;
      if (query.endTimeBefore && t > query.endTimeBefore.getTime()) return false;
    }
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
  return queryBuffer({ sessionId }, config).sort((a, b) => {
    const aTime = new Date(a.captured_at).getTime();
    const bTime = new Date(b.captured_at).getTime();
    const aValid = !Number.isNaN(aTime);
    const bValid = !Number.isNaN(bTime);
    // NaN-safe: `aTime - bTime` with either side NaN yields NaN, which
    // Array.prototype.sort treats inconsistently. Sort unparseable
    // captured_at values last, deterministically, instead of leaving their
    // position engine-dependent.
    if (aValid && bValid) return aTime - bTime;
    if (aValid) return -1;
    if (bValid) return 1;
    return 0;
  });
}

/**
 * Build a unique sibling temp-file path for an atomic rewrite of `bufferPath`.
 *
 * Atomic rewrite: write to a sibling temp file then rename into place. A
 * direct writeFileSync truncates-then-writes, so a crash or ENOSPC mid-write
 * would leave the buffer empty or half-written, losing all still-buffered
 * un-shipped metrics (the lock guards concurrency, not crash-atomicity).
 * rename(2) on the same filesystem is atomic, so a crash leaves either the
 * complete old file or the complete new one. Same pattern as the log
 * rotation in logger.ts.
 *
 * Unique temp name per writer: withFileLock is fail-closed, but the 30s
 * stale-lock reclaim (lock.ts) can still hand two live writers the lock when
 * a slow holder exceeds the staleness threshold mid-rewrite. A shared
 * '.tmp' would let them interleave writes into the same file and rename a
 * half-written temp over the buffer, truncating everything. Unique names
 * confine the damage to last-rename-wins (stale snapshot), never a corrupt
 * file. Do NOT simplify to a shared temp name while the stale-reclaim
 * window exists.
 *
 * Self-healing permissions (spec 05): both callers below write the temp file
 * with `mode: 0o600` before renaming it over the buffer, and rename(2)
 * carries the TEMP file's mode onto the destination. So a pre-existing
 * `0644` buffer (created before this change, or by a foreign writer) becomes
 * `0600` at its very next rewrite, with no explicit chmod anywhere. This only
 * holds because both temp writes set the mode — dropping it from either one
 * silently reverts a hardened buffer back to `0644` the next time that path
 * runs.
 *
 * @internal Not re-exported from index.ts — buffer.ts internal only.
 */
export function bufferTempPath(bufferPath: string): string {
  return `${bufferPath}.${process.pid}.${randomUUID()}.tmp`;
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
    const { entries: allEntries, quarantinedLines } = readBufferWithQuarantine(config);
    const remaining = allEntries.filter(keep);
    const removedCount = allEntries.length - remaining.length;

    if (removedCount > 0) {
      // Quarantined lines (skipped by readBufferWithQuarantine — malformed
      // JSON, or well-formed JSON failing isValidBufferEntry) are appended
      // verbatim so this rewrite doesn't silently delete rows a read merely
      // chose not to return.
      const tmpPath = bufferTempPath(config.bufferPath);
      const content = toJsonlContent(remaining) + quarantinedLines.map((l) => l + '\n').join('');
      // mode: 0o600 (spec 05) — see bufferTempPath's doc comment for why
      // this write (not the rename) is the enforcement point for hardening.
      fs.writeFileSync(tmpPath, content, { encoding: 'utf-8', mode: 0o600 });
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
    const { entries: allEntries, quarantinedLines } = readBufferWithQuarantine(config);
    let updated = 0;

    for (const entry of allEntries) {
      const name = names[entry.agent_id];
      if (name && entry.agent_name !== name) {
        entry.agent_name = name;
        updated++;
      }
    }

    if (updated > 0) {
      // Same atomic temp-file + rename pattern (see bufferTempPath's doc
      // comment for the crash-atomicity and unique-name rationale) as
      // removeWhere. Quarantined lines are appended verbatim for the same
      // reason as removeWhere: this rewrite must not silently delete rows a
      // read merely skipped.
      const tmpPath = bufferTempPath(config.bufferPath);
      const content = toJsonlContent(allEntries) + quarantinedLines.map((l) => l + '\n').join('');
      // mode: 0o600 (spec 05) — see bufferTempPath's doc comment for why
      // this write (not the rename) is the enforcement point for hardening.
      fs.writeFileSync(tmpPath, content, { encoding: 'utf-8', mode: 0o600 });
      fs.renameSync(tmpPath, config.bufferPath);
    }

    return updated;
  });
}

/**
 * Remove expired entries from the buffer (garbage collection).
 *
 * When an entry's `expires_at` does not parse, its expiry is derived from
 * `captured_at + config.defaultTTL` (spec 04, Option C); when `captured_at`
 * is also unparseable, the entry is kept. Either case emits one stderr
 * warning per affected entry, naming the entry and which field failed —
 * deliberately only from this retention path, not from readValidEntries: a
 * process-scoped "already warned" flag would degrade to "warn every time" on
 * the hook path (the same defect this GC throttle's sidecar marker exists to
 * fix for GC itself — see proposal 03), so this simply accepts one warning
 * per GC pass instead of trying to deduplicate across processes.
 *
 * @param config - Buffer configuration (optional, uses defaults)
 * @returns Number of entries removed
 */
export function cleanupExpired(config: BufferConfig = defaultConfig()): number {
  const now = new Date();
  return removeWhere((entry) => {
    const explicitMs = new Date(entry.expires_at).getTime();
    if (Number.isNaN(explicitMs)) {
      const capturedMs = new Date(entry.captured_at).getTime();
      if (Number.isNaN(capturedMs)) {
        process.stderr.write(
          `Warning: buffer entry ${entry.agent_id} has an unparseable expires_at and captured_at; keeping it (no expiry can be established)\n`
        );
      } else {
        process.stderr.write(
          `Warning: buffer entry ${entry.agent_id} has an unparseable expires_at; deriving expiry from captured_at + defaultTTL\n`
        );
      }
    }
    return !isExpired(entry, now, config);
  }, config);
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

    if (!isExpired(entry, now, config)) {
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
    // AUDIT-OK(no_empty_catch): readBuffer() above already called
    // readFileSync on this same path and would have thrown first on
    // EACCES/EISDIR — the only way statSync gets here is ENOENT (buffer
    // never written yet), so 0 bytes is the correct value, not a swallowed
    // failure. This is why this site differs from getLogStats: there,
    // fs.existsSync (which never throws) gates the read, so a stat/read
    // failure there is a genuine, previously-unreported error.
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
 * NOTE (ADR-0004): run_id is DELIBERATELY NOT mapped here. The save_run
 * agents[] schema is strict (additionalProperties:false); an extra run_id key
 * spliced verbatim into agents[] would be rejected at save time. run_id is a
 * buffer-query key (drives --run selection); once the rows are selected they
 * splice by agent_id exactly as before. Do NOT add run_id to TrackerAgentFormat
 * or to this map — the -f json output already surfaces it for inspection.
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
