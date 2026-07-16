# ADR-0004: Run-scoped token-metrics attribution via an orchestrator-minted run token

**Status:** Accepted (2026-07-15)

**Extends:** ADR-0001 (explicit-tag-only detection). This decision adds a
second explicit tag — `[run:token]` — to the same first-user-message
channel that `[agent:name]` already rides, and inherits ADR-0001's
missed-tag failure mode by construction.

**Introduced in:** v0.8.0.

## Context

The buffer is a rolling, session-spanning store of every agent capture the
SubagentStop hook sees. Downstream, a pipeline orchestrator (the
`pdl-executor` skill) collects the token metrics for *its* run by shelling
out to `agent-metrics buffer list ... -f tracker` and splicing the result
verbatim into a tracker `save_run` `agents[]` payload.

The only selection key that existed for that collection was a time window
(`--since 60m`) optionally narrowed by project (`-p`). During
issue-remediation run #16 (agent-metrics, 2026-07-15) that window returned
agents from *other concurrent sessions* (deep-explore, gap-analyst,
popper-analyst, pre-implementation-architect, contradiction-detector) that
were not part of the run. Because CLAUDE.md forbids fabricated token
numbers, the metrics were **omitted** rather than mis-attributed — a loud,
correct failure, but a failure: the run's real token cost went unrecorded.

The structural problem: a "run" is an orchestrator concept with no encoding
in the transcript. `prompt_id` groups agents from a single user message —
too fine, since a pipeline run spans many assistant turns and iterations.
`session_id` spans the whole Claude Code session — too coarse, since a
session contains many unrelated runs. The run boundary sits between the two,
and nothing the hook can observe marks it. Only the orchestrator knows which
agents belong to which run.

## Decision

**1. A run token carried on the existing explicit-tag channel.** The
orchestrator mints a per-run token and emits it as `[run:<token>]` in the
first user message of every agent prompt in the run, alongside
`[agent:<name>]`. The hook extracts it (`RUN_TAG_PATTERN` /
`extractRunTag`), reads the first user message **once** for both tags (the
single-read invariant — no second transcript read), and persists it as a new
optional `BufferEntry.run_id`. A new `queryBuffer({runId})` predicate and a
`--run <token>` CLI flag select exactly the run's rows.

The token has its own grammar — `/\[run:([a-z0-9][a-z0-9-]{2,63})\]/i` — a
deliberately *wider* grammar than the agent-name tag (a leading digit is
permitted) because a token is an identifier, not a name, and a segment may
begin with a hex/numeric char (e.g. a session-id prefix or a run counter).
It is line-safe by construction: the character class excludes `]` (which
would close the tag early) and control characters (which would split JSONL
lines), so the regex can capture neither. The extracted value is still passed
through the same `\x00-\x1f\x7f` strip + 64-slice as `agent_type`
(`sanitizeLineSafe`), keeping one line-safety code path.

**2. The token is a buffer-QUERY key, never a tracker payload field.** The
tracker `save_run` `agents[]` item schema is strict
(`additionalProperties: false`; permitted keys are `name`, `decision`,
`score`, `max_score`, `model`, `duration_ms`, `agent_id`, `tokens`,
`definition_version`, `summary`). A `run_id` key spliced verbatim into
`agents[]` would be **rejected at save time**, not silently carried.
Therefore `run_id` is **not emitted** in the `-f tracker` output:
`TrackerAgentFormat` and `entriesToTrackerFormat` are unchanged. The token's
job ends at the query — `buffer list --run <token>` selects which rows to
emit; the emitted rows carry exactly today's fields and splice by `agent_id`
as before. The `run_id` remains visible in `-f json` (which serializes the
raw `BufferEntry`) for human inspection.

This is the correction over the original draft, which assumed the tracker
schema ignored unknown keys and would carry `run_id` as a persisted join
field. It does not. The buffer-query key achieves the same exact join with
**zero tracker-side change** — removing a cross-repo dependency entirely.

## The LLM-mint tradeoff

The orchestrator is a skill (an LLM), not code. It has no `randomUUID()` /
`Date.now()` primitive it can call at mint time; it can only compose a token
from context it already holds verbatim. The chosen scheme is:

```
<tracker_project>-<workflow-abbrev>-<session8>-<nonce4>
e.g. agent-metrics-ir-31948701-01
```

- `<session8>` — the first 8 hex chars of the Claude Code `session_id`
  (`$CLAUDE_CODE_SESSION_ID`, a hex-leading UUID). This is the
  **load-bearing uniqueness source**: it separates runs across sessions with
  no round-trip and no shared counter.
- `<nonce4>` — 4 chars the model varies per run, whose *only* job is to
  disambiguate two runs of the same project+workflow started within the
  **same** session. The orchestrator holds the token only in the current
  run's state (no cross-run counter), so two sequential same-session
  same-workflow runs could independently pick the same nonce.

