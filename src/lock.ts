/**
 * File Locking
 *
 * Synchronous file-based locking for safe concurrent access to the buffer.
 * Uses a spinlock with exponential backoff, designed for the Claude Code
 * SubagentStop hook context where async operations are not available.
 */

import * as fs from 'node:fs';

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
export function acquireLock(lockPath: string, maxWaitMs: number = 5000): boolean {
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
 * Release a file lock.
 *
 * @param lockPath - Path to the lock file to release
 */
export function releaseLock(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Lock already released or never acquired
  }
}

/**
 * Execute a function while holding a file lock.
 * Acquires the lock, runs the function, then releases.
 *
 * @param lockPath - Path to the lock file
 * @param timeoutMs - Lock acquisition timeout in milliseconds
 * @param fn - Function to execute while holding the lock
 * @returns The return value of fn
 */
export function withFileLock<T>(lockPath: string, timeoutMs: number, fn: () => T): T {
  const lockAcquired = acquireLock(lockPath, timeoutMs);

  try {
    return fn();
  } finally {
    if (lockAcquired) {
      releaseLock(lockPath);
    }
  }
}
