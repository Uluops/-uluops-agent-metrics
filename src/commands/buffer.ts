/**
 * Buffer Commands
 *
 * Commands for managing the auto-captured metrics buffer.
 */

import { Command } from 'commander';
import {
  queryBuffer,
  getAllForSession,
  clearSession,
  clearAgents,
  cleanupExpired,
  entriesToTrackerFormat,
} from '../buffer.js';
import {
  displayBufferStatus,
  formatBufferList,
  formatBufferSession,
} from '../display/formatters.js';
import type { BufferFormat } from '../types.js';

/**
 * Parse a duration string like "30m" or "2h" into a Date relative to now.
 * Returns undefined if the string doesn't match the expected format.
 */
function parseSinceDuration(raw: string): Date | null {
  const match = raw.match(/^(\d+)(m|h)$/);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2];
  const ms = unit === 'h' ? value * 60 * 60 * 1000 : value * 60 * 1000;
  return new Date(Date.now() - ms);
}

/**
 * Parse an ISO 8601 date string and validate it.
 * Returns the Date or null if invalid.
 */
function parseIsoDate(raw: string): Date | null {
  const date = new Date(raw);
  return isNaN(date.getTime()) ? null : date;
}

/**
 * Register buffer commands on the program.
 */
export function registerBufferCommands(program: Command): void {
  const bufferCmd = program
    .command('buffer')
    .description('Manage the auto-captured metrics buffer');

  // Buffer status
  bufferCmd
    .command('status')
    .description('Show buffer statistics')
    .action(() => {
      displayBufferStatus('Agent Metrics Buffer Status');
    });

  // Buffer list
  bufferCmd
    .command('list')
    .description('List buffered metrics entries')
    .option('-s, --session <id>', 'Filter by session ID')
    .option('--agent-name <name>', 'Filter by agent name')
    .option('-p, --project <path>', 'Filter by project path (partial match)')
    .option('--since <duration>', 'Filter entries captured in last duration (e.g., 30m, 1h, 2h)')
    .option('--end-after <iso-date>', 'Filter agents that finished after this time (ISO 8601)')
    .option('--end-before <iso-date>', 'Filter agents that finished before this time (ISO 8601)')
    .option('-a, --all', 'Include expired entries')
    .option('-f, --format <format>', 'Output format: table, json, tracker', 'table')
    .action((options: {
      session?: string;
      agentName?: string;
      project?: string;
      since?: string;
      endAfter?: string;
      endBefore?: string;
      all?: boolean;
      format: BufferFormat;
    }) => {
      // Parse --since duration
      let sinceDate: Date | undefined;
      if (options.since) {
        const parsed = parseSinceDuration(options.since);
        if (!parsed) {
          console.error(`Invalid --since format: '${options.since}'. Use a number followed by 'm' (minutes) or 'h' (hours). Examples: 30m, 2h`);
          process.exit(1);
        }
        sinceDate = parsed;
      }

      // Parse --end-after and --end-before ISO dates
      let endTimeAfter: Date | undefined;
      let endTimeBefore: Date | undefined;
      if (options.endAfter) {
        const parsed = parseIsoDate(options.endAfter);
        if (!parsed) {
          console.error('Invalid --end-after format. Use ISO 8601 format (e.g., 2026-01-14T04:00:00Z)');
          process.exit(1);
        }
        endTimeAfter = parsed;
      }
      if (options.endBefore) {
        const parsed = parseIsoDate(options.endBefore);
        if (!parsed) {
          console.error('Invalid --end-before format. Use ISO 8601 format (e.g., 2026-01-14T05:00:00Z)');
          process.exit(1);
        }
        endTimeBefore = parsed;
      }

      let entries = queryBuffer({
        sessionId: options.session,
        agentName: options.agentName,
        since: sinceDate,
        endTimeAfter,
        endTimeBefore,
        includeExpired: options.all,
      });

      // Filter by project path (partial match)
      if (options.project) {
        const projectFilter = options.project.toLowerCase();
        entries = entries.filter(e =>
          e.project_path?.toLowerCase().includes(projectFilter)
        );
      }

      if (options.format === 'json') {
        console.log(JSON.stringify(entries, null, 2));
        return;
      }

      if (options.format === 'tracker') {
        // Output format ready for validation tracker with full cache breakdown
        console.log(JSON.stringify(entriesToTrackerFormat(entries), null, 2));
        return;
      }

      console.log(formatBufferList(entries));
    });

  // Buffer session - get all entries for a session
  bufferCmd
    .command('session <session-id>')
    .description('Get all buffered entries for a session')
    .option('-f, --format <format>', 'Output format: table, json, tracker', 'table')
    .action((sessionId: string, options: { format: BufferFormat }) => {
      const entries = getAllForSession(sessionId);

      if (options.format === 'json') {
        console.log(JSON.stringify(entries, null, 2));
        return;
      }

      if (options.format === 'tracker') {
        // Output format ready for validation tracker with full cache breakdown
        console.log(JSON.stringify(entriesToTrackerFormat(entries), null, 2));
        return;
      }

      console.log(formatBufferSession(sessionId, entries));
    });

  // Buffer clear
  bufferCmd
    .command('clear')
    .description('Clear buffer entries')
    .option('-s, --session <id>', 'Clear entries for a specific session')
    .option('--agents <ids...>', 'Clear specific agent IDs')
    .option('--expired', 'Clear only expired entries (garbage collect)')
    .action((options: { session?: string; agents?: string[]; expired?: boolean }) => {
      if (options.expired) {
        const count = cleanupExpired();
        console.log(`Cleared ${count} expired entries.`);
        return;
      }

      if (options.session) {
        const count = clearSession(options.session);
        console.log(`Cleared ${count} entries for session: ${options.session}`);
        return;
      }

      if (options.agents && options.agents.length > 0) {
        const count = clearAgents(options.agents);
        console.log(`Cleared ${count} entries for agents: ${options.agents.join(', ')}`);
        return;
      }

      console.error('Specify --session, --agents, or --expired');
      process.exit(1);
    });
}
