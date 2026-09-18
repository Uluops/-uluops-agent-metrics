# Cross-harness metrics contract — proposal

Status: **Proposed, not yet accepted or implemented.** 2026-09-17.
Source: tracker `ulu-labs / -uluops-agent-metrics`, `subagent-metrics-audit` run 8,
`c67a674d-7bce-4212-9fd9-a0a3a25143b3`.

## Problem and implementation boundary

The current format conflates a transcript, an execution, and a capture. Codex
usage is cumulative across a transcript; repeated captures can be counted as
different agents; resumed work can carry the first turn's duration with later
tokens. A shared JSON shape also hides different message/error counting units.

The first fix tranche keeps existing public semantics and repairs transport
loss, structured Codex failure detection, last-good-total retention, and
filter-before-limit discovery. It does **not** resolve execution scope or claim
that an unobserved zero is measured. These choices need to be settled before
Gemini CLI or another reader becomes a supported equivalent harness.

## Decision options

Example: an agent consumes 100 tokens on an initial task, then another 50 on a
follow-up. Current session extraction reports 100, then 150. Saving the second
snapshot into a different run repeats the first task's 100 tokens. Proposed turn
observations report executions A=100 and B=50; a separate session view reports
150. Capturing B three times still represents one execution, not three agents.
A tracker run may contain both A and B, but must explicitly attribute each.

Here, a **turn** means one submitted task/follow-up through its completion,
not each internal model response or tool call. A **capture** is a reading of the
transcript at a particular point. Neither a capture nor an internal tool call
creates a new execution. The simpler session-only policy requires a fresh
agent for each tracker run and still needs capture deduplication.

| Decision | Options and tradeoffs | Recommendation |
|---|---|---|
| Measurement boundary | Session snapshots are simple but cannot attribute reused agents to runs. Per-turn observations isolate work but require reliable boundaries. Full event sourcing supports arbitrary ranges at substantially higher storage and implementation cost. | Versioned per-turn observations, plus explicitly labeled session snapshots for inspection. |
| Capture identity | Count every buffer row (current, double counts); overwrite rows in place (loses evidence); append captures and select one observation per execution on read (preserves evidence). | Keep the append-only buffer; deduplicate the execution view used by reconciliation and tracker export. |
| Missing usage | Zero-fill (compatible but misleading); fail all extraction (loses usable timing/tools); nullable counters with observation status (additive migration, honest partial data). | Nullable v2 counters and explicit status; strict tracker export when required usage is missing. |
| Multiple models | First/last scalar (misattributes); reject every mixed session (restrictive); per-model usage segments with an unattributed bucket (more schema work). | Model segments where evidence supports attribution; never guess the model of a cumulative delta spanning model changes. |
| Tracker telemetry | Put everything in analysis JSON (poor filtering, currently lossy); add every field as a column (high migration cost); a small typed execution projection plus versioned opaque JSON (balanced). | Typed execution identity/scope/status and useful aggregate counters; preserve the full observation as versioned JSON. |
| Opaque keys | Recursively normalize everything (current, changes data); special-case key names anywhere (fragile); normalize only declared envelope fields and preserve JSON payload subtrees. | Schema/path-aware boundaries across MCP, CLI, SDK and API, with a contract roundtrip test. |
| Extraction side effects | Always annotate the buffer on named extract (current default, lock/sandbox friction); make all extraction pure immediately (breaking); add an opt-out now and make annotation explicit in v2. | This tranche adds `--no-annotate-buffer`; keep the v1 default and make v2 capture/annotate commands explicit. |

## Proposed observation contract

This is a design sketch, not an export added to `src/types.ts` in this tranche.

