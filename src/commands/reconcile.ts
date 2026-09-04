/**
 * Reconcile Command
 *
 * Moves ADR-0004's count-check into this artifact: reads the buffer for a
 * single orchestrator run token, compares the attributed agent count to a
 * caller-supplied expectation, and exits non-zero on shortfall. See
 * docs/decisions/0004-run-scoped-attribution.md and
 * uluops-specifications/.../01-reconcile-run-expect-command-spec-v0_1_0.md.
 */

import { Command } from 'commander';
import { queryBuffer } from '../buffer.js';
import { formatBufferList } from '../display/formatters.js';
import { filterByProjectPath } from './shared.js';

type ReconcileFormat = 'text' | 'json';
type ReconcileStatus = 'exact' | 'over' | 'shortfall';

interface ReconcileJson {
  run_id: string;
  expected: number;
  attributed: number;
  /** expected - attributed; negative under over-collection */
  shortfall: number;
  status: ReconcileStatus;
  agents: Array<{ agent_id: string; agent_name?: string }>;
}

/**
 * Register the `reconcile` command on the program.
 *
 * Top-level command (not `buffer reconcile`): the semantic subject is the
 * run, not the buffer — `buffer` is the storage-maintenance namespace
 * (status/list/session/clear).
 */
export function registerReconcileCommands(program: Command): void {
  program
    .command('reconcile')
    .description('Verify all agents expected in an orchestrator run were attributed to it; exit non-zero on shortfall')
    .option('--run <token>', 'Orchestrator run token (exact match, lowercased like buffer list)')
    .option('--expect <n>', 'Expected agent count, positive integer')
    .option('-p, --project <path>', 'Additionally require project_path partial match (parity with buffer list -p)')
    .option('-f, --format <format>', 'Output format: text, json', 'text')
    .option('-a, --all', 'Include expired entries')
    .action((options: {
      run?: string;
      expect?: string;
      project?: string;
      format: ReconcileFormat;
      all?: boolean;
    }) => {
      // Usage errors exit 2 — deliberately distinct from the shortfall exit
      // (1), so a caller reading only the exit code can tell "I mistyped a
      // flag" from "the run really lost an agent" (spec §3.2).
      if (!options.run) {
        console.error('Missing required option: --run <token>');
        process.exit(2);
      }

      const expected = parseInt(options.expect ?? '', 10);
      if (options.expect === undefined || isNaN(expected) || expected <= 0) {
        console.error(`Invalid --expect: '${options.expect ?? ''}'. Expected a positive integer.`);
        process.exit(2);
      }

      const runId = options.run.toLowerCase();
      let entries = queryBuffer({ runId, includeExpired: options.all });
      entries = filterByProjectPath(entries, options.project);

      const attributed = entries.length;
      const shortfall = expected - attributed;
      const status: ReconcileStatus = shortfall === 0 ? 'exact' : shortfall > 0 ? 'shortfall' : 'over';

      if (options.format === 'json') {
        const payload: ReconcileJson = {
          run_id: runId,
          expected,
          attributed,
          shortfall,
          status,
          agents: entries.map(e => ({ agent_id: e.agent_id, agent_name: e.agent_name })),
        };
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(`Run token: ${runId}`);
        console.log(`Expected:  ${expected}`);
        console.log(`Attributed: ${attributed}`);
        console.log('');
        console.log(formatBufferList(entries));
      }

      // The diagnostic line is stderr in both formats, so `-f json` stdout
      // stays machine-parseable (spec §3.3).
      if (status === 'shortfall') {
        console.error('');
        console.error(`SHORTFALL: ${shortfall} agent${shortfall === 1 ? '' : 's'} expected but not attributed to this run.`);
        console.error('Likely cause: a dropped [run:] tag (ADR-0004 §Consequences).');
        process.exit(1);
      }

      if (status === 'over') {
        console.error('');
        console.error(`Over-collection: ${attributed} agents attributed, ${expected} expected. Benign per ADR-0004 (bounded to one project, never mis-attribution).`);
      }

      // exact/over: return normally — matches the buffer.ts/core.ts convention
      // of only calling process.exit on an error/usage/shortfall path. The
      // process's natural exit code is 0.
    });
}
