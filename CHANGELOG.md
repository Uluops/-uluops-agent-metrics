# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
