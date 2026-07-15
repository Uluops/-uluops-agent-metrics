**[UluOps](https://uluops.ai)** · Operating Intelligence as Infrastructure

---

# Agent Metrics

Extract accurate, normalized metrics from agent session files across coding harnesses.

## Overview

Coding harnesses each record detailed execution data for every agent invocation, in their own on-disk format. This utility reads those formats and normalizes them into one shape — accurate token counts, timing, and execution statistics — so metrics are comparable across harnesses regardless of which one produced them. Each record carries a `harness` field identifying its origin.

**Supported harnesses:**

- **Claude Code** — agent (Task tool) session files under `~/.claude/projects/`
- **Codex** — subagent session rollouts under `~/.codex/sessions/` (or `$CODEX_HOME/sessions/`)
- **Planned** — Gemini CLI and OpenCode. The extractor architecture is harness-agnostic (a per-harness reader feeding a shared normalizer), so adding a harness does not change the public output shape.

Harness selection is per-command via `--provider auto|claude|codex` (default `auto` detects the harness from the agent ID). The normalized output and the tracker wire format are identical across harnesses; harness-specific token components (e.g. Codex `cached_input`, `reasoning_output`) are carried as additive optional fields.

## Prerequisites

- **Node.js 18+** — Required for ESM support
- **At least one supported harness:**
  - **Claude Code** — agent session files in `~/.claude/projects/`
  - **Codex** — optional; subagent rollouts in `~/.codex/sessions/` or `$CODEX_HOME/sessions/`

## Installation

### Via npm (Recommended)

```bash
npm install -g @uluops/agent-metrics
```

The `agent-metrics` command is now available globally:

```bash
agent-metrics --version
agent-metrics list
```

### Via UluOps Setup

If you use [`@uluops/setup`](https://www.npmjs.com/package/@uluops/setup), agent-metrics is installed automatically with the SubagentStop hook pre-configured:

```bash
npx @uluops/setup
```

### From Source

```bash
git clone https://github.com/Uluops/-uluops-agent-metrics.git
cd -uluops-agent-metrics
npm install
npm run build
npm link
```

### As a Project Dependency

```bash
npm install @uluops/agent-metrics
```

```typescript
import { extractAgentMetrics, queryBuffer } from '@uluops/agent-metrics';
```

### Uninstall

```bash
npm uninstall -g @uluops/agent-metrics
```

## Usage

### Quick Start

```bash
# List recent Claude Code agent session files
agent-metrics list

# List recent Codex subagent rollouts
agent-metrics list --provider codex

# Extract metrics for a run from the list
agent-metrics extract a80e24f -f summary

# Show buffered hook captures after SubagentStop auto-capture is configured
agent-metrics report --current
```

Output:
```text
Recent Agent Runs
══════════════════════════════════════════════════════════════════════════════════════════════════════════════

Agent ID            │  Agent Name              │  Model      │  Duration  │  Tokens   │  Cache  │  Tools
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ┌ ops-uluops-api (3 agents, 17m total, 585k tokens)
  │ a77373c5debd07e95  │  type-safety-validator    │  sonnet-4-6  │   3m 9s    │  155k     │   93%  │     44
  │ a02cd0561f2543ed0  │  test-architect           │  sonnet-4-6  │   6m 4s    │  268k     │   93%  │     46
  │ aa926931b1d22ba2b  │  public-interface          │  sonnet-4-6  │   8m 42s   │  162k     │   95%  │     58
  └
a5511f269fb53e254    │  code-auditor              │  opus-4-6    │   3m 2s    │  466k     │   88%  │     46
```

List and report columns:
- **Agent Name** — auto-detected from `[agent:name]` tags; falls back to project name
- **Cache%** — cache hit rate (`cache_read / (cache_read + cache_creation + input) * 100`)
- Agents from the same conversation turn are **grouped** with a summary header

### Extract Metrics

```bash
# Single agent (JSON)
agent-metrics extract a80e24f
agent-metrics extract a80e24f --json        # --json alias for -f json
agent-metrics extract a80e24f -f summary    # Human-readable

# Codex subagent by UUIDv7 id
agent-metrics extract 019eaa28-8e2d-73a2-840f-a00d6cc8795f --provider codex

# Multiple agents (batch) — outputs JSON array
agent-metrics extract a7c642b a03c37d af0c1a1

# Tracker-ready format (for mcp__uluops-tracker__update_run)
agent-metrics extract a7c642b -f tracker --agent-name code-validator

# Batch tracker format with named mapping
agent-metrics extract a7c642b a03c37d af0c1a1 \
    -f tracker \
    --agent-names "code-validator,test-architect,security-analyst"
```

### Compare Multiple Agents

```bash
agent-metrics compare a5b1804 ac51171 a0a96d3 a80e24f
```

### Find Agent File Location

```bash
agent-metrics find a80e24f
agent-metrics find 019eaa28-8e2d-73a2-840f-a00d6cc8795f --provider codex
```

### List Recent Agent Runs (from disk)

```bash
agent-metrics list
agent-metrics list -n 20
agent-metrics list --provider codex
```

Provider defaults to `auto`: UUIDv7 agent ids route to Codex, and Claude-style hex ids route to Claude. `report` remains Claude-buffer-backed in this release; use `list --provider codex` and `extract <id> --provider codex` for Codex runs.

## Output Formats

### JSON (default)

Complete metrics object:

```json
{
  "harness": "claude-code",
  "agent_id": "a80e24f",
  "session_id": "ea588859-88cd-4511-851a-4fe928cd77c7",
  "slug": "humble-forging-pony",
  "model": "claude-sonnet-4-5-20250929",
  "git_branch": "main",
  "cwd": "/home/user/project",
  "claude_code_version": "2.0.76",
  "prompt_id": "31853822-649f-45aa-a7ae-0027726335c5",
  "start_time": "2026-01-07T20:07:03.733Z",
  "end_time": "2026-01-07T20:08:56.859Z",
  "duration_ms": 113126,
  "duration_formatted": "1m 53s",
  "tokens": {
    "input": 667,
    "output": 1510,
    "cache_creation": 63236,
    "cache_read": 315202,
    "total_effective": 65413,
    "total_raw": 380615
  },
  "execution": {
    "message_count": 30,
    "tool_use_count": 13,
    "tool_breakdown": { "Bash": 12, "Read": 1 },
    "error_count": 0
  }
}
```

Codex metrics use the same top-level shape with `harness: "codex"` and Codex-specific additive fields such as `codex_cli_version`, `parent_thread_id`, `tokens.cached_input`, `tokens.reasoning_output`, and `execution.reasoning_record_count`.

> **v0.6.0:** the top-level metrics field was renamed `provider` → `harness` (values `claude` → `claude-code`; `codex` unchanged). The `--provider` *CLI option* is the unrelated dispatch selector and is unchanged. `tokens` also gained optional `thinking` / `tool` components (subsets of gross output, populated by future providers), and the record carries `harness` through to the tracker wire.

### Summary Format

```text
Agent Metrics: a80e24f
══════════════════════════════════════════════════════

┌─ Identification
│  Agent ID:    a80e24f
│  Session:     ea588859-88c...
│  Slug:        humble-forging-pony

┌─ Context
│  Model:       claude-sonnet-4-5-20250929
│  Branch:      main
│  Version:     2.0.76

┌─ Timing
│  Start:       2026-01-07T20:07:03.733Z
│  End:         2026-01-07T20:08:56.859Z
│  Duration:    1m 53s (113,126ms)

┌─ Tokens
│  Input:       667
│  Output:      1,510
│  Cache Create:63,236
│  Cache Read:  315,202
│  ─────────────
│  Effective:   65,413 (excl. cache reads)
│  Raw Total:   380,615

┌─ Execution
│  Messages:    30
│  Tool Uses:   13
│  Errors:      0

┌─ Tool Breakdown
│  Bash: 12
│  Read: 1
```

### Tracker Format

Ready for `save_run`:

```json
{
  "name": "prompt-quality-validator",
  "agent_id": "a80e24f1c2d3e4f5a",
  "model": "claude-sonnet-4-5-20250929",
  "tokens": {
    "input_tokens": 63903,
    "output_tokens": 1510,
    "cache_creation_tokens": 63236,
    "cache_read_tokens": 315202,
    "total_effective_tokens": 65413
  },
  "duration_ms": 113126
}
```

`agent_id` (v0.7.0) is the transcript/agent provenance id — it makes the saved
tracker row joinable back to its buffer entry and session transcript.

## Token Calculations

| Metric | Claude calculation | Codex calculation | Use Case |
|--------|--------------------|-------------------|----------|
| `total_effective` | `input + cache_creation + output` | `(input - cached_input) + output` | Provider-local tracker parity |
| `total_raw` | All tokens summed | Codex-reported `total_tokens` | True total processed |

**Note:** Cache reads are excluded from Claude `total_effective` because they're significantly cheaper than other token types. Codex cached input is likewise subtracted (the analog of Claude's excluded cache read). `reasoning_output` (and `thinking`/`tool`) are **subsets of gross `output`** — stored for cost breakdown but **never added** to `total_effective` (v0.6.0 removed the prior `+ reasoning_output` double-count). OpenAI cached input is discounted rather than free, so cross-provider cost rollups should re-price from raw provider token fields.

**Edge cases:**
- When `cache_creation` is 0 (no new context cached), `total_effective` equals `input + output`
- When `input` is 0 (all input served from cache), `total_effective` equals `cache_creation + output`
- For very short agents (single turn), `cache_read` is typically 0 since there's no prior context to read from cache

## Programmatic Usage

```bash
npm install @uluops/agent-metrics
```

### Core Extraction Functions

```typescript
import {
  extractAgentMetrics,
  extractMetricsFromFile,
  extractMultipleAgentMetrics,
  formatMetricsSummary,
  toTrackerFormat,
} from '@uluops/agent-metrics';

async function main() {
  // Extract by agent ID (searches all projects)
  const metrics = await extractAgentMetrics('a80e24f');
  if (!metrics) {
    throw new Error('Agent metrics not found');
  }

  console.log(`Duration: ${metrics.duration_formatted}`);
  console.log(`Tokens: ${metrics.tokens.total_effective}`);

  // Extract a Codex subagent by UUIDv7 id
  const codexMetrics = await extractAgentMetrics(
    '019eaa28-8e2d-73a2-840f-a00d6cc8795f',
    { provider: 'codex' }
  );

  // Auto mode routes UUIDv7 ids to Codex and Claude-style hex ids to Claude
  const autoMetrics = await extractAgentMetrics('019eaa28-8e2d-73a2-840f-a00d6cc8795f');

  // Extract from a specific file path
  const metricsFromFile = await extractMetricsFromFile('/path/to/agent-abc123.jsonl');

  // Extract multiple agents at once
  const multipleMetrics = await extractMultipleAgentMetrics(['a80e24f', 'b91f35g']);

  // Format as human-readable summary
  const summary = formatMetricsSummary(metrics);
  console.log(summary);

  // Convert to validation tracker format
  const trackerData = toTrackerFormat(metrics, 'code-validator');
}

main().catch((error) => {
  console.error(error);
});
```

### Buffer Functions

```typescript
import {
  queryBuffer,
  getAllForSession,
  getLatestForSession,
  getBufferStats,
  appendToBuffer,
  clearSession,
  clearAgents,
  cleanupExpired,
  readBuffer,
  readValidEntries,
  entriesToTrackerFormat,
} from '@uluops/agent-metrics';

// Query buffer with filters
const entries = queryBuffer({
  sessionId: 'ea588859-88cd-4511-851a-4fe928cd77c7',
  agentName: 'code-validator',
  since: new Date(Date.now() - 3600000), // Last hour
  includeExpired: false,
});

// Get all entries for a session (useful for workflows)
const sessionEntries = getAllForSession('ea588859-...');

// Get most recent entry for a session
const latest = getLatestForSession('ea588859-...');

// Get buffer statistics
const stats = getBufferStats();
console.log(`Total entries: ${stats.totalEntries}`);
console.log(`Valid entries: ${stats.validEntries}`);

// Read all entries (including expired) - low-level access
const allEntries = readBuffer();

// Read only valid (non-expired) entries
const validEntries = readValidEntries();

// Convert entries to tracker-compatible format
const trackerData = entriesToTrackerFormat(validEntries);

// Cleanup operations
const expiredCount = cleanupExpired();
const clearedCount = clearSession('ea588859-...');
```

### Utility Functions

```typescript
import {
  findAgentFile,
  findRecentAgentFiles,
  findCodexAgentFile,
  findRecentCodexAgentFiles,
  getClaudeProjectsDir,
  getCodexSessionsDir,
  sanitizePathAsFolderName,
  getProjectName,
  extractAgentIdFromFilename,
  extractCodexAgentIdFromFilename,
  parseTimestamp,
  calculateDuration,
  formatDuration,
  formatTokens,
  formatNumber,
  formatModelName,
} from '@uluops/agent-metrics';

// Find agent file location (searches flat and session/subagents layouts)
const location = findAgentFile('a80e24f');
if (location) {
  console.log(`Path: ${location.filePath}`);
  console.log(`Project: ${location.projectDir}`);
}

// Find recent agent files across all projects
const recentFiles = await findRecentAgentFiles(20); // Last 20
const recentCodexFiles = await findRecentCodexAgentFiles(20);

// Find Codex rollout file location
const codexLocation = await findCodexAgentFile('019eaa28-8e2d-73a2-840f-a00d6cc8795f');

// Path utilities
const projectsDir = getClaudeProjectsDir();           // ~/.claude/projects
const sessionsDir = getCodexSessionsDir();            // ~/.codex/sessions or $CODEX_HOME/sessions
const folder = sanitizePathAsFolderName('/Users/me/myproject'); // "-Users-me-myproject"
const name = getProjectName('/path/to/-Users-me-myproject');    // "myproject"

// Agent ID extraction from filenames
const id = extractAgentIdFromFilename('agent-a80e24f.jsonl'); // "a80e24f"
const codexId = extractCodexAgentIdFromFilename(
  'rollout-2026-06-27T03-00-00-000Z-019eaa28-8e2d-73a2-840f-a00d6cc8795f.jsonl'
);

// Timestamp utilities
const date = parseTimestamp('2026-03-29T06:21:53.455Z'); // Date object
const durationMs = calculateDuration(
  '2026-03-29T06:21:53.455Z',
  '2026-03-29T06:25:12.000Z'
); // 198545

// Formatting utilities
console.log(formatDuration(113126));   // "1m 53s"
console.log(formatTokens(65413));      // "65.4k"
console.log(formatNumber(1234567));    // "1,234,567"
console.log(formatModelName('claude-sonnet-4-5-20250929', 12)); // "sonnet-4-5"
```

### Logger Functions

```typescript
import {
  configureLogger,
  getLoggerConfig,
  readRecentLogs,
  getLogStats,
  logDebug,
  logInfo,
  logWarn,
  logError,
  logMetricsCapture,
  logBufferOperation,
} from '@uluops/agent-metrics';

// Configure logger
configureLogger({
  enabled: true,
  minLevel: 'info',
  logPath: '/custom/path/metrics.log',
});

// Get current config
const config = getLoggerConfig();

// Read recent log entries
const lines = readRecentLogs(50);

// Get log file stats
const logStats = getLogStats();
console.log(`File size: ${logStats.sizeBytes}`);
console.log(`Line count: ${logStats.lineCount}`);

// Log messages (if logging enabled)
logInfo('Processing agent metrics');
logDebug('Detailed debug info');
logWarn('Warning message');
logError('Error occurred');

// Structured logging for metrics operations
logMetricsCapture(
  'agent-abc123',
  'session-xyz',
  {
    model: 'claude-sonnet-4-5',
    duration_ms: 5000,
    tokens: {
      input: 1000,
      output: 250,
      cache_creation: 0,
      cache_read: 0,
      total_effective: 1250,
      total_raw: 1250,
    },
    execution: {
      message_count: 4,
      tool_use_count: 1,
      tool_breakdown: { Read: 1 },
      error_count: 0,
    },
  },
  { agentName: 'code-validator', source: 'hook' }
);
logBufferOperation('append', { agent_id: 'abc123', buffer_path: '/path/to/buffer' });
```

### Types

```typescript
import type {
  // Core metrics types
  AgentMetrics,
  TokenMetrics,
  ExecutionMetrics,
  ExtractOptions,
  MetricsProvider,
  AgentFileLocation,
  // Tracker format types
  TrackerTokens,
  TrackerFormat,
  TrackerAgentFormat,
  // Buffer types
  BufferEntry,
  BufferConfig,
  BufferStats,
  // Format types
  ExtractFormat,
  BufferFormat,
  // Logger types
  LogLevel,
  LoggerConfig,
  LogStats,
} from '@uluops/agent-metrics';
```

## Data Source

Agent session files are stored at:
```text
~/.claude/projects/{project-folder}/{session-uuid}/subagents/agent-{id}.jsonl
```

Codex subagent rollout files are stored at:

```text
~/.codex/sessions/YYYY/MM/DD/rollout-{timestamp}-{uuidv7}.jsonl
```

Each JSONL file contains all messages from an agent invocation, including:
- User prompts
- Assistant responses with token usage
- Tool invocations and results
- Timestamps for each message

## Commands Reference

### Core Commands

| Command | Description |
|---------|-------------|
| `status` | Show buffer statistics (alias for `buffer status`) |
| `report [-n limit] [-s session] [--current] [--provider auto|claude|codex]` | Show recent Claude-buffer auto-captured metrics; `codex` exits with guidance because report is buffer-backed |
| `list [-n <limit>] [-p project] [--provider auto|claude|codex]` | List recent agent runs from session files |
| `extract <ids...> [-f format] [--json] [-a agent-name] [--agent-names names] [--provider auto|claude|codex]` | Extract metrics for one or more agents |
| `compare <id...> [-p project] [--provider auto|claude|codex]` | Compare multiple agents side-by-side (`auto` resolves each id's harness independently, so a mixed Claude+Codex comparison works) |
| `find <id> [-p project] [--provider auto|claude|codex]` | Find the file location for an agent |
| `examples` | Show usage examples for common workflows |

### Buffer Commands

| Command | Description |
|---------|-------------|
| `buffer status` | Show buffer statistics |
| `buffer list [-s session] [--agent-name name] [--since duration] [--end-after iso] [--end-before iso] [-p project] [-a] [-f format]` | List buffered entries |
| `buffer session <id> [-f format]` | Get all entries for a session |
| `buffer clear --session <id>` | Clear entries for a session |
| `buffer clear --agents <id...>` | Clear specific agent IDs |
| `buffer clear --expired` | Clear only expired entries (garbage collect) |

### Log Commands

| Command | Description |
|---------|-------------|
| `log status` | Show log file statistics |
| `log tail [-n lines] [-f]` | View recent log entries (supports follow mode) |
| `log clear [--all]` | Clear log file (--all removes rotated files) |
| `log path` | Print log file path (useful for scripting) |

## Log Management

The hook logs all operations for debugging and auditing.

### View Log Status

```bash
agent-metrics log status
```

Output:
```text
Agent Metrics Log Status
══════════════════════════════════════════════════
Log file:          /home/user/.claude/agent-metrics.log
Logging enabled:   true
Min level:         info
Max file size:     5.0 MB
Max rotated files: 3

File exists:       true
File size:         12.4 KB
Line count:        156
Rotated files:     0
```

### View Recent Logs

```bash
# Show last 20 lines
agent-metrics log tail

# Show last 50 lines
agent-metrics log tail -n 50

# Follow log in real-time (like tail -f)
agent-metrics log tail -f
```

### Clear Logs

```bash
# Clear current log file
agent-metrics log clear

# Clear all logs including rotated files
agent-metrics log clear --all
```

## Auto-Capture with SubagentStop Hook

The agent-metrics hook automatically captures metrics when any Task tool agent completes. This enables accurate token tracking across validation workflows.

### How It Works

1. When a Task tool agent finishes, Claude Code fires a `SubagentStop` hook
2. The hook receives the agent's transcript path (`~/.claude/projects/.../agent-{id}.jsonl`)
3. agent-metrics extracts tokens, timing, and execution stats from the transcript
4. Metrics are written to a global buffer (`~/.claude/agent-metrics-buffer.jsonl`)
5. Buffer entries expire after 30 days (configurable), aligned with Claude Code
   transcript retention; expired entries are garbage-collected opportunistically
   on the next append (v0.7.0 — expiry is enforced, not a passive label)

> **BREAKING (v0.7.0):** buffer-rewrite operations are fail-closed. When the
> buffer lock cannot be acquired, `cleanupExpired`, `clearSession`,
> `clearAgents`, and `annotateBufferEntries` now throw `LockAcquisitionError`
> (exported) instead of proceeding unlocked — an unlocked read-modify-rewrite
> could silently destroy concurrently-captured entries. Catch it to retry or
> skip: `catch (e) { if (e instanceof LockAcquisitionError) ... }`. The
> `buffer clear` CLI reports a clean locked-buffer message; hook capture
> (`appendToBuffer`) is unchanged — it was already fail-closed.

### Setup

`@uluops/setup` configures this hook automatically. For a manual global npm
install, first locate the package root:

```bash
npm root -g
```

Then add the hook to `~/.claude/settings.json` with the matching absolute path:

```json
{
  "hooks": {
    "SubagentStop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /opt/homebrew/lib/node_modules/@uluops/agent-metrics/dist/hook.js",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

### Agent Detection

The hook detects the agent name from an explicit tag in the first user
message of the transcript:

```text
[agent:code-validator] Validate code quality on this directory
```

Tag matching is case-insensitive; the resulting name is lowercased.

Name resolution precedence (v0.7.0): explicit `[agent:name]` tag → the
harness-reported `agent_type` field on the hook payload (when the Claude Code
version delivers it — the hook debug-logs payload key names, so presence is
observable per capture) → nameless. Nameless entries display with the project
directory name, then the agent id. Workflow commands emit tags automatically;
direct user invocations can include a tag manually. The `agent_type` fallback is
sanitized before persistence (control characters stripped, capped at 64 chars,
v0.7.1): a stray newline would otherwise split a JSONL buffer line and silently
drop the entry on read.

Names supplied later at extract time (`extract --agent-name/--agent-names`)
are written back onto the matching buffer entries (best-effort), so earlier
nameless captures become name-complete for subsequent queries.

See `docs/decisions/0001-explicit-tag-detection.md` for the rationale
(hardcoded name enumeration was removed in v0.4.0).

### Buffer Commands

```bash
# Check buffer status
agent-metrics buffer status

# List all buffered entries
agent-metrics buffer list

# Filter by agent name
agent-metrics buffer list --agent-name code-validator

# Get all entries for a session (useful for workflows)
agent-metrics buffer session <session-id>

# Output in tracker format for save_run
agent-metrics buffer session <session-id> --format tracker

# Clean up expired entries
agent-metrics buffer clear --expired
```

### Workflow Integration

After running a multi-agent workflow:

```bash
# Get session ID from parent conversation
SESSION_ID="ea588859-88cd-4511-851a-4fe928cd77c7"

# Get all agents' metrics in tracker format
agent-metrics buffer session $SESSION_ID --format tracker
```

Output ready for `save_run`:

```json
[
  {
    "name": "code-validator",
    "agent_id": "a80e24f1c2d3e4f5a",
    "model": "claude-sonnet-4-5-20250929",
    "tokens": { "input_tokens": 63903, "output_tokens": 1510, "cache_creation_tokens": 63236, "cache_read_tokens": 315202, "total_effective_tokens": 65413 },
    "duration_ms": 113126
  },
  {
    "name": "test-architect",
    "agent_id": "ab1c2d3e4f5a6b7c8",
    "model": "claude-sonnet-4-5-20250929",
    "tokens": { "input_tokens": 45200, "output_tokens": 980, "cache_creation_tokens": 44220, "cache_read_tokens": 210000, "total_effective_tokens": 46400 },
    "duration_ms": 87500
  }
]
```

## Manual Integration with Validation Workflows

After running a validation agent:

```bash
# Get the agent ID from the Task tool response
AGENT_ID="a80e24f"

# Extract metrics in tracker format
METRICS=$(agent-metrics extract $AGENT_ID --format tracker --agent-name code-validator)

# Use in save_run call
echo $METRICS
```

## Persistence

Global npm installs persist through the npm global prefix. If `agent-metrics`
is no longer on `PATH` after reinstalling Node.js or changing package managers,
reinstall the package:

```bash
npm install -g @uluops/agent-metrics
```

If you use `@uluops/setup`, rerun `npx @uluops/setup` to recreate its managed
Claude hook files.

## Future Enhancements

- [x] Global installation via npm link
- [x] Auto-capture via SubagentStop hook
- [x] Global buffer with TTL-based expiry
- [x] Agent name auto-detection in report
- [x] Cache hit rate visibility
- [x] Batch extract with tracker-ready output
- [x] Workflow grouping by prompt_id
- [x] npm publish for `npm install -g @uluops/agent-metrics`
- [ ] Redis backend for distributed buffer *(Planned — no timeline)*
- [ ] MCP server integration *(Planned — no timeline)*
- [ ] Historical trend analysis *(Planned — no timeline)*
- [ ] Cost estimation based on token pricing *(Planned — no timeline)*
