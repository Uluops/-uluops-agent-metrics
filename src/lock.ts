/**
 * File Locking
 *
 * Synchronous file-based locking for safe concurrent access to the buffer.
 * Uses a spinlock with exponential backoff, designed for the Claude Code
 * SubagentStop hook context where async operations are not available.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

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
 * - Contention is real but short-lived: parallel workflow validators fire many
 *   SubagentStop hooks at once against a single buffer lock, but each holder only
 *   holds it for one small appendFileSync. Callers (appendToBuffer) fail closed —
 *   skipping the metric — if acquisition times out, so a stuck lock can never
 *   force an unlocked, corruption-prone write.
 * - Exponential backoff caps at 100ms, limiting CPU spin time
 * - Total wait time is bounded by maxWaitMs (default 5s)
 * - The 30-second stale lock detection handles dead processes
 *
 * If profiling shows this as a hot path, consider the spawnSync approach
 * or converting the hook to async if Claude Code supports it.
 *
 * @param lockPath - Path to the lock file
 * @param maxWaitMs - Maximum time to wait for lock acquisition
 * @param deps - Test seam for injecting fs failures; not part of the public API
 * @returns true if lock acquired, false if timeout
 */
export function acquireLock(
  lockPath: string,
  maxWaitMs: number = 5000,
  deps?: { writeFileSync?: typeof fs.writeFileSync; statSync?: typeof fs.statSync },
): boolean {
  const writeFileSync = deps?.writeFileSync ?? fs.writeFileSync;
  const statSync = deps?.statSync ?? fs.statSync;

  // Ensure the lock's parent directory exists. Without this, a missing parent
  // makes writeFileSync throw ENOENT and statSync throw too, which reads as
  // "lock file was removed, retry" — spinning the full maxWaitMs for what is
  // actually an unwritable path. (Surfaced when withFileLock became
  // fail-closed; the old fail-open path masked it.)
  try {
    // mode: 0o700 (spec 05) — owner-only. Masked by umask; ignored if the
    // directory already exists.
    fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  } catch {
    // AUDIT-OK(no_empty_catch): fall through — the create attempt below will report the real failure
  }

  const startTime = Date.now();
  let delay = 10;

  while (Date.now() - startTime < maxWaitMs) {
    try {
      // Exclusive create - fails if file exists. mode: 0o600 (spec 05) —
      // masked by umask and irrelevant here anyway since 'wx' guarantees
      // this call only ever creates the file, never reopens an existing one.
      writeFileSync(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (err) {
      // Only EEXIST means "a lock file is actually there, check if it's
      // stale". Any other write error (EACCES, EROFS, ENOENT on a parent
      // that vanished after mkdirSync above, EMFILE, ...) is not about lock
      // contention at all — retrying the stat/reclaim path against a path we
      // can't write to just spins for the full maxWaitMs. Fall through to
      // the same backoff-and-retry the contended-lock case uses; the retry
      // will keep hitting the same write error until maxWaitMs elapses and
      // acquireLock correctly returns false.
      if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
        // Check if lock is stale (holder process died)
        try {
          const stat = statSync(lockPath);
          // If lock is older than 30 seconds, assume it's stale
          if (Date.now() - stat.mtimeMs > 30000) {
            fs.unlinkSync(lockPath);
            continue;
          }
        } catch {
          // Lock file was removed, retry
          continue;
        }
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
 * Release a file lock.
 *
 * @param lockPath - Path to the lock file to release
 */
export function releaseLock(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      // Lock already released or never acquired — normal double-release.
      return;
    }
    // Anything else (e.g. EACCES on an unwritable parent dir) means the lock
    // file is still there and we couldn't remove it. Never rethrow: this runs
    // inside two `finally` blocks (withFileLock above, buffer.ts) where a
    // thrown error would mask the real result. Report it so it isn't silent.
    process.stderr.write(
      `agent-metrics: failed to release lock ${lockPath}: ${code ?? String(err)}\n`,
    );
  }
}

/**
 * Thrown by withFileLock when the lock cannot be acquired within the timeout.
 * Callers with best-effort semantics (GC, name write-back) must catch
 * LockAcquisitionError specifically (via `instanceof`) and skip it — a bare
 * catch would also swallow unrelated failures (e.g. an unreadable buffer
 * file) that a retry will never resolve. User-facing callers surface it.
 */
export class LockAcquisitionError extends Error {
  constructor(lockPath: string, timeoutMs: number) {
    super(`Could not acquire lock ${lockPath} within ${timeoutMs}ms`);
    this.name = 'LockAcquisitionError';
  }
}

/**
 * Execute a function while holding a file lock.
 * Acquires the lock, runs the function, then releases.
 *
 * Fail-closed: if the lock cannot be acquired, fn is NOT run and
 * LockAcquisitionError is thrown. Every caller performs a read-modify-rewrite
 * of the whole buffer; running that unlocked against a concurrent writer can
 * rename a stale snapshot over the buffer and silently destroy entries a
 * writer was already told were captured. Skipping is always the safer failure
 * (matches appendToBuffer's fail-closed append discipline).
 *
 * @param lockPath - Path to the lock file
 * @param timeoutMs - Lock acquisition timeout in milliseconds
 * @param fn - Function to execute while holding the lock
 * @returns The return value of fn
 * @throws {LockAcquisitionError} If the lock is not acquired within timeoutMs
 */
export function withFileLock<T>(lockPath: string, timeoutMs: number, fn: () => T): T {
  const lockAcquired = acquireLock(lockPath, timeoutMs);
  if (!lockAcquired) {
    throw new LockAcquisitionError(lockPath, timeoutMs);
  }

  try {
    return fn();
  } finally {
    releaseLock(lockPath);
  }
}