The uniqueness is therefore **probabilistic, not cryptographic**. This is
accepted deliberately. The residual collision (same session, same
project+workflow, same nonce) produces **over-collection** — both runs' agents
merge into one `--run` result — bounded to a single project by the `-p`
composition guard, and **never mis-attribution** to the wrong project. A
malformed or missed token fails safe: it simply does not match on extract, so
that agent's row is excluded from the `--run` result (same absence semantics
as a missing `[agent:name]`).

Because the dangerous direction is silent *under*-collection (a dropped
`[run:]` tag drops that agent's tokens from the run), the orchestrator MUST
run a count check whose expected count has provenance **independent of the
LLM** — derived from the parsed pipeline structure (Σ fan-out entries ×
iterations executed), not from the model's memory of what it launched. On
`attributed < expected` it warns loudly and records the shortfall on the run.
When the expected count is derived independently, the two counts cannot be
depressed by the same error, so under-collection is caught rather than silent.

**Enforcement caveat (this package does not contain the count-check).** The
count-check is a *consumer-side obligation*, currently discharged by the
`pdl-executor` skill (an LLM), not a primitive in this package. `agent-metrics`
ships the mechanism the check relies on — the `--run` filter that returns the
attributed set — but it does not itself enforce that a consumer runs the check,
nor that the expected count is truly derived independently. The guarantee is
therefore **mitigated, not impossible**: as strong as the consumer's discipline.
A future `agent-metrics reconcile --run <token> --expect <n>` (exit-nonzero on
shortfall) would move the guarantee into this artifact and make it enforceable
here; until then, "silent under-collection is prevented" is a claim about the
consumer's behavior, not about this package in isolation.

**Rejected uniqueness sources:**

- **A tracker run-counter (`get_latest_run` + 1) as the identifying segment.**
  Two orchestrators — or two turns of one — that read the same
  `get_latest_run` before either saves both mint the same counter (a race the
  nonce only papers over), and it costs a pre-save round-trip. A run counter
  MAY appear only as an optional cosmetic segment for readability, never as
  the segment correctness relies on.
- **A raw UUID.** The orchestrator has no UUID primitive and would hand-invent
  32 hex chars — error-prone, and the grammar would have to widen.
- **A bare timestamp.** LLMs do not reliably have sub-second wall-clock;
  collides at minute granularity across parallel runs.

## Alternatives considered

**A. Reuse `prompt_id`.** Zero cost, but a run spans many `prompt_id`s (one
per user message); it would collect only the last turn's agents. Rejected.

**B. Reuse `session_id`.** Zero cost, but a session contains many runs; this
is exactly the run #16 failure, unchanged. Rejected.

**C. Run token AS a persisted tracker field.** Exact and queryable
server-side, but requires a tracker schema change (`agents[]` is strict). The
buffer-query key achieves the same join with no tracker change. Rejected.

**D. Time-bracket `[start,end]` ∩ launched-name set.** Bracket buffer rows by
`end_time` to the pipeline window, then intersect with the exact set of agent
names the orchestrator launched. Reduces pollution but (a) cannot
disambiguate two same-name agents (e.g. two `finding-investigator`s) in the
bracket, and (b) is a heuristic, not a join — a same-name agent from a
concurrent unrelated run inside the bracket is indistinguishable. Rejected as
primary; retained as the documented floor for legacy rows lacking `run_id`.

**E. Have the hook or harness synthesize a run id.** Impossible — "run" is an
orchestrator concept the hook cannot observe.

## Consequences

**Accepted downsides:**

- A dropped `[run:]` tag silently removes that agent from a `--run` result.
  Mitigated (not eliminated) by the mandatory, LLM-independent count check on
  the consumer side.
- Uniqueness is probabilistic. The worst case is over-collection within one
  project, surfaced by the count check as the benign larger-than-expected
  direction.
- Only the `pdl-executor` postflight adopts `--run`. Other `buffer list`
  consumers (ad-hoc `-f tracker` splices, the `buffer session` command)
  remain window-scoped.

**Acquired benefits:**

- An **exact** 1:1 join between a run's agents and its buffer rows, with
  same-name disambiguation the time-bracket floor cannot provide.
- **Zero tracker-side change** — no cross-repo dependency.
- The `-f tracker` output shape is byte-identical to v0.7.x; no existing
  consumer sees a new field or breaks.
- Backward-compatible: `run_id` is optional and unvalidated; rows captured
  before v0.8.0, and any untagged agent, remain valid and simply never match a
  `--run` query.

## References

- Motivating incident: issue-remediation run #16 (agent-metrics), 2026-07-15.
- Spec: `agent-metrics-run-scoped-token-metrics-spec` v0.2.0
  (uluops-specifications), folding pre-implementation review run #1
  (findings CMP-1, A1, A11).
- Related: ADR-0001 (explicit-tag-only detection) — the tag channel and the
  missed-tag failure mode this decision inherits.
