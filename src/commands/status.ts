/**
 * Status Commands
 *
 * Top-level status and report commands for quick metrics overview.
 */

import { Command } from 'commander';
import { queryBuffer } from '../buffer.js';
import { displayBufferStatus, formatReport } from '../display/formatters.js';

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
    .action((options: { limit: string; session?: string; current?: boolean }) => {
      let entries = queryBuffer({ includeExpired: false });

      if (options.current) {
        // Get the most recent session ID
        if (entries.length > 0) {
          const currentSession = entries[entries.length - 1].session_id;
          entries = entries.filter(e => e.session_id === currentSession);
        }
      } else if (options.session) {
        entries = entries.filter(e => e.session_id === options.session);
      }

      // Apply limit
      const limit = parseInt(options.limit, 10);
      entries = entries.slice(-limit);

      console.log(formatReport(entries));
    });
}
