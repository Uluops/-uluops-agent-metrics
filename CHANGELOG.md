# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-03-08

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
