# ADR-0002: JSONL append-only buffer format

**Status:** Accepted (2026-05-29, retroactive)

## Context

The SubagentStop hook fires once per agent completion and produces one
metrics record. Downstream consumers — the report command, workflow
tracker integration, ad-hoc queries — need to read these records by
session, by agent name, by recency, and by TTL freshness.

The hook runs in a constrained context. Each invocation:

- Has a short timeout (10s default in Claude Code's hook config) and
  must complete before the parent conversation continues.
- Runs in a fresh Node.js process started by Claude Code; no shared
  in-memory state survives across hook invocations.
- Must not block or fail the agent it is observing — any error here is
  swallowed.
- May run concurrently with other hook invocations when a workflow
  spawns multiple agents in parallel.

The buffer is one of the few persistence boundaries in the package.
Choice of storage format ripples into every consumer.

## Decision

Buffer storage is an append-only JSONL file at
`~/.claude/agent-metrics-buffer.jsonl`. Each line is one
`BufferEntry`. Writes are append-only under a sync filesystem lock
(see ADR-0003). Reads stream the file line-by-line, parsing each
entry independently. TTL is per-entry (`expires_at`); expired entries
are filtered at read time and garbage-collected by an explicit
`cleanupExpired()` call.

The format is treated as an internal contract between this package
and itself, not a public interface. The `buffer.ts` module is the
sole reader and writer; consumers go through its exported functions.

## Alternatives considered

**A. SQLite (`better-sqlite3` or `node:sqlite`).**
Indexed queries, transactional safety, no manual locking. Rejected
because (a) adds a native module dependency, breaking the package's
zero-native-dep posture; (b) database file initialization in a
short-lived hook context introduces a startup tax on every agent
completion; (c) the access pattern — append-mostly with whole-file
reads — does not benefit from indexes at the volumes we observe (a
typical workflow session produces 5–30 entries, TTL'd at 24h).

**D. JSON array file (read-modify-write).**
Simpler in-memory model. Rejected because every write requires
reading and rewriting the entire file, which both inflates the write
cost as the buffer grows and creates a much wider window for
torn-write corruption under concurrent hook invocations. The
`packages/-uluops-tracker` SQLite corruption incident
([feedback_data_loss_story]) is a constant reminder that data loss
in the metrics layer is real, not hypothetical.

**C. Redis or any out-of-process daemon.**
Was the original aspiration (the module header comment still says
"Designed for future Redis migration"). Rejected because it requires
the user to run a separate process for a tool that observes Claude
Code, which is itself a CLI. The buffer interface in `buffer.ts` is
deliberately shaped so a Redis backend remains substitutable later
if and when distributed buffering becomes a real requirement.

**D. Memory-mapped log structure / write-ahead log.**
Best concurrency story. Rejected as massively disproportionate to
the problem — at this scale, JSONL plus a lockfile gives the same
durability guarantees with two orders of magnitude less code.

## Consequences

**Accepted downsides:**

- Whole-file reads scale linearly with entry count. At 24h TTL and
  typical traffic this stays well under 10MB; at adversarial volumes
  (a runaway workflow) it could degrade. The package logs buffer
  size on each operation so this is observable.
- No transactional guarantees across multiple writes; each line is
  atomic, but a sequence of related entries (e.g. a workflow's set
  of agents) is not atomic as a group.
- Corruption recovery is per-line: a malformed line is skipped with
  a stderr warning, not surfaced as an error. The file is never
  rewritten or truncated by reads.

**Acquired benefits:**

- Zero runtime dependencies for the buffer layer.
- `tail -f ~/.claude/agent-metrics-buffer.jsonl` is a debugging tool
  for free.
- A migration path to any backend exists through the existing
  `buffer.ts` interface; no consumer needs to change.
- Backwards-compatibility is line-by-line: new optional fields on
  `BufferEntry` do not break older readers, and older readers do not
  break new writers.

## References

- `src/buffer.ts` — `appendToBuffer`, `readBuffer`, `readValidEntries`
- ADR-0003 — Atomic file-system lock for buffer writes
- Issue `STR-INV/I` (`JSONL buffer classified INTENTIONAL — abstraction layer ready for migration`)
