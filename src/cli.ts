#!/usr/bin/env node

/**
 * Agent Metrics CLI
 *
 * Command-line interface setup and entry point.
 * Registers all command groups and parses arguments.
 */

import { createRequire } from 'node:module';
import { Command } from 'commander';
import { registerCoreCommands } from './commands/core.js';
import { registerStatusCommands } from './commands/status.js';
import { registerBufferCommands } from './commands/buffer.js';
import { registerLogCommands } from './commands/log.js';

const require = createRequire(import.meta.url);
const pkg: unknown = require('../package.json');
const version = (pkg && typeof pkg === 'object' && 'version' in pkg && typeof (pkg as Record<string, unknown>).version === 'string')
  ? (pkg as { version: string }).version
  : '0.0.0';

const program = new Command();

program
  .name('agent-metrics')
  .description('Extract accurate metrics from Claude Code agent session files')
  .version(version);

// Register all command groups
registerCoreCommands(program);
registerStatusCommands(program);
registerBufferCommands(program);
registerLogCommands(program);

// Examples command
program
  .command('examples')
  .description('Show usage examples for common workflows')
  .action(() => {
    console.log(`
Agent Metrics - Usage Examples
══════════════════════════════════════════════════════════════════════════════

QUICK START
──────────────────────────────────────────────────────────────────────────────

  See what agents ran recently (current session):
    $ agent-metrics report --current

  See all recent agent metrics:
    $ agent-metrics report
    $ agent-metrics report -n 50


EXTRACT METRICS
──────────────────────────────────────────────────────────────────────────────

  Single agent (JSON output):
    $ agent-metrics extract a7c642b
    $ agent-metrics extract a7c642b --json
    $ agent-metrics extract a7c642b -f summary

  Multiple agents (batch):
    $ agent-metrics extract a7c642b a03c37d af0c1a1
    $ agent-metrics extract a7c642b a03c37d -f summary

  Tracker-ready format (for mcp__uluops-tracker__update_run):
    $ agent-metrics extract a7c642b -f tracker --agent-name code-validator
    $ agent-metrics extract a7c642b a03c37d af0c1a1 \\
        -f tracker \\
        --agent-names "code-validator,test-architect,security-analyst"

  Output from tracker format can be copied directly into update_run:
    {
      "name": "code-validator",
      "model": "claude-sonnet-4-6",
      "tokens": {
        "input_tokens": 221,
        "output_tokens": 13342,
        "cache_creation_tokens": 122942,
        "cache_read_tokens": 2992249,
        "total_effective_tokens": 136505
      },
      "duration_ms": 650777
    }


COMPARE AGENTS
──────────────────────────────────────────────────────────────────────────────

  Side-by-side comparison table:
    $ agent-metrics compare a7c642b a03c37d af0c1a1

  Find agent file location:
    $ agent-metrics find a7c642b

  List recent runs from disk:
    $ agent-metrics list
    $ agent-metrics list --limit 20


REPORT COLUMNS
──────────────────────────────────────────────────────────────────────────────

  The report table shows:
    Agent ID     — Unique identifier for each agent run
    Agent Name   — Auto-detected from [agent:name] tags or pattern matching
    Model        — sonnet-4-6, opus-4-6, haiku-4-5
    Duration     — Wall clock time
    Tokens       — Effective tokens (input + cache_creation + output)
    Cache        — Cache hit rate (cache_read / total * 100)
    Tools        — Number of tool calls made

  Agent names are detected automatically via:
    1. Explicit tag in prompt: [agent:code-validator] (highest priority)
    2. Pattern matching against known agent names (fallback)
    3. Project directory name (final fallback)


BUFFER & FILTERING
──────────────────────────────────────────────────────────────────────────────

  Buffer stores metrics from all agents with 24h TTL.

  Show buffer status:
    $ agent-metrics status

  List buffered entries:
    $ agent-metrics buffer list
    $ agent-metrics buffer list --format json

  Filter by project (partial match):
    $ agent-metrics buffer list --project ops-uluops-api

  Filter by agent name:
    $ agent-metrics buffer list --agent-name code-validator

  Filter by time window:
    $ agent-metrics buffer list --since 2h
    $ agent-metrics buffer list --end-after 2026-01-14T04:00:00Z

  Get all entries for a session:
    $ agent-metrics buffer session <session-id>
    $ agent-metrics buffer session <session-id> --format tracker


TRACKER INTEGRATION
──────────────────────────────────────────────────────────────────────────────

  Typical workflow for updating a tracker run with token metrics:

  1. Run the ship pipeline (agents auto-captured by hook)

  2. Check what was captured:
     $ agent-metrics report --current

  3. Extract tracker-ready JSON for the run's agents:
     $ agent-metrics extract abd2f0a aade737 a294352 \\
         -f tracker \\
         --agent-names "code-validator,type-safety,test-architect"

  4. Copy the output into mcp__uluops-tracker__update_run

  Alternative: use buffer session for all agents at once:
     $ agent-metrics buffer session <session-id> --format tracker


MAINTENANCE
──────────────────────────────────────────────────────────────────────────────

  Clear expired entries:
    $ agent-metrics buffer clear --expired

  Clear after saving to tracker:
    $ agent-metrics buffer clear --session <session-id>

  View metrics log:
    $ agent-metrics log tail
    $ agent-metrics log tail -n 50

`);
  });

program.parse();
