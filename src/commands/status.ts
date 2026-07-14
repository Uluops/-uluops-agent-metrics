/**
 * Status Commands
 *
 * Top-level status and report commands for quick metrics overview.
 */

import { Command, Option } from 'commander';
import { queryBuffer } from '../buffer.js';
import { displayBufferStatus, formatReport } from '../display/formatters.js';
import type { MetricsProvider } from '../types.js';

/**
 * Register status commands on the program.
 */
export function registerStatusCommands(program: Command): void {
  // Top-level status command (alias for buffer status)
  program
    .command('status')
    .description('Show buffer statistics')
    .action(() => {
      displayBufferStatus('Agent Metrics Buffer');
    });

  // Top-level report command - show recent entries in a nice format
  program
    .command('report')
    .description('Show recent auto-captured metrics')
    .option('-n, --limit <number>', 'Number of entries to show', '20')
    .option('-s, --session <id>', 'Filter by session ID')
    .option('--current', 'Show only current session')
    .addOption(new Option('--provider <provider>', 'Metrics provider').choices(['auto', 'claude', 'codex']).default('auto'))
    .action((options: { limit: string; session?: string; current?: boolean; provider: MetricsProvider }) => {
      if (options.provider === 'codex') {
        console.error('Codex report support is not available because report is fed by the Claude Code SubagentStop hook buffer. Use `agent-metrics list --provider codex` and `agent-metrics extract <id> --provider codex` instead. A future Codex hook spec may lift this restriction.');
        process.exit(1);
      }

      let entries = queryBuffer({ includeExpired: false });

      if (options.current) {
        // Get the most recent session ID
        if (entries.length > 0) {
          const currentSession = entries[entries.length - 1]!.session_id;
          entries = entries.filter(e => e.session_id === currentSession);
        }
      } else if (options.session) {
        entries = entries.filter(e => e.session_id === options.session);
      }

      // Apply limit
      const limit = parseInt(options.limit, 10);
      if (isNaN(limit) || limit <= 0) {
        console.error(`Invalid --limit: '${options.limit}'. Expected a positive integer.`);
        process.exit(1);
      }
      entries = entries.slice(-limit);

      console.log(formatReport(entries));
    });
}
