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

BASIC COMMANDS
──────────────────────────────────────────────────────────────────────────────

  List recent agent runs:
    $ agent-metrics list
    $ agent-metrics list --limit 20

  Extract metrics for a specific agent:
    $ agent-metrics extract a7c642b
    $ agent-metrics extract a7c642b --format summary
    $ agent-metrics extract a7c642b --format tracker --agent-name code-validator

  Find agent file location:
    $ agent-metrics find a7c642b

  Compare multiple agents:
    $ agent-metrics compare a7c642b a03c37d af0c1a1


BUFFER COMMANDS
──────────────────────────────────────────────────────────────────────────────

  Show buffer status:
    $ agent-metrics status
    $ agent-metrics buffer status

  List buffered entries:
    $ agent-metrics buffer list
    $ agent-metrics buffer list --format json

  Filter by project (partial match):
    $ agent-metrics buffer list --project ops-uluops-mcp
    $ agent-metrics buffer list -p dashboard

  Filter by agent name:
    $ agent-metrics buffer list --agent-name code-validator
    $ agent-metrics buffer list --agent-name test-architect

  Filter by time window (when agents finished):
    $ agent-metrics buffer list --end-after 2026-01-14T04:00:00Z
    $ agent-metrics buffer list --end-after 2026-01-14T04:00:00Z --end-before 2026-01-14T05:00:00Z

  Filter by recent capture time:
    $ agent-metrics buffer list --since 2h
    $ agent-metrics buffer list --since 30m

  Get all entries for a session:
    $ agent-metrics buffer session 7b543cfe-7f1c-460d-8c11-2ac8c8d02f47
    $ agent-metrics buffer session 7b543cfe --format tracker


CORRELATION WITH TRACKER
──────────────────────────────────────────────────────────────────────────────

  Find agents that ran around a specific tracker run timestamp:

    # If tracker shows run at 2026-01-14T05:11:33Z, search window before:
    $ agent-metrics buffer list \
        --end-after 2026-01-14T04:00:00Z \
        --end-before 2026-01-14T05:15:00Z \
        --project ops-uluops-mcp

  Get tracker-ready format for backfilling token data:
    $ agent-metrics buffer session <session-id> --format tracker


MAINTENANCE
──────────────────────────────────────────────────────────────────────────────

  Clear expired entries (garbage collect):
    $ agent-metrics buffer clear --expired

  Clear entries for a session (after saving to tracker):
    $ agent-metrics buffer clear --session <session-id>

  View metrics log:
    $ agent-metrics log tail
    $ agent-metrics log tail -n 50

`);
  });

program.parse();
