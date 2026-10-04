# Mutation pass — definition capture (v0.12.0, dvc checklist X4-1, X4-2, X4-4, X4-5)

Each control below was run against the defect it names: the source was mutated, `npm test` was run, and the source was restored. Every mutation must fail at least one named test. The harness is `scripts/`-free and lives in the session scratchpad; these mutations are one-line edits applied and reverted in place, not branches.

Baseline: `npm test` 454/454; `check:readme-exports` and `check:pack` OK.

| Control | Defect | Fails |
|---|---|---|
| X4-1 changed during run | a reinstall between spawn and stop is not detected (stop-time-read semantics) | `reinstalled between spawn and stop → omitted`, plus the hook-level `changed-during-run` case |
| X4-1 reload window | no guard for a file modified inside Claude Code's reload lag | `modified 5 s before spawn → omitted` |
| X4-1 never guess (ambiguity) | same-level files at different versions resolved by first match | `two same-level files at different versions are ambiguous` |
| X4-1 never guess (no version) | a missing frontmatter version defaulted to `0.0.0` | `no version in frontmatter → omitted` |
| X4-1 what ran, not what was tagged | an `[agent:]` tag naming another definition is ignored | `an [agent:] tag naming another definition → omitted, tag-mismatch` |
| X4-2 own name only | the version is emitted under any reported name | `a version is emitted only under its own name` |
| X4-4 spill, not skip | a contended write is dropped (the pre-0.12 behaviour) | `should fail closed … when lock cannot be acquired`; `should NOT remove lock that is less than 30 seconds old` |

## Tracker 74629040 (folded into 0.12.0): undercount and duplicate entries

| Control | Defect | Fails |
|---|---|---|
| stability wait | the hook reads the transcript without waiting (pre-fix) | `a final message flushed during the wait is counted` |
| refresh coverage guard | `buffer list -f tracker` replaces metrics even from a transcript that ends earlier | `keeps the buffer metrics when the transcript ends earlier` |
| one entry per agent | `readBuffer` returns every capture of a re-woken agent | `two appends for one agent read back as one, the later` |

Live, 2026-10-04: before the fix, 3 of 4 hook captures undercounted output tokens 6–10×, and a re-woken agent appeared twice in tracker output. After it, 3 of 3 raw captures matched `extract`, and the previously duplicated agent reads back once with its complete run (523 tokens).

**Not covered by a mutation:** the X4-5 counters (asserted exactly by `capture counters (X4-5)`), and the live Claude Code hook payload. SubagentStart's `agent_id`/`agent_type` are documented (code.claude.com `hooks`), but verifying them takes a real run after the hook is configured. The rollout plan's live check covers that.

## X4 review fixes (2026-10-04)

Fixes from the post-implementation crew (code-auditor, anxiety-reader, test-architect,
public-interface, release-readiness). Each fix was reverted in place and the targeted suites re-run
(`hook-definition`, `definition`, `hook.e2e`, `commands/core`, `undercount`, `buffer`); source
restored after each.

| # | Mutation | Caught |
|---|---|---|
| M1 | `newlineGuard` never adds a newline | yes — partial-last-line drain test |
| M2 | no `drainSpill` before `removeWhere` | yes — clearAgents-on-spilled test |
| M3 | F1: stop-time read accepted unconditionally | yes — unverified-at-stop test |
| M4 | F1 boundary `>=` → `>` | yes — exact-boundary test |
| M5 | spawn shape check accepts any definition object | yes — malformed-spawn test (first attempt did not compile; redone as a conjunction removal) |
| M6 | capture catch rethrows | yes — capture-error test |
| M7 | no 50-char cap | yes — over-long version test |
| M8 | `main()` SubagentStart falls through to the stop path | yes — `hook.e2e` (was untested; test-architect) |
| M9 | `extract` passes `undefined` for the version | yes — core extract wiring test (was untested; test-architect) |
| M10 | same-version duplicates carry the first match's mtime | yes — newest-mtime test |
| M11 | readers include `.claimed` files | yes — stranded-claim test |
