# ADR-0003: Atomic file-system lock for buffer writes

**Status:** Accepted (2026-05-29, retroactive)

## Context

The buffer (see ADR-0002) is shared across all SubagentStop hook
invocations. A workflow that spawns several agents in parallel will
fire several hook processes concurrently, each attempting to append a
line to the same JSONL file. Without coordination, concurrent appends
can interleave bytes mid-line, corrupting the buffer.

The hook handler must be synchronous in practice: Claude Code invokes
it as a short-lived command, reads its stdout, and proceeds. Async
patterns that defer work past the hook's exit do not run, because the
process is terminated when stdout closes. This rules out anything
that relies on a Node.js event loop tick after the response.

The package also has to remain trivially installable on any platform
Claude Code runs on. Native modules and filesystem-specific syscalls
(`flock(2)`) carry an outsized cost relative to the problem.

## Decision

`buffer.ts` serializes writes through a synchronous filesystem
lockfile, implemented in `src/lock.ts` and exposed as
`acquireLock` / `releaseLock` / `withFileLock`. The lock is
acquired via `fs.writeFileSync(lockPath, pid, { flag: 'wx' })`
(exclusive create, fails if file exists), which is atomic at the
filesystem level on POSIX and Windows. Contending writers retry in a
synchronous busy-wait loop with exponential backoff, capped at
100ms per iteration and bounded by a total `maxWaitMs` (5s default).

Stale-lock recovery: if the lockfile is older than 30 seconds, the
holder is presumed dead and the contending writer removes the lock
and retries. The 30-second threshold is chosen to comfortably exceed
the hook's natural runtime (sub-second in observed traffic) while
still recovering before the agent that produced the lock would have
finished a subsequent run.

The lock guards only the *write* of one entry. Reads do not take the
lock; they tolerate concurrent appends because JSONL's per-line
framing makes a torn final line skippable.

## Alternatives considered

**A. `proper-lockfile` (npm).**
Battle-tested cross-platform lockfile module. Rejected because it is
async-first; its sync surface is limited and the package would carry
a new runtime dependency for ~40 lines of logic we can write
ourselves. Reconsider if we observe stale-lock or platform-specific
edge cases in practice.

**B. `flock(2)` via a native addon.**
Strongest POSIX semantics. Rejected: native modules disqualify the
package from the zero-native-dep posture, and Windows has no direct
equivalent (`LockFileEx` exists but requires its own addon).

**C. Atomics.wait() on SharedArrayBuffer.**
True synchronous sleep. Rejected: SharedArrayBuffer requires a
SharedArrayBuffer-aware host, which the hook execution context is
not.

**D. `child_process.spawnSync('sleep', ...)`.**
Real sleep without busy-waiting. Rejected because each spawn costs
5–10ms — comparable to the entire expected hook runtime — and turns
contention into a process-fork storm.

**E. No locking; rely on POSIX `O_APPEND` atomicity.**
On POSIX, `write(2)` with `O_APPEND` is atomic up to `PIPE_BUF`
bytes. Rejected because (a) Node.js does not guarantee a
single-syscall write — `fs.appendFileSync` may issue multiple
writes; (b) Windows has no equivalent guarantee; (c) entries can
exceed `PIPE_BUF` (4096 bytes on Linux) when tool breakdowns are
large.

**F. Lock-free per-process buffer files, merged on read.**
Each hook process writes to its own file (e.g.
`buffer-{pid}-{timestamp}.jsonl`); readers merge. Rejected because
it shifts complexity to every reader and pushes the cleanup problem
into the same lifecycle we are trying to avoid. Worth reconsidering
if lock contention becomes a real bottleneck.

## Consequences

**Accepted downsides:**

- Busy-wait burns CPU during contention. Bounded at 100ms-per-tick
  and 5s total, but visible under sustained parallel workflows.
- Stale-lock detection is timer-based, not process-liveness-based.
  A hook that legitimately exceeds 30s would be incorrectly
  evicted. The hook's actual budget (Claude Code timeout = 10s)
  makes this safe in practice but is not enforced anywhere.
- The lockfile itself is the synchronization primitive. Manual
  removal by a user (`rm ~/.claude/agent-metrics-buffer.jsonl.lock`)
  during contention can cause two writers to interleave.

**Acquired benefits:**

- Zero runtime dependencies.
- Cross-platform without conditional code.
- Self-healing within 30s of any process death.
- Fits the hook's synchronous contract without converting the entire
  package to async.

## References

- `src/lock.ts` — `acquireLock`, `releaseLock`, `withFileLock`
- `src/buffer.ts` — `appendToBuffer` (the lock's sole writer caller)
- ADR-0002 — JSONL append-only buffer format
- Issue `STR-INV/I` (`Sync locking classified INTENTIONAL — most documented decision in package`)
