# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