```ts
interface MetricsObservationV2 {
  schema_version: 2;
  harness: string;
  transcript_id: string;
  parent_transcript_id: string | null;
  execution_id: string;
  scope: 'turn' | 'session';
  turn_id: string | null;
  state: 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown';
  captured_at: string;
  source: {
    cli_version: string | null;
    extractor_version: string;
    revision: string; // digest of transcript prefix through the observed boundary
    end_offset: number;
  };
  timing: {
    start_time: string | null;
    end_time: string | null;
    wall_duration_ms: number | null;
    active_duration_ms: number | null;
    time_to_first_token_ms: number | null;
    basis: 'provider' | 'timestamps' | 'unknown';
  };
  usage: {
    status: 'observed' | 'partial' | 'unobserved' | 'invalid';
    last_valid_at: string | null;
    stale: boolean;
    // Every token component is a nonnegative integer or null.
    // null means absent/unknown, 0 means explicitly measured zero.
  };
  models: Array<{ model_raw: string; usage: unknown }>;
  unattributed_usage: unknown | null;
  counters: {
    source_record_count: number;
    conversation_message_count: number;
    tool_invocation_count: number;
    failed_tool_invocation_count: number;
    task_failure_count: number;
    tool_breakdown: Record<string, number>;
  };
  warnings: string[];
}
```

The final usage/segment types must enumerate the existing token components;
`unknown` above is a placeholder for that design, not a planned runtime escape
hatch. Raw source totals and derived effective totals remain distinct. Cached
input is included in Codex input; reasoning/thinking/tool output components are
subsets, not additional output. Derived totals are null when a required input is
unknown. An absent component can be structural zero only if the harness adapter
declares it inapplicable; lack of evidence alone cannot justify zero.

## Scope, finality and timing

1. Derive turn identity from stable harness IDs. If absent, use a deterministic
   transcript boundary anchor, not capture time or the agent's display name.
   Use a tuple encoding of harness, transcript identity, scope and boundary to
   derive `execution_id`. Run ownership is a separate attribution relation.
2. For cumulative Codex tokens, use the previous valid cumulative observation
   at the turn boundary as a baseline. A missing baseline in a truncated file
   produces partial usage, never attribution of all lifetime tokens to a turn.
   Counter resets or decreases invalidate that delta and produce a warning.
3. Completion applies only to its identified turn. Follow-up work opens a new
   execution. Session scope is running when any included turn is active; the
   first completion duration must not stand in for resumed lifetime duration.
4. Wall duration includes idle intervals. Active duration is the sum of known
   provider turn durations only when all relevant turns are bounded. Missing
   timing stays null. TTFT is meaningful per turn; a session must label any
   first-turn value rather than imply it belongs to the last turn.
5. A model change does not imply a token boundary. Attribute only deltas with
   unambiguous model evidence. Keep raw model labels; normalization is a
   separate field. Unknown attribution must not feed model-specific cost totals.

## Capture selection and reconciliation

- Preserve each capture in the append-only buffer (ADR-0002). Add capture ID,
  execution ID and source revision to v2 entries. Capturing identical source
  content twice is idempotent in the execution view.
- Select the observation with the greatest validated transcript end offset for
  an execution, not simply the newest capture clock time. A delayed stale
  capture must not replace later evidence. Equal offsets with different source
  revisions are a conflict requiring re-extraction, not silent selection.
- An execution may improve from running to completed. A newer malformed
  observation must retain the last valid counters with `stale: true`, or surface
  a conflict; it cannot silently zero them or look complete.
- Apply run/project filters and use the same execution-selection helper in
  `reconcile` and tracker export. Two captures of A cannot satisfy expected A+B.
  Two executions of one agent definition are distinct even when names match.
- Extend reconciliation to accept an expected execution manifest. Keep
  `--expect N` as a count check, explicitly weaker than identity verification.
  Report captured, distinct, complete, duplicate and conflicting counts.
- Tracker currently groups snapshots by agent name. Preserve individual
  executions in a child collection keyed by execution ID; derive the existing
  per-agent summary only from nonoverlapping executions. Do not send duplicate
  name rows and assume the server retains each execution.
- Do not silently reinterpret old buffer rows as turns. Legacy rows may be
  grouped as session snapshots for display with a warning, but cannot satisfy a
  strict v2 execution manifest without re-extraction.

## Comparable counters

Define a conversation message as a user/assistant message, excluding tool-result
envelopes and reasoning records. Keep source-record counts separately.
Count each transcript-visible tool invocation once by its call ID; code-mode
`exec` is one outer call even if it runs several shell/API operations. Count a
failed outer invocation at most once; maintain task lifecycle failures in a
separate counter. Unknown completion does not mean success.

