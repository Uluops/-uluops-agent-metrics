# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`reconcile --run <token> --expect <n>`** — moves ADR-0004's count-check
  into this artifact. Reads the buffer for a single orchestrator run token,
  compares the attributed agent count to a caller-supplied expectation,
  prints the attributed set (`formatBufferList`, the same renderer
  `buffer list` uses), and exits non-zero on shortfall. Options: `-p/--project`
  (partial `project_path` match, parity with `buffer list -p`), `-f/--format`
  (`text` default | `json`), `-a/--all` (include expired entries).
  **Exit-code contract (deliberately asymmetric with the rest of this CLI):**
  `0` on `attributed === expected` or `attributed > expected` (over-collection
  is benign per ADR-0004 — bounded to one project, never mis-attribution —
  and is reported on stderr, not treated as an error); `1` on
  `attributed < expected` (shortfall — a `[run:]` tag was likely dropped);
  `2` on a usage error (missing/malformed `--run` or `--expect`), deliberately
  distinct from `1` so a caller reading only the exit code can tell "I
  mistyped a flag" from "the run really lost an agent". `-f json` emits
  exactly one object on stdout (`run_id`, `expected`, `attributed`,
  `shortfall`, `status` ∈ `exact|over|shortfall`, `agents: [{agent_id,
  agent_name}]`) — the diagnostic line goes to stderr in both formats, so
  `-f json` stdout stays machine-parseable. `agents[]` carries only
  `agent_id`/`agent_name`, never `run_id` and never a `-f tracker`-shaped
  row — reconcile answers "who was attributed", not "what do I splice",
  keeping the two payloads distinct so a consumer cannot accidentally splice
  reconcile output into a tracker `save_run agents[]` call. Top-level command
  (not `buffer reconcile`) — the semantic subject is the run, not the buffer.
  No programmatic export; CLI-only, not re-exported from `index.ts`. See
  `docs/decisions/0004-run-scoped-attribution.md` and
  `01-reconcile-run-expect-command-spec-v0_1_0.md` (uluops-specifications).
- **`filterByProjectPath`** (`src/commands/shared.ts`, internal — not
  re-exported from `index.ts`). The `-p`/`--project` partial-match filter
  previously hand-copied inline in `buffer list`, extracted so `buffer list -p`
  and `reconcile -p` share one definition of what `-p` means instead of
  independently drifting.

- **Cross-process GC-throttle sidecar marker (`<bufferPath>.gc`).** A new
  state file alongside the buffer/log/lock, written by `appendToBuffer`'s
  opportunistic GC (internal — not re-exported from `index.ts`). It replaces
  the module-scoped `lastGcAt` timestamp variable, which never throttled
  anything on the SubagentStop hook path — the hook is a fresh Node process
  per invocation, so every capture paid a full buffer read+parse under the
  file lock before this change. The gate is now the marker's mtime, shared
  across processes: open when the marker is absent or older than
  `GC_INTERVAL_MS` (60s, unchanged), closed otherwise. An unreadable or
  unwritable marker fails **open** (GC still runs) rather than blocking a
  capture. `buffer clear` and friends do not yet know about this file (same
  as the pre-existing `.lock` sibling); see proposal
  `03-cross-process-gc-throttle-proposal-v0_1_0.md`.

### Changed

