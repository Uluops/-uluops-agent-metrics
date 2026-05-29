**[UluOps](https://uluops.ai)** · Operating Intelligence as Infrastructure

---

# Agent Metrics

Extract accurate metrics from Claude Code agent session files.

## Overview

Claude Code stores detailed execution data for every agent (Task tool) invocation in JSONL files under `~/.claude/projects/`. This utility extracts and aggregates that data to provide accurate token counts, timing, and execution statistics.

## Prerequisites

- **Node.js 18+** — Required for ESM support
- **Claude Code** — Agent session files are created by Claude Code's Task tool in `~/.claude/projects/`

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
# See what agents ran in the current session
agent-metrics report --current

# See all recent agent metrics
agent-metrics report
agent-metrics report -n 50
```

Output:
```
Recent Agent Metrics
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

Report columns:
- **Agent Name** — auto-detected from `[agent:name]` tags or pattern matching; falls back to project name
- **Cache%** — cache hit rate (`cache_read / (cache_read + cache_creation + input) * 100`)
- Agents from the same conversation turn are **grouped** with a summary header

### Extract Metrics

```bash
# Single agent (JSON)
agent-metrics extract a80e24f
agent-metrics extract a80e24f --json        # --json alias for -f json
agent-metrics extract a80e24f -f summary    # Human-readable

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
```

### List Recent Agent Runs (from disk)

```bash
agent-metrics list
agent-metrics list -n 20
```

## Output Formats

### JSON (default)

Complete metrics object:

```json
{
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

### Summary Format

```
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

## Token Calculations

| Metric | Calculation | Use Case |
|--------|-------------|----------|
| `total_effective` | `input + cache_creation + output` | Billing approximation |
| `total_raw` | All tokens summed | True total processed |

**Note:** Cache reads are excluded from `total_effective` because they're significantly cheaper than other token types.

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

// Extract by agent ID (searches all projects)
const metrics = await extractAgentMetrics('a80e24f');
if (metrics) {
  console.log(`Duration: ${metrics.duration_formatted}`);
  console.log(`Tokens: ${metrics.tokens.total_effective}`);
}

// Extract from a specific file path
const metricsFromFile = await extractMetricsFromFile('/path/to/agent-abc123.jsonl');

// Extract multiple agents at once
const multipleMetrics = await extractMultipleAgentMetrics(['a80e24f', 'b91f35g']);

// Format as human-readable summary
const summary = formatMetricsSummary(metrics);
console.log(summary);

// Convert to validation tracker format
const trackerData = toTrackerFormat(metrics, 'code-validator');
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
  getClaudeProjectsDir,
  sanitizePathAsFolderName,
  getProjectName,
  extractAgentIdFromFilename,
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

// Path utilities — work with Claude Code's project directory conventions
const projectsDir = getClaudeProjectsDir();           // ~/.claude/projects
const folder = sanitizePathAsFolderName('/Users/me/myproject'); // "-Users-me-myproject"
const name = getProjectName('/path/to/-Users-me-myproject');    // "myproject"

// Agent ID extraction from filenames
const id = extractAgentIdFromFilename('agent-a80e24f.jsonl'); // "a80e24f"

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
  { model: 'claude-sonnet-4-5', duration_ms: 5000, tokens: {...}, execution: {...} },
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
```
~/.claude/projects/{project-folder}/{session-uuid}/subagents/agent-{id}.jsonl
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
| `report [-n limit] [-s session] [--current]` | Show recent auto-captured metrics in table format |
| `list [-n <limit>]` | List recent agent runs from session files |
| `extract <ids...> [-f format] [--json] [-a agent-name] [--agent-names names]` | Extract metrics for one or more agents |
| `compare <id...>` | Compare multiple agents side-by-side |
| `find <id>` | Find the file location for an agent |
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
```
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
5. Buffer entries expire after 24 hours (configurable)

### Setup

Add the hook to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SubagentStop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node ~/.claude/tools/agent-metrics/dist/hook.js",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

### Agent Detection

The hook auto-detects agent names from the task prompt:
- `code-validator`, `test-architect`, `security-analyst`
- `type-safety-validator`, `frontend-validator`, `public-interface-validator`
- `api-contract-validator`, `mcp-validator`, `adl-meta-validator`
- `code-optimizer`, `data-science`, `ml-algorithms`
- And 20+ more agents

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
    "model": "claude-sonnet-4-5-20250929",
    "tokens": { "input_tokens": 63903, "output_tokens": 1510, "cache_creation_tokens": 63236, "cache_read_tokens": 315202, "total_effective_tokens": 65413 },
    "duration_ms": 113126
  },
  {
    "name": "test-architect",
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

The install script copies the tool to `~/.claude/tools/agent-metrics` for persistence across projects. If you reinstall Node.js or clear npm links, you can restore the global command:

```bash
cd ~/.claude/tools/agent-metrics
npm link
```

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