Preserve raw tool identifiers including namespaces and underscores. Friendly
labels may be derived separately. Never recursively parse stdout looking for
errors: printing a failing example must not make a successful call fail. The
first tranche recognizes structured `exit_code`, `is_error`, `isError` and
`success` signals, including Codex text blocks, without changing legacy counter
units. A counter semantics version is required for mixed-version analytics.

## Tracker storage and opaque payload boundary

Keep existing token fields and add a versioned execution observation relation.
Useful indexed columns: execution ID, parent/transcript ID, harness, scope,
state, usage status, start/end, duration, TTFT, tool invocations and tool failures.
Keep the full observation JSON with a schema version for lossless evidence.
Agent-definition quality scores remain separate from execution telemetry.

The normalization fix must cover `packages/-uluops-ops-mcp`, the CLI, SDK
request serialization and `ops-uluops-api/src/utils/case-transform.ts`. Preserve
`analysis_records[].content`, arbitrary metadata, metric dictionaries and
documented free-form exploration payloads; normalize only their typed enclosing
fields. Enumerate these boundaries against each actual schema before coding.
Test both `send_message` and `sendMessage` in the same payload: they must remain
distinct through preview, save, update and readback. Previously normalized data
cannot be reversed reliably; repair it only from retained original evidence.

## Migration and acceptance

1. Ship the narrow v1 fixes separately. SDK first, then the active published MCP
   package. Validate tarballs through Verdaccio and restart MCP after upgrade;
   a running process will not acquire a new tool schema from a file update.
2. Confirm these recommendations, then add a new ADR alongside ADR-0004 rather
   than editing its accepted attribution semantics in place.
3. Add the versioned extractor API and CLI output opt-in; keep v1 consumers
   working. Add buffer dual-read support and an explicit v2 capture path.
4. Add tracker execution persistence and SDK/MCP contracts before enabling v2
   tracker export. Choose a release boundary for stricter export of partial data.
5. Only then implement Gemini's adapter against the same fixture contract.

Acceptance cases: completed then active follow-up; reused agent across runs;
truncated baseline; token reset; no usage versus explicit zero; malformed last
observation; two models with and without a usage boundary; duplicate and delayed
captures; same agent name with two execution IDs; overlapping scopes rejected
from totals; missing expected execution despite duplicate captures; raw tool
keys surviving all storage paths; outer tool calls distinguished from nested
commands. Each adapter needs recorded, sanitized fixtures from its actual CLI.

## Run 8 issue disposition

| Issue ID | Work in this tranche |
|---|---|
| `0c2f751e-843a-4003-9819-550147b5a71f` | Add four token components to active MCP save/validate/update schemas. |
| `92285805-21b9-4766-80d3-7ace0752b2df` | Add harness to active MCP package. Earlier inspected repo was the legacy client; this is source divergence, not merely a stale build. Live verification pending release/restart. |
| `379d3282-bae8-41b5-9f8e-f5b96ca58030` | Preserve modelRaw in SDK snapshot response parsing. |
| `6fc81134-f613-4198-bfca-d0d7a484578d` | Recognize structured Codex failures, including code-mode text blocks. |
| `1a962895-91ab-4983-8582-5c4552c7c2fc` | Apply project relevance before discovery truncation. |
| `86ddbb1e-3eb0-4d13-acd3-95b54dd02493` | Partial: retain last valid totals. Observation/nullability design remains open. |
| `37aae952-c425-49af-9d4b-627e8f277020` | Proposed turn scope/finality contract above. |
| `94c631b7-9134-43c2-88dd-82ca5a9e7544` | Proposed execution identity and capture-selection contract above. |
| `1de0eb86-235d-4e83-bac5-8c6096db0950` | Proposed model-segment attribution above. |
| `20f328bc-c667-4bc7-b5ac-885166f86cc7` | Proposed counter units and error taxonomy above. |
| `f1de6035-7cfd-4dae-8f21-52717d7f73d0` | Proposed end-to-end opaque JSON boundary above. |

Other operator friction: use transcript UUIDs rather than orchestration task
paths; retain explicit audit target/project separately from inherited cwd;
report extractor and CLI versions in captures; give named extraction a way to
avoid buffer writes. None should be inferred silently from a folder label.