- **Buffer, GC-throttle marker, and lock state files are now created with
  `0600` permissions; their parent directories with `0700`.** Previously
  every write site used umask-derived defaults, so on a typical `umask 022`
  machine these files were world-readable. `mode` only applies at file
  creation (masked by umask, ignored on an existing file), so **existing
  installations are not retroactively hardened by this change alone** — an
  existing buffer self-heals to `0600` the next time it goes through the
  atomic rewrite path (`removeWhere`/`annotateBufferEntries`, since
  `rename(2)` carries the temp file's mode onto the destination). No
  `chmod` was added to any write path — this is deliberately
  defence-in-depth against incidental copying (backups, `tar`, sync
  clients) on a single-user machine, not a claim that a vulnerability
  existed. **Scope note:** the log file/directory (`src/logger.ts`) carry
  the same two write sites per the proposal and are intentionally
  **not** included in this change — `logger.ts` was owned by a parallel
  workstream at the time this landed; see README § Persistence for the
  manual `chmod` command covering all state files including the log. See
  proposal `05-state-file-permissions-proposal-v0_1_0.md`.

### Removed

- **`AgentMetrics.final_message`** (and the Codex-only extraction that
  populated it — `last_agent_message` from the `task_complete` payload).
  Dead weight: nothing in this package read the field (no formatter, no
  tracker mapping, no README mention), and it stored the *model's own output
  text* verbatim in the buffer — a body-of-work retention concern with no
  offsetting consumer. Codex-path-only; the Claude extractor never had an
  equivalent field. Tracker `5e378958`.

### Fixed

- **`extractCodexMetricsFromFile` had no `fs.access` pre-check** — a
  missing/unreadable rollout file surfaced as a raw `ENOENT` from the
  readline stream iterator, a third error shape alongside
  `extractMetricsFromFile`'s wrapped `Unable to read agent metrics file
  "<path>": <message>` (with `.cause`) and `extractAgentMetrics`'s `null`
  for "not found". Now pre-checks with `fs.promises.access(filePath,
  fs.constants.R_OK)`, matching the Claude-path pattern exactly (wrapped
  `Error` with the original filesystem error preserved as `.cause`).
  Tracker `97656053`.
- **`configureLogger` performed no range validation on `maxFiles` /
  `maxFileSize`.** Extends the existing sanitise-and-retain pattern
  (`minLevel`, `undefined`) added for issue `1f6d6ba2`: `maxFiles` must now
  be an integer `>= 1` and `maxFileSize` a finite number `> 0`; a rejected
  value is warned to stderr naming the key and the received value and the
  **current** value is retained (never thrown, never silently defaulted to
  `DEFAULT_CONFIG`, which would loosen a value a caller deliberately set).
  Sibling keys in the same `configureLogger` call are unaffected. Tracker
  `0a05e8be`.

- **Opportunistic buffer GC was never throttled on the SubagentStop hook
  path.** `appendToBuffer`'s GC gate was a module-level `lastGcAt`
  timestamp, and the hook is a fresh process per invocation — so the "at
  most once per `GC_INTERVAL_MS`" guarantee held only for long-lived
  same-process callers (e.g. a CLI session) and never for the hook, which
  is the dominant writer. Every SubagentStop firing paid an extra lock
  acquisition plus a full buffer read+parse, which under parallel workflow
  bursts is exactly the pathway that makes `appendToBuffer` fail closed and
  silently drop a metric (`buffer.ts:265-277`). Replaced with the
  cross-process `.gc` sidecar marker described above (see Added). Two
  existing tests that encoded the old process-scoped assumption
  (`buffer.test.ts`: the `issue 33fa21ff` "MUST run first" ordering
  constraint, and "should run opportunistically on append", which
  previously called `cleanupExpired()` directly rather than exercising the
  in-append trigger) were reworked to match; a new cross-process regression
  test spawns a second Node process appending to the same buffer within
  `GC_INTERVAL_MS` and asserts it does not re-run GC.
- **An unparseable `expires_at` made a buffer entry immortal.**
  `isExpired` compared `new Date(entry.expires_at)` directly; an
  unparseable value produces `Invalid Date`, and every relational
  comparison against `Invalid Date` is `false`, so such a row was never
  expired — returned by `readValidEntries`/`queryBuffer` forever, counted
  in `BufferStats.validEntries` forever, and never removed by
  `cleanupExpired`. `isExpired` now takes a `config` parameter and, when
  `expires_at` does not parse, derives an expiry from
  `captured_at + config.defaultTTL` via a new internal `entryExpiryMs`
  helper (not re-exported from `index.ts`) — the same rule `appendToBuffer`
  applies at write time. When `captured_at` is *also* unparseable, the row
  is kept (no expiry can be established) and `cleanupExpired` emits one
  stderr warning per affected row, naming the `agent_id` and which field
  failed; `readValidEntries` stays silent (a process-scoped "already
  warned" flag would degrade to "warn every time" on the hook path, the
  same defect just fixed for GC's own throttle above). This package cannot
  itself produce such a row (`appendToBuffer` ISO-formats both timestamps
  unconditionally, and `toISOString()` throws on a non-finite `Date`), so
  the affected population is a hand-edited buffer file, a foreign/future
  writer, or corruption. See spec
  `04-unparseable-expires-at-retention-spec-v0_1_0.md`.

## [0.9.0] - 2026-09-04

### Added

- **README "Development checks" subsection** documenting `lint` / `test` /
  `check:pack` / `check:readme-exports`, the `prepublishOnly` ordering and why,
  and that the SubagentStop hook runs the persistent copy at
  `~/.claude/tools/agent-metrics/` (refreshed by `./install.sh`), not the global
  npm install. "How It Works" gains the quarantine-preservation and never-fail
  hook properties.
- **`npm run check:pack`** (wired into `prepublishOnly`, run after `build`).
  Asserts, from `npm pack --dry-run --json`'s actual file list rather than
  from re-reading config, that the packed tarball contains no
  `dist/**/*.test.*` or `dist/test-utils.*` paths and at least 40 files
  (guards the check itself against a broken/empty extraction). The `files`
  field's `!dist/**/*.test.*` / `!dist/test-utils.*` negations were, before
  the `prepublishOnly` reorder below, the *sole* guard against shipping test
  artifacts — a root `files` field makes npm ignore `.npmignore` entirely, so
  that file was dead as a safety net. `scripts/check-pack.mjs` supports
  `--control` (asserts the check WOULD have failed, for verifying the guard
  isn't vacuous).
- **`readStdin` hard deadline** (`readStdin` / `STDIN_HARD_DEADLINE_MS` — hook
  internals, not re-exported from `index.ts`). A new (5000ms) ceiling,
  independent of the existing idle timer, resolves `readStdin` with
  whatever data has accumulated if a peer sends a partial chunk and then
  stalls mid-stream (no further `data`, no `end`, no `error`). The idle timer
  only ever fires while `data === ''`, so a stalled *partial* write previously
  hung the hook indefinitely. `readStdin` gains an optional second parameter
  (defaults to the constant) so tests can inject a short deadline instead of
  waiting on the real one. The existing `data === ''` guard and the hook's
  never-fail invariant (ADR-0002) are unchanged.
- **`LogStats.readError` / `LogDisplayStats.readError`** (both optional;
  `LogDisplayStats` is the CLI-display type, not re-exported from
  `index.ts` — internal only).
  Set when the log file exists but stat-ing or reading it failed (e.g.
  `EACCES`, `EISDIR`, or the rotation race where `rotateLogFile` renames the
  file between `existsSync` and `statSync`); `sizeBytes` is trustworthy only
  when `statSync` itself succeeded. `agent-metrics log
  status` now prints `Read failed: <message>` in place of `Line count:` when
  this is set.
- **Codex session scan skip/size diagnostics.** `findCodexAgentFile` /
  `findRecentCodexAgentFiles` (and `findRecentAgentFiles`'s two parallel
  scan loops) now thread a scan-observation accumulator: an unreadable
  nested session subdirectory or an unreadable/malformed individual rollout
  file (`readCodexSessionMeta`'s open/read/`JSON.parse` failures — internal,
  not re-exported from `index.ts`) is
  recorded and surfaced as **one** stderr diagnostic per scan naming the
  count and the first failing path — these were previously swallowed
  entirely, indistinguishable from "no matching file". A new
  `CODEX_SCAN_NOTICE_THRESHOLD` (1000, also internal-only) additionally emits one "scanning N
  Codex session files…" notice past that size; this is an observation, not
  a cap — the scan remains exhaustive. The pre-existing "sessions directory
  doesn't exist" case (Codex never used) stays silent by design.
- **`log tail --follow` poll-failure diagnostic.** A non-`ENOENT` error
  while polling the log file (e.g. `EISDIR`) now writes one deduplicated
  stderr line naming the errno instead of failing silently; `ENOENT`
  (rotation/deletion) still resets the tracked offset with no diagnostic.
- **`AppendOptions` and `BufferQuery`** — the previously-anonymous options
  types for `appendToBuffer` and `queryBuffer` are now named, exported
  interfaces (re-exported from `index.ts`, documented in the README Types
  block). Structural typing means this is non-breaking — no caller changes
  required.
- **README "Error signalling" subsection** (Programmatic Usage, after Core
  Extraction Functions). Documents, function by function, which of
  `extractAgentMetrics`, `extractMultipleAgentMetrics`,
  `extractMetricsFromFile`, `findAgentFile`, `appendToBuffer`,
  `cleanupExpired`/`clearSession`/`clearAgents`/`annotateBufferEntries`, and
  `readBuffer` return `null`/`[]` for "not found" versus throw for "found
  but unusable" — `extractAgentMetrics` in particular can do both, which the
  existing example did not make clear. Matching `@throws` JSDoc added to
  `extractAgentMetrics` (extractor.ts) and to `extractCodexMetricsFromFile`/
  `extractCodexAgentMetrics` (codex-extractor.ts, internal — not re-exported
  from `index.ts`), which previously had no JSDoc at all.

### Changed

- **`extractMultipleAgentMetrics` no longer rejects the whole batch when one
  agent's extraction fails.** Switched `Promise.all` to `Promise.allSettled`;
  a rejected extraction now resolves to `null` in the returned `Map` and
  writes a stderr diagnostic naming the agent id and failure reason
  (mirroring `commands/core.ts`'s `compare` command), instead of the entire
  call rejecting and every other agent's already-successful extraction being
  discarded with it. **Semantics-only change — the return type
  (`Map<string, AgentMetrics | null>`) and signature are unchanged**, so
  this is easy to miss on a diff: a caller relying on the old reject-on-any-
  failure behavior (there were none in this codebase) would now see a
  populated map with a `null` entry instead of a catchable rejection. The
  original `Promise.all` was a deliberate parallel-reads performance choice
  (commit `1687bfb`), not an oversight; this change preserves the
  parallelism and only changes failure isolation.

- **`isValidBufferEntry` (internal — not re-exported from `index.ts`) now
  checks every field `formatters.ts` and
  `entriesToTrackerFormat` dereference unconditionally** — `metrics.model`,
  `metrics.duration_ms`, `metrics.duration_formatted`, and
  `metrics.execution.tool_use_count`, in addition to the token fields it
  already checked. A buffer line that passed the old, narrower check but was
  missing one of these fields previously crashed `formatReport` /
  `formatBufferList` / `formatBufferSession` on the first render; it is now
  skipped on read, and the stderr warning names the specific missing field.
  **Correction:** this entry previously said the row was "silently skipped
  on read" without qualification, implying the row was gone. It was
  skipped only from that one `readBuffer()` call's return value — until the
  fix below, a subsequent GC/annotate rewrite (`cleanupExpired`,
  `clearSession`, `clearAgents`, `annotateBufferEntries`) would rebuild the
  buffer file from that same filtered output and permanently delete the
  skipped line. Quarantined lines (internal — not re-exported from
  `index.ts`) are now preserved verbatim across those rewrites; see the
  entry below. Optional cross-harness fields (`end_time`, `agent_name`,
  token extras like `cached_input`/`reasoning_output`) remain unchecked.
- **Rewrite paths (`cleanupExpired` / `clearSession` / `clearAgents` /
  `annotateBufferEntries`, via internal `removeWhere`) no longer permanently
  delete quarantined buffer lines.** Both rewrite paths rebuilt the buffer
  file from `readBuffer`'s already-filtered output, so any line
  `isValidBufferEntry` rejected — or that failed to parse — was silently
  dropped, uncounted, the next time a GC or annotate rewrite fired; this
  contradicted the "the file is never rewritten or truncated by reads" claim
  in `docs/decisions/0002-jsonl-buffer-format.md` (true of reads in
  isolation, not of the write paths that read before rewriting). A new
  internal `readBufferWithQuarantine` (buffer.ts, not re-exported from
  `index.ts`) returns the raw text of every skipped line alongside the valid
  entries; both rewrite sites now append it verbatim to the rewritten file
  before the atomic rename. `readBuffer`'s public signature and behavior are
  unchanged; `removedCount`/`updated` return semantics are unchanged (they
  still count only valid entries).
- **Wrapped read errors preserve the original as `.cause`.** Both
  `extractMetricsFromFile`'s "Unable to read agent metrics file" wrapper and
  `extractCodexMetricsFromFile`'s (internal — not re-exported from
  `index.ts`) "No valid Codex session records found"
  error (which now also names the file path) keep the underlying error
  (e.g. `ENOENT`) reachable via `err.cause` / include the path in the
  message, instead of discarding it. Wrapper message text is unchanged, so
  existing regex-matching callers are unaffected.
- **`queryBuffer({ since })` now fails closed on an unparseable
  `captured_at`**, matching the existing `endTimeAfter`/`endTimeBefore`
  posture: `new Date(entry.captured_at) < query.since` is always `false`
  when `captured_at` doesn't parse (`Invalid Date` comparisons are always
  `false`), so such a row previously passed every `since` window
  unconditionally instead of being excluded. QUERY-SCOPED — `readBuffer`
  and `isValidBufferEntry` never reject a row for this; only this filtered
  view changes.
- **`getAllForSession`'s sort comparator is now NaN-safe.** It compared
  `new Date(a.captured_at).getTime() - new Date(b.captured_at).getTime()`
  directly; an unparseable `captured_at` on either side produces `NaN`,
  which `Array.prototype.sort` handles inconsistently (engine-dependent,
  and not guaranteed to place the row anywhere predictable). Entries with an
  unparseable `captured_at` now sort last, deterministically.
- **`formatBufferList` (display/formatters.ts) no longer renders the raw
  `Invalid Date` string** for an unparseable `captured_at` — it now renders
  an explicit `(invalid date)` sentinel.
- **De-duplicated the unique-temp-name construction in `buffer.ts`.**
  `removeWhere` and `annotateBufferEntries` each built
  `` `${config.bufferPath}.${process.pid}.${randomUUID()}.tmp` `` inline; both
  now call a new internal `bufferTempPath(bufferPath)` (not re-exported from
  `index.ts`, but exported from `buffer.ts` and `/** @internal */`-marked so
  it can be imported directly in tests), which also now carries the
  crash-atomicity and stale-reclaim-collision rationale comment that used to
  live only at the `removeWhere` call site. No behavior change — same path
  shape, same two call sites.

### Fixed

- **Codex `session_meta` was never read on real rollouts.** `readCodexSessionMeta`
  (internal) read a fixed 8192 bytes and parsed the first line from that, but
  a real `session_meta` line is ~20KB (it embeds the instructions text), so
  `JSON.parse` failed on every rollout, `agent-metrics list` never showed a
  Codex subagent, and the `session_meta.payload.id` fallback in
  `findCodexAgentFile` never matched. The reader now follows the first line to
  its newline in 64KB chunks, capped at 1 MiB (a longer line is reported as a
  scan skip naming the file). Surfaced live on 2026-09-03 by the new scan-skip
  diagnostic, which reported all 43 rollouts on the dev machine as unreadable.
- **`prepublishOnly` ordering let test artifacts persist into the packed
  tarball.** It ran `npm run build && npm test`; `npm test`'s
  `tsconfig.test.json` compile (same `outDir: dist`, tests included) ran
  *after* `build`'s prod-only compile and doesn't clean first, so `dist/`
  was guaranteed to hold `*.test.js`/`.d.ts`/`.map` and `test-utils.*` at
  pack time — the `files` field's negations were the sole thing keeping them
  out of the tarball. Reordered to `npm test && npm run build && npm run
  check:pack`: `build`'s `clean` step now runs *after* the test compile and
  wipes it, so `dist/` holds only the prod-only `tsconfig.json` emit at pack
  time. The negations and `.npmignore` are kept as defense-in-depth; the new
  `check:pack` (see Added) verifies the outcome directly.
- **`program.parse()` silently dropped async command rejections.** The CLI
  now calls `program.parseAsync().catch(...)`, printing a clean error and
  exiting 1 instead of letting Node's default unhandled-rejection crash dump
  a raw stack trace. The `find` command's action is now wrapped in the same
  `try/catch` shape as `extract`/`list`/`compare`, so a filesystem error
  (e.g. an unreadable `~/.claude/projects`) is reported cleanly rather than
  surfacing as an unhandled rejection.
- **Two empty `catch` blocks that discarded real failures.** `extract
  --agent-name`'s buffer write-back and `appendToBuffer`'s opportunistic GC
  both now report non-`LockAcquisitionError` failures (buffer unreadable,
  etc.) via `console.error`/stderr + a `warn()` log line, instead of
  swallowing them silently. Both remain non-fatal: the extract still
  succeeds and the append still returns its entry. `LockAcquisitionError`
  (expected under contention) is still ignored, as documented in
  `lock.ts`.
- **A transcript read failure was indistinguishable from "no `[agent:]`
  tag".** `getFirstUserMessageContent` (internal — not re-exported from
  `index.ts`)'s outer catch now logs a `warn()`
  entry naming the transcript path and error before returning `null`,
  instead of returning `null` silently for both cases. The stale "locked
  during agent execution" comment is corrected — this read runs at
  `SubagentStop`, after the agent has already stopped.
- **`getLogStats` returned a half-populated result on a read failure.** If
  the log file exists but can't be read, `lineCount`/`oldestEntry`/
  `newestEntry` now reset to their unknown values and `readError` is set,
  instead of leaving `lineCount` at a stale/partial value while `exists` and
  `sizeBytes` (from the successful `statSync`) looked normal.
- **`acquireLock` (internal — not re-exported from `index.ts`) spun the full
  timeout on any write failure, not just lock
  contention.** The stat/stale-reclaim branch now only runs when
  `writeFileSync` fails with `EEXIST` (a lock file is genuinely there); any
  other write error (`EACCES` on an unwritable parent, `EROFS`, a parent
  removed after the directory-create step, `EMFILE`...) falls through to the
  existing exponential-backoff block instead of retrying a doomed
  stat-then-write loop until `maxWaitMs` elapses.
- **`releaseLock` (internal — not re-exported from `index.ts`) silently
  discarded a real unlink failure.** A non-`ENOENT`
  error (e.g. `EACCES` on an unwritable parent directory) now writes a
  stderr diagnostic naming the lock path and error code; `ENOENT` (already
  released) remains fully silent. Never rethrows — this runs inside two
  `finally` blocks.
- **`getFirstUserMessageContent` (internal — not re-exported from
  `index.ts`) miscounted and undercounted malformed
  transcript lines.** A well-formed JSONL `null` line (`JSON.parse` succeeds,
  but `null.type` then threw) was counted as malformed; it is now skipped
  without incrementing the count. Separately, the malformed-line count was
  only ever checked *after* the read loop completed, so it silently never
  reported when a valid user message was found following the malformed
  lines (the loop returns early on a match) — the common case. Both paths
  now report correctly.
- **`handleHook` (internal — not re-exported from `index.ts`) printed a
  false "capture succeeded" summary when the
  buffer write was skipped.** `appendToBuffer`'s return value is now
  checked; a `null` return (lock contention — already warned by
  `buffer.ts`) suppresses the per-agent summary line instead of printing it
  unconditionally after a write that didn't happen. The hook still
  approves either way.
- **`queryBuffer`'s `endTimeAfter`/`endTimeBefore` window failed open on an
  unknown or unparseable finish time.** `entry.end_time || entry.metrics.end_time`
  falsy or an invalid date string (e.g. `'not-a-date'`) made both
  `endTime && ...` comparisons short-circuit to `false`, so the entry was
  never excluded — a caller asking "did this agent finish in window X"
  could get back rows with no verifiable finish time at all. The filter is
  now fail-closed: whenever either bound is set, an entry with no
  parseable end_time (own or backfilled from `metrics.end_time`) is
  excluded. Scoped to the query only — `isValidBufferEntry` still leaves
  `end_time` unchecked on read, so an absent end_time remains a legitimate
  buffer row outside an end-time-windowed query. Callers relying on the old
  fail-open behavior will see fewer rows for a windowed query when rows
  lack a usable end_time.
- **`safeNum` (internal — not re-exported from `index.ts`) admitted
  `Infinity`/`-Infinity`.** It coerced a value to a number only when
  `typeof v === 'number' && !isNaN(v)` — `Infinity` and `-Infinity` pass
  both checks, so a token field parsed from a pathological input like
  `JSON.parse('1e999')` (which yields `Infinity`) flowed straight into the
  token sums. `total_effective`/`total_raw` then went `Infinity`,
  `JSON.stringify` renders that as `null`, and downstream
  `isValidBufferEntry` rejects the whole row (or `-f tracker` output emits a
  literal `null` into a `save_run` payload). Now `Number.isFinite(v)`, so
  both infinities coerce to `0` like any other non-numeric input — matching
  the guard `codex-extractor.ts` already used. `extractor.ts`'s copy was the
  narrower one; the two are byte-equivalent now.
- **`buffer list --since` accepted a well-formed but out-of-range duration
  and silently returned the unfiltered list.** `parseSinceDuration`
  computed `new Date(Date.now() - ms)` without checking the result — an
  absurd-but-regex-valid input like `99999999999999999999m` overflows to an
  `Invalid Date`, which every comparison in `queryBuffer`'s `since` filter
  treats as `false`, so no row is ever excluded. The function now validates
  the computed date and returns `null` (routing through the existing
  invalid-format error path, exit 1) instead of silently proceeding with a
  useless filter. The error message is broadened from "Use a number
  followed by 'm' or 'h'" (misleading for a well-formed value that merely
  overflows) to also name the range requirement.
- **Three unused type imports in `extractor.ts`.** `TokenMetrics`,
  `ExecutionMetrics`, and `ContentBlock` were imported from `./types.js` but
  never referenced outside a single comment mentioning `TokenMetrics` by
  name; removed. No behavior change — these are type-only imports, and
  `noUnusedLocals` is not enabled, so this was previously undetected by the
  build.
- **Documentation corrections.** README's Buffer Functions import block was
  missing `annotateBufferEntries` (exported since v0.7.0) and
  `LockAcquisitionError`; both are added. CHANGELOG `[0.8.0]` now qualifies
  `RUN_TAG_PATTERN`/`extractRunTag`/`detectRunToken` and `sanitizeLineSafe`
  as internal-only (not re-exported from `index.ts`, and — for the hook
  helpers — not reachable via the package's `exports` map at all, only as a
  file path per the README's hook wiring), matching this file's own
  precedent phrasing for internal symbols. The same qualification is applied
  to internal symbols named unqualified elsewhere in this Unreleased section.
- **`configureLogger` accepted `undefined` and invalid `minLevel` values and
  silently applied them.** With `exactOptionalPropertyTypes` not enabled in
  `tsconfig.json`, `configureLogger({ minLevel: undefined })` typechecks, and
  the unconditional `{ ...currentConfig, ...config }` spread let it overwrite
  a caller's already-set level — the same applied to `enabled` (logging
  silently disabled) and `logPath` (an `undefined` path throws inside
  `ensureLogDir`'s `path.dirname` on the next write). Rejected keys —
  `undefined` for any field, or a `minLevel` that isn't one of the four
  known levels (a new internal `isLogLevel` type guard, using
  `hasOwnProperty` rather than the `in` operator so `'constructor'` cannot
  pass) — now write one stderr diagnostic naming the key and the received
  value and are dropped from the patch **before** the merge, so the current
  value is retained rather than falling back to `DEFAULT_CONFIG` (which
  would loosen a level a caller deliberately tightened). Sibling keys in the
  same call are unaffected. This module still never throws on bad input —
  semantics-only change, `configureLogger`'s signature is unchanged.
- **`readStdin`'s 1MB stdin cap bounded resolution latency, not memory.**
  The `data` handler's `done()` early-returns on a call after the promise
  has already resolved, but `done()` returning does not stop the handler
  itself from running — every subsequent chunk of an adversarial payload
  still ran `data += chunk` and re-scanned `Buffer.byteLength(data)` for the
  rest of the stream. The handler now checks `resolved` as its first
  statement, and computes `Buffer.byteLength(data) + Buffer.byteLength(chunk)`
  against the cap **before** appending (rather than after), so an
  over-cap chunk is discarded without ever being concatenated onto `data`.
  The cap branch now also writes a stderr diagnostic (`stdin exceeded <N>
  bytes; discarding payload`), matching the existing hard-deadline path's
  diagnostic, so the discard is visible instead of silent.
- **Documentation.** `LogLevel` and `LoggerConfig` (logger.ts) gained JSDoc
  summaries — the level ordering (`debug < info < warn < error`) and
  `minLevel`'s floor semantics for the former, the mutate-via-`configureLogger`
  /read-via-`getLoggerConfig` contract for the latter — bringing all 19 types
  re-exported from `index.ts` to a documented summary (was 17/19). Five
  public functions (`extractAgentMetrics`, `extractMultipleAgentMetrics`,
  `appendToBuffer`, `queryBuffer`, `configureLogger`) gained a one-line
  `@see README.md § <section>` JSDoc tag pointing at their README
  documentation.

### Provenance

- Iteration 1: eight fixes, produced and verified by the `issue-remediation`
  pipeline (tracker `agent-metrics`), each with a regression test proven to
  fail against the pre-fix code and pass after.
- Iteration 2: six further code changes closing eleven tracker issues
  (several were sibling low/medium pairs on the same code path), same
  pipeline and discipline — every regression test proven to fail against
  the pre-fix code and pass after the fix, including two control tests
  (a genuinely-malformed transcript line still warns; a non-`session_meta`
  Codex record still produces no stderr) verifying the fixes didn't
  overcorrect. `npm run build` + full suite green (346 tests, up from 326).
- Iteration 3: eight tracker issues closed — `queryBuffer`'s `endTime`
  window fails closed on absent/unparseable `end_time` (two issues, one
  predicate); the `GC_INTERVAL_MS` comment corrected to say the throttle is
  per-process (the cross-process mechanism is deferred to the spec queue);
  README import blocks completed (`annotateBufferEntries`,
  `LockAcquisitionError` as a value import) with the `check:readme-exports`
  gate added so the next export cannot land undocumented; the `[0.8.0]`
  hook-internal symbols qualified in place; CLI-layer `-f tracker` `run_id`
  exclusion and the run-token 64-char cap pinned by tests (the latter
  proven against a `{2,127}` regex mutation that would otherwise truncate
  silently); and `prepublishOnly` reordered to `test && build && check:pack`
  so test artifacts can no longer reach the tarball by build ordering, with
  the `check:pack` gate added. Suite 346 → 354, every new test proven
  fail-first.
- Iteration 4: four tracker-issue fixes closed (three unused type imports;
  `safeNum` admitting `Infinity`; `buffer list --since` overflow;
  query/display-half of the unparseable-`captured_at` issue — the
  `isExpired` retention-policy half is deliberately deferred to the spec
  queue), one contextual issue's documentation half only (error-signalling
  JSDoc + README, left open — see the issue's own note), and one untracked
  finding from this iteration's investigation: `cleanupExpired` /
  `clearSession` / `clearAgents` / `annotateBufferEntries` were silently
  deleting quarantined (skip-on-read) buffer lines on every triggered
  rewrite — fixed via a new internal `readBufferWithQuarantine`. Also named
  three previously-anonymous option/query types (`AppendOptions`,
  `BufferQuery`, in-file-only `MetricsCaptureOptions`) and deduplicated a
  test-only helper (`hook.test.ts`'s `createTestTranscript`, no production
  code touched). Same pipeline and discipline — every regression test
  proven to fail against the pre-fix code and pass after, with named
  negative controls (e.g. `1e10` still round-trips; `2400000000h` is still
  accepted; a valid `captured_at` still renders/sorts/filters normally).
  `npm run lint` + `npm test` + `npm run build` + `npm run check:pack` +
  `npm run check:readme-exports` all clean; full suite green (367 tests, up
  from 354 — the pre-existing suite's 354 all still pass unmodified, one
  duplicate helper aside).
- Iteration 5 (final): six tracker issues closed — `LogLevel`/`LoggerConfig`
  JSDoc summaries (census: 19/19 index.ts-re-exported types now documented,
  was 17/19); `configureLogger` now rejects `undefined` and invalid
  `minLevel` values at the merge point instead of silently applying them
  (warn-and-retain, never throws, sibling keys unaffected); five `@see
  README.md § ...` JSDoc tags added (discretionary polish on an
  already-observation-stamped issue, no test); the duplicated unique-temp-name
  construction in `buffer.ts` extracted into one internal `bufferTempPath`
  helper, and the `.tmp`-file-lingering test at `buffer.test.ts` — which
  asserted against a fixed suffix (`<bufferPath>.tmp`) that no code has ever
  produced, so it passed vacuously even with the atomic rename disabled —
  replaced with a sibling-directory scan that does fail under that same
  negative control; `readStdin`'s 1MB stdin cap now bounds memory (checked
  before the chunk is appended, first statement of the handler returns early
  once already resolved) instead of only resolution latency, with a stderr
  diagnostic added at the cap matching the existing hard-deadline path's;
  and five README CLI-example gaps (a missing `-p` flag on the `extract`
  table row and four missing example invocations) closed per an exact
  census of the 17 Commands Reference rows. Same pipeline and discipline —
  every regression test proven to fail against the pre-fix code and pass
  after, including two negative-control demonstrations for the temp-path
  fix (a fixed-suffix regression on `bufferTempPath` alone, and a
  disabled-rename regression reproducing the exact "21 !== 1" cap-diagnostic
  symptom the stdin fix's own restructuring avoids). `npm run lint` +
  `npm test` + `npm run build` + `npm run check:pack` + `npm run
  check:readme-exports` all clean; full suite green (375 tests, up from 367
  — the pre-existing suite's 367 all still pass unmodified).

## [0.8.0] - 2026-07-15

### Added

- **Run-scoped token attribution** (see `docs/decisions/0004-run-scoped-attribution.md`).
  An orchestrator-minted **run token** rides the existing first-user-message tag
  channel as `[run:<token>]` (alongside `[agent:<name>]`), letting a pipeline
  collect *exactly* its own agents' token metrics instead of everything in a
  rolling `--since` window. Motivated by an issue-remediation run where the
  60-minute buffer window pulled in agents from other concurrent sessions, so
  the metrics were omitted rather than mis-attributed.
  - **`[run:token]` tag + `RUN_TAG_PATTERN` / `extractRunTag` / `detectRunToken`**
    in the SubagentStop hook (none re-exported from `index.ts` — internal
    only, and not reachable via the package's `exports` map at all; `hook.ts`
    is wired in only as a file path, per the Setup section below). Grammar
    `/\[run:([a-z0-9][a-z0-9-]{2,63})\]/i` —
    its own namespace (a leading digit is permitted, unlike agent names), 3–64
    chars, line-safe by construction (excludes `]` and control chars). The hook
    reads the first user message **once** and extracts both the agent name and
    the run token from it (no second transcript read).
  - **`BufferEntry.run_id`** — a new optional field persisting the token.
    Backward-compatible: absent on pre-0.8.0 rows and on any untagged agent;
    unvalidated, so old rows stay valid.
  - **`queryBuffer({ runId })` + `appendToBuffer({ runId })`** — an exact-match
    run-token predicate.
  - **`buffer list --run <token>`** — CLI flag for the exact run-scoped query.
    Composes with `-p`/`--since` as an AND of predicates; case-insensitive at
    the surface.
- **`sanitizeLineSafe`** — the single line-safety helper (strip control chars +
  64-char cap) now shared by `agent_type` and the run token (not re-exported
  from `index.ts` — internal only, and not reachable via the package's
  `exports` map at all; only importable as a `hook.ts` file path).

### Notes

- **`run_id` is a buffer-query key, not a tracker payload field.** It is
  deliberately *not* emitted in `-f tracker` output: the tracker `save_run`
  `agents[]` schema is strict (`additionalProperties: false`), so an extra key
  would be rejected. It selects which rows splice into `agents[]`; the rows
  themselves join by `agent_id` as before. `run_id` *is* visible in `-f json`.
- No change to the `-f tracker` output shape — existing consumers are unaffected.

## [0.7.1] - 2026-07-15

### Fixed

- **`agent_type` sanitized before persistence.** `parseHookInput` now strips
  control characters and caps `agent_type` at 64 chars before it flows to
  `agent_name` → the JSONL buffer → the tracker. An embedded newline would
  otherwise split a buffer line and silently drop the entry on read
  (`readBuffer` splits on `\n`) — closing the asymmetry with the already-gated
  `agent_id` and transcript-path fields. Public type unchanged
  (`agent_type: string | undefined`); a clean slug is untouched. +3 tests.
- **Removed dead lock guard in `appendToBuffer`.** The `if (lockAcquired)`
  wrapper in the `finally` block was provably always-true — the early
  `if (!lockAcquired) return null` guarantees the lock is held there — so
  `releaseLock` is now called unconditionally. No behavior change (release ran
  exactly when it ran before); removes a misleading dead branch.

### Provenance

- Both fixes were produced and verified by the `issue-remediation` pipeline
  (tracker `agent-metrics` run #16), resolving issues `a2756123` and `bd4b9914`.
  `npm run build` + full suite (290 tests) green.

## [0.7.0] - 2026-07-06

### Added

- **`agent_id` on tracker formats.** `toTrackerFormat` and `entriesToTrackerFormat`
  now emit the transcript/agent provenance id, making tracker rows joinable to
  buffer entries and transcripts (previously required token-value forensics).
- **Name write-back on extract.** Caller-supplied names (`--agent-name` /
  `--agent-names`) are persisted onto matching buffer entries via new
  `annotateBufferEntries()`, so entries captured nameless become name-complete
  for later queries. Best-effort; never fails the extract.
- **Hook parses `agent_type`.** SubagentStop name resolution is now explicit
  `[agent:name]` tag → harness-reported `agent_type` → nameless. The hook also
  debug-logs payload key names (keys only) so the actually-delivered fields are
  empirically observable — `agent_type` is documented inconsistently across
  Claude Code versions.

### Changed

- **BREAKING (behavior): buffer-rewrite operations are fail-closed.**
  `withFileLock` now throws `LockAcquisitionError` (new export) instead of
  running the callback unlocked when the lock cannot be acquired — an unlocked
  read-modify-rewrite could rename a stale snapshot over the buffer and
  silently destroy concurrently-captured entries. Affects the exported
  `cleanupExpired`, `clearSession`, `clearAgents`, and `annotateBufferEntries`:
  they now throw on lock contention where they previously proceeded unlocked.
  Internal best-effort callers (GC-on-append, extract write-back) catch and
  skip; the `buffer clear` CLI reports a clean locked-buffer message. Rewrites
  also use unique per-writer temp names (stale-lock reclaim can still admit a
  second writer; unique names bound that to last-rename-wins, never a torn file),
  and the hook enforces that the persisted `agent_id` join key equals the
  pattern-validated hook id.
- **Buffer TTL 24h → 30 days**, aligned with Claude Code transcript retention
  (`cleanupPeriodDays` default). The old 24h label was cosmetic — nothing
  auto-deleted, so 95%+ of entries sat "expired" but present.
- **Expiry is now real: GC-on-append.** `appendToBuffer` opportunistically runs
  `cleanupExpired()` after each capture (own lock; best-effort). Entries past
  TTL are actually removed rather than accumulating behind a `-a` flag.
- **Display fallback honors ADR-0001.** Untagged entries in `buffer list` show
  the project directory name (then agent id) instead of the literal `unknown`.
  `entriesToTrackerFormat` falls back to `agent_id` for the name — tracker saves
  enforce unique agent names per run, so a shared `unknown` literal collides.

## [0.6.0] - 2026-06-28

> **First npm release carrying Codex (OpenAI) support.** npm `latest` was `0.4.0`
> (Claude Code only); `0.5.0`/`0.5.1` (which added the Codex provider and its fixes)
> were never published. Upgrading from `0.4.0` therefore brings the **entire Codex
> session-rollout provider** — `--provider codex`, UUIDv7 auto-routing, Codex token
> fields — *plus* the `0.6.0` cross-harness work below. See the `[0.5.0]` and `[0.5.1]`
> entries for the Codex provider details.

### Added

- **Cross-harness token components carried through the tracker wire** (the §1.2
  data-death point). `toTrackerFormat` and `entriesToTrackerFormat` now emit
  `cached_input_tokens`, `reasoning_output_tokens`, `thinking_tokens`,
  `tool_tokens`, and `harness`. New `thinking`/`tool` fields on `TokenMetrics`
  (forward-compat for the Gemini provider). Display renders the new components.

### Changed

- **BREAKING (field rename): `AgentMetrics.provider` → `harness`**, values
  `'claude'` → `'claude-code'` (`'codex'` unchanged). Canonical harness vocabulary
  §2.4. The `ExtractOptions.provider` *dispatch option* is unrelated and unchanged.
- **Codex `total_effective` formula fix** — drop the `+ reasoning_output` term:
  `(input − cached_input) + output`. reasoning_output is a subset of GROSS output
  (already inside `output`); adding it double-counted. **Behavioral** — Codex
  `total_effective` decreases by the reasoning amount (G3: leave historical). §3.3.

### Fixed

- **CXA-1 (critical): Codex `token_count` without `total_token_usage` no longer
  zeroes all token metrics.** The handler now only overwrites accumulated usage
  when the event actually carries totals (keeps the last good value) — previously
  a trailing tokenless event clobbered everything to 0 silently.
- **F5 (critical): a buffer entry with `metrics` but no `tokens` no longer crashes
  the save_run batch.** `isValidBufferEntry` now requires `metrics.tokens`, and
  `entriesToTrackerFormat` skips tokenless entries defensively — one malformed
  entry can no longer TypeError the whole ship pipeline.
- **Codex `total_effective` clamped at 0** (issue 7ecac2a3): `Math.max(0, input −
  cached_input) + output` — a provider reporting `cached_input > input` can never
  drive the total negative.
- README Quick Start now leads with `list` and `extract` for npm-first users,
  reserving `report` for hook-buffer captures.
- README TypeScript examples now preserve `extractAgentMetrics` nullability and
  avoid undocumented top-level `await` assumptions.
- README command reference now documents `report --provider codex` as an
  accepted guidance path.
- Public TSDoc now covers Codex/Claude path helper return contracts,
  `isToolUseBlock`, and `logMetricsCapture` usage.
- Invalid Claude JSONL records now report the expected minimum fields in their
  warning message.

## [0.5.1] - 2026-06-27

### Fixed

- `list --provider auto` now sorts mixed Claude and Codex runs by file mtime
  before applying `--limit`.
- `list --project` now filters both Claude and Codex session files.
- `report --provider` now validates provider choices through Commander.
- README and CLI descriptions now consistently describe Claude Code and Codex
  provider support.
- Package publish configuration excludes internal test utilities from the
  production tarball.

## [0.5.0] - 2026-06-27

### Added

- Codex metrics provider for local Codex JSONL session rollouts under
  `~/.codex/sessions/` or `$CODEX_HOME/sessions/`.
- Provider-aware extraction via `--provider auto|claude|codex`; UUIDv7
  agent ids route to Codex in auto mode.
- Codex-aware token fields on `AgentMetrics`, including
  `tokens.cached_input`, `tokens.reasoning_output`, and
  `execution.reasoning_record_count`.
- `list --provider codex` and `find <uuidv7> --provider codex` support for
  Codex subagent rollouts.
- Package validation coverage for Codex single-turn extraction, multi-turn
  aggregation, provider dispatch, and CLI provider behavior.

### Changed

- Package description and README now describe Claude Code and Codex support.
- Buffer defaults are resolved lazily so tests and CLI invocations respect the
  current `HOME` environment instead of an import-time value.
- `report` remains Claude-buffer-backed in this release. Codex users should use
  `agent-metrics list --provider codex` and
  `agent-metrics extract <id> --provider codex`.

## [0.4.0] - 2026-05-29

### Changed

- **Breaking: agent detection is explicit-tag-only.** `detectAgentName`
  now returns the value of an `[agent:name]` tag in the first user
  message, or `null`. The 22-entry hardcoded `AGENT_PATTERNS` table is
  removed (the ecosystem has grown to 189+ agents; an enumerated list no
  longer represents reality). See `docs/decisions/0001-explicit-tag-detection.md`.
- **Breaking: legacy `[validator:name]` tag form is no longer recognized.**
  Workflow commands have emitted `[agent:...]` since the March 2026
  rename; accepting the old form preserved naming drift the Confucius
  forecaster flagged at that migration.
- Removed `AGENT_PATTERNS`, `AgentPattern`, and `matchAgentPattern` from
  `hook.ts` (none were re-exported from `index.ts` — internal only).

### Added

- `docs/decisions/` with three ADRs (explicit-tag detection, JSONL
  buffer, sync lock).

## [0.3.1] - 2026-05-28

### Fixed

- **Claude Code 2.1.145 compatibility** — `slug` field was dropped from subagent transcript messages starting in Claude Code 2.1.145, causing every message to fail the extractor's validator and the SubagentStop hook to silently produce no buffer entries. `slug` is now optional on `RawAgentMessage`; `AgentMetrics.slug` falls back to `agentId` when absent. Regression test added.

## [0.3.0] - 2026-04-02

### Added

- **Agent Name column** in report — auto-detected from `[agent:name]` tags, pattern matching, or project directory fallback
- **Cache% column** in report — shows cache hit rate per agent (`cache_read / total * 100`)
- **Batch extract** — `agent-metrics extract id1 id2 id3` accepts multiple agent IDs, outputs combined JSON array
- **`--json` flag** — alias for `-f json` on extract command (universal CLI convention)
- **`--agent-names` flag** — comma-separated names for batch tracker format: `extract id1 id2 -f tracker --agent-names "code-validator,test-architect"`
- **Workflow grouping** in report — agents sharing the same `prompt_id` (spawned from same user message) are grouped with box-drawing header showing agent count and total duration/tokens
- **`prompt_id` field** on `AgentMetrics` and `BufferEntry` — extracted from first transcript message for workflow grouping
- **Comprehensive `examples` command** — rewritten with Quick Start, Tracker Integration workflow, column documentation, and output format examples

### Changed

- Report project column shows last path segment fully (`ops-uluops-api`) instead of truncated 2-segment path
- Report table width increased from 85 to 110 chars for Agent Name and Cache% columns
- Extract command now variadic: `<agent-id>` → `<agent-ids...>`
- Tracker format batch output: single object for 1 agent, JSON array for multiple

## [0.1.0] - 2026-03-08

### Added

- Core metrics extraction from Claude Code agent JSONL session files
- Token metrics with full cache breakdown (input, output, cache_creation, cache_read, total_effective, total_raw)
- Execution metrics (message count, tool use count, tool breakdown, error count)
- Global metrics buffer with JSONL storage and file locking for concurrent access
- Buffer commands: list, session, gc, clear, status
- SubagentStop hook handler for automatic metrics capture
- CLI commands: extract, find, list, compare, report, examples
- Log commands: tail, stats
- Tracker-compatible output format for validation pipeline integration
- Buffer query filtering by session, agent, validator, project, time window
- 24-hour TTL with automatic garbage collection
- Cross-platform support (Linux, macOS, WSL)
