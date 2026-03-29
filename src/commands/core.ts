/**
 * Core Commands
 *
 * Main extraction commands: extract, list, find, compare
 */

import { Command, Option } from 'commander';
import * as path from 'node:path';
import {
  extractAgentMetrics,
  extractMetricsFromFile,
  formatMetricsSummary,
  toTrackerFormat,
} from '../extractor.js';
import {
  findAgentFile,
  findRecentAgentFiles,
  extractAgentIdFromFilename,
  getProjectName,
} from '../utils.js';
import { queryBuffer } from '../buffer.js';
import {
  formatAgentList,
  formatAgentListError,
  formatAgentCompare,
  type AgentListItem,
  type CompareItem,
} from '../display/formatters.js';
import type { ExtractFormat } from '../types.js';

/**
 * Register core commands on the program.
 *
 * Adds the following commands:
 * - `extract <agent-id>` — Extract metrics for a specific agent (json/summary/tracker output)
 * - `list` — List recent agent runs with duration, tokens, and tool counts
 * - `find <agent-id>` — Locate the JSONL file for an agent
 * - `compare <agent-ids...>` — Side-by-side comparison of multiple agents
 */
export function registerCoreCommands(program: Command): void {
  // Extract command
  program
    .command('extract <agent-id>')
    .description('Extract metrics for a specific agent ID')
    .option('-p, --project <path>', 'Project path to search in')
    .addOption(new Option('-f, --format <format>', 'Output format').choices(['json', 'summary', 'tracker']).default('json'))
    .option('-a, --agent-name <name>', 'Agent name for tracker format')
    .action(async (agentId: string, options: { project?: string; format: ExtractFormat; agentName?: string }) => {
      try {
        const metrics = await extractAgentMetrics(agentId, {
          projectPath: options.project,
        });

        if (!metrics) {
          console.error(`Agent file not found for ID: ${agentId}`);
          console.error('Run "agent-metrics list" to see available agent IDs.');
          process.exit(1);
        }

        switch (options.format) {
          case 'summary':
            console.log(formatMetricsSummary(metrics));
            break;
          case 'tracker': {
            // Auto-lookup agent name from buffer if not provided
            let agentName = options.agentName;
            if (!agentName) {
              const bufferEntries = queryBuffer({ agentId });
              const bufferEntry = bufferEntries.find(e => e.agent_id === agentId);
              agentName = bufferEntry?.agent_name || 'unknown';
            }
            console.log(JSON.stringify(toTrackerFormat(metrics, agentName), null, 2));
            break;
          }
          case 'json':
            console.log(JSON.stringify(metrics, null, 2));
            break;
        }
      } catch (error) {
        console.error('Error extracting metrics:', error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });

  // List command
  program
    .command('list')
    .description('List recent agent runs')
    .option('-n, --limit <number>', 'Number of agents to list', '10')
    .option('-p, --project <path>', 'Filter by project path')
    .action(async (options: { limit: string; project?: string }) => {
      try {
        const limit = parseInt(options.limit, 10);
        if (isNaN(limit) || limit <= 0) {
          console.error(`Invalid --limit: '${options.limit}'. Expected a positive integer.`);
          process.exit(1);
        }
        const recentFiles = await findRecentAgentFiles(limit);

        const items: AgentListItem[] = [];
        const errors: string[] = [];

        for (const { filePath, projectDir } of recentFiles) {
          const filename = path.basename(filePath);
          const agentId = extractAgentIdFromFilename(filename);
          const projectName = getProjectName(projectDir);

          if (!agentId) continue;

          try {
            const metrics = await extractMetricsFromFile(filePath);
            items.push({ agentId, metrics, projectName });
          } catch {
            errors.push(formatAgentListError(agentId, projectName));
          }
        }

        // Output formatted list
        console.log(formatAgentList(items));

        // Append any errors
        for (const error of errors) {
          console.log(error);
        }
      } catch (error) {
        console.error('Error listing agents:', error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });

  // Find command
  program
    .command('find <agent-id>')
    .description('Find the location of an agent file')
    .option('-p, --project <path>', 'Project path to search in')
    .action((agentId: string, options: { project?: string }) => {
      const location = findAgentFile(agentId, options.project);

      if (!location) {
        console.error(`Agent file not found for ID: ${agentId}`);
        console.error('Run "agent-metrics list" to see available agent IDs.');
        process.exit(1);
      }

      console.log(JSON.stringify(location, null, 2));
    });

  // Compare command (useful for workflow runs with multiple validators)
  program
    .command('compare <agent-ids...>')
    .description('Compare metrics across multiple agent runs')
    .option('-p, --project <path>', 'Project path to search in')
    .action(async (agentIds: string[], options: { project?: string }) => {
      try {
        const items: CompareItem[] = await Promise.all(
          agentIds.map(async (agentId) => ({
            agentId,
            metrics: await extractAgentMetrics(agentId, { projectPath: options.project }),
          }))
        );

        console.log(formatAgentCompare(items));
      } catch (error) {
        console.error('Error comparing agents:', error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });
}
