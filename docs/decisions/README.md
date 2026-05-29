# Architectural Decision Records

This directory captures the load-bearing design decisions in
`@uluops/agent-metrics`. Each record names a decision, the alternatives
considered, the rationale, and the consequences accepted.

## Format

Each ADR follows a minimal Michael Nygard structure:

- **Status** — Accepted / Deprecated / Superseded by N
- **Context** — what forced the decision
- **Decision** — what was chosen
- **Alternatives considered** — what was rejected and why
- **Consequences** — what this commits us to, including downsides

Records are numbered, immutable once accepted, and never deleted.
Reversing a decision means writing a new ADR that supersedes the old one
and updating the old one's status.

## Index

- [0001 — Explicit-tag-only agent detection](0001-explicit-tag-detection.md)
- [0002 — JSONL append-only buffer format](0002-jsonl-buffer-format.md)
- [0003 — Atomic file-system lock for buffer writes](0003-atomic-sync-lock.md)
