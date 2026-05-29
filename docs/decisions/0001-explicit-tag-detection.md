# ADR-0001: Explicit-tag-only agent detection

**Status:** Accepted (2026-05-29)

**Supersedes:** the implicit two-tier detection scheme used in v0.3.x and
earlier, in which a hardcoded `AGENT_PATTERNS` table of 22 regexes
matched bare agent names mentioned anywhere in the first user message.
Also drops the legacy `[validator:name]` tag form (residue of the
March 2026 validator→agent renaming).

## Context

The hook captures one piece of human-readable metadata that the Claude
Code transcript does not provide directly: the *name* of the agent that
ran (e.g. `code-validator`, `aristotle-analyst`). It uses this name in
report grouping, buffer filtering, and tracker save payloads.

Two signals are available in the transcript:

1. **Explicit tags** of the form `[agent:name]` emitted by workflow
   commands. A legacy `[validator:name]` form existed pre–March 2026
   and is no longer recognized.
2. **Free-text mentions** of an agent's name anywhere in the first user
   message — the only signal available when a user invokes an agent
   directly without a workflow command.

When the package was built, the ecosystem had ~22 named agents and the
free-text fallback was reasonable: a small enumerated list of regexes
covered the vocabulary. As of 2026-05-29 the registry contains 189+
agents and continues to grow. The hardcoded list has not been updated
in proportion and now identifies a small fraction of the ecosystem,
while the tracker shows the bulk of detection traffic now comes through
explicit tags emitted by workflows.

Issue **STR-ACC/M (#6, 22 hardcoded AGENT_PATTERNS superseded by
explicit tag system)** flagged this drift. The accidental property is
that the package now *appears* to detect any agent but in fact detects
only those 22 the original author enumerated.

## Decision

`detectAgentName` will return only the value of an explicit
`[agent:name]` tag in the first user message. The legacy
`[validator:name]` form is no longer recognized — workflow commands
have emitted `[agent:...]` since March 2026, and accepting both
preserves the naming-drift the Confucius forecaster flagged at that
migration. The hardcoded `AGENT_PATTERNS` table, the
`matchAgentPattern` function, and the `AgentPattern` type are removed.
Untagged invocations return `null`; the consumer falls back to the
project directory name.

## Alternatives considered

**A. Keep the patterns, document the two-tier as intentional.**
Lowest risk, no behavior change. Rejected because the patterns now
silently misrepresent ecosystem coverage — they imply detection of all
agents while in fact covering ~12%. Maintenance of the list does not
scale with ecosystem growth, and the package has no signal for "what
agents exist."

**B. Replace patterns with a registry fetch at install or runtime.**
Eliminates drift entirely. Rejected for now because the package is
deliberately small and dependency-light (one runtime dep:
`commander`). Adding the registry SDK introduces transitive deps,
network dependence at install or first run, offline-first cache
invalidation, and a coupling between two repos that currently have no
shared lifecycle. May be reconsidered after we observe the impact of
removing patterns.

**C. Generate a static patterns file from the registry at publish time.**
Pre-renders the registry list into the package, no runtime network
dependence. Rejected because it inherits the drift problem at a slower
clock — the patterns file goes stale between releases — and because we
do not yet know whether the missing detection signal matters in
practice. Worth revisiting if (B) is too heavy and the empty-fallback
rate is high.

## Consequences

**Accepted downsides:**

- Direct user invocations without a tag are no longer name-detected.
  Report rows fall back to the project directory name instead of e.g.
  `code-validator`. This degrades the report's per-agent grouping for
  ad-hoc usage.
- The hook produces no visible signal on the missing-detection case;
  consumers cannot distinguish "no tag" from "no agent ran."

**Acquired benefits:**

- The package no longer maintains an enumerated agent list.
  Ecosystem growth no longer creates silent drift.
- `detectAgentName` becomes a pure parse: deterministic, fast, no
  category errors.
- The detection contract is now one line of regex (`EXPLICIT_AGENT_TAG_PATTERN`)
  that workflow authors can target.

**Observable signal we will watch:** the rate at which `report` rows
fall back to the project directory name vs. resolve to an agent name.
If the fallback rate is high and the resulting reports are noticeably
less useful, ADR-0001 is the obvious candidate to revisit — at which
point ADR-0002 alternative (C, static patterns from registry) or
alternative (B, runtime fetch) get serious consideration.

## References

- Issue PRA-FRA — `STR-ACC/M` (`22 hardcoded AGENT_PATTERNS superseded by explicit tag system`)
- Issue PRA-FRA — `STR-INV/I` (`AGENT_PATTERNS classified INTENTIONAL — two-tier detection is deliberate`)
- Version: introduced in v0.4.0
