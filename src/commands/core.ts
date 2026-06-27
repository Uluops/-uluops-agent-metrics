/**
 * Core Commands
 *
 * Main extraction commands: extract, list, find, compare
 */

import { Command, Option } from 'commander';
import * as fs from 'node:fs';
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
  findCodexAgentFile,
  findRecentCodexAgentFiles,
  extractAgentIdFromFilename,
  extractCodexAgentIdFromFilename,
  getProjectName,
} from '../utils.js';
import { extractCodexMetricsFromFile } from '../codex-extractor.js';
import { queryBuffer } from '../buffer.js';
import {
  formatAgentList,
  formatAgentListError,
  formatAgentCompare,
  type AgentListItem,
  type CompareItem,
} from '../display/formatters.js';
import type { ExtractFormat, MetricsProvider, AgentFileLocation } from '../types.js';

const CODEX_UUIDV7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function providerOption(): Option {
  return new Option('--provider <provider>', 'Metrics provider')
    .choices(['auto', 'claude', 'codex'])
    .default('auto');
}

async function withMtime(location: AgentFileLocation): Promise<AgentFileLocation & { mtime: number }> {
  try {
    const stats = await fs.promises.stat(location.filePath);
    return { ...location, mtime: stats.mtimeMs };
  } catch {
    return { ...location, mtime: 0 };
  }
}

function matchesProject(location: AgentFileLocation, project?: string): boolean {
  if (!project) return true;
  const filter = project.toLowerCase();
  return location.projectDir.toLowerCase().includes(filter) || location.filePath.toLowerCase().includes(filter);
}

async function sortFilterLimitFiles(
  files: AgentFileLocation[],
  limit: number,
  project?: string
): Promise<AgentFileLocation[]> {
  const withTimes = await Promise.all(files.filter(file => matchesProject(file, project)).map(withMtime));
  return withTimes
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map(({ filePath, projectDir }) => ({ filePath, projectDir }));
}

async function findRecentFiles(provider: MetricsProvider, limit: number, project?: string): Promise<AgentFileLocation[]> {
  const scanLimit = project ? Math.max(limit * 10, 100) : limit;
  if (provider === 'claude') return sortFilterLimitFiles(await findRecentAgentFiles(scanLimit), limit, project);
  if (provider === 'codex') return sortFilterLimitFiles(await findRecentCodexAgentFiles(scanLimit), limit, project);

  const [claudeFiles, codexFiles] = await Promise.all([
    findRecentAgentFiles(scanLimit),
    findRecentCodexAgentFiles(scanLimit),
  ]);
  return sortFilterLimitFiles([...claudeFiles, ...codexFiles], limit, project);
}

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
  // Extract command — supports single or multiple agent IDs
  program
    .command('extract <agent-ids...>')
    .description('Extract metrics for one or more agent IDs')
    .option('-p, --project <path>', 'Project path to search in')
    .addOption(new Option('-f, --format <format>', 'Output format').choices(['json', 'summary', 'tracker']).default('json'))
    .option('--json', 'Shorthand for -f json')
    .option('-a, --agent-name <name>', 'Agent name for tracker format (single agent)')
    .option('--agent-names <names>', 'Comma-separated agent names for tracker format (batch)')
    .addOption(providerOption())
    .action(async (agentIds: string[], options: { project?: string; format: ExtractFormat; json?: boolean; agentName?: string; agentNames?: string; provider: MetricsProvider }) => {
      try {
        const format = options.json ? 'json' : options.format;
        const nameList = options.agentNames?.split(',').map(n => n.trim());

        // Batch extract
        const jsonResults: unknown[] = [];

        for (let i = 0; i < agentIds.length; i++) {
          const agentId = agentIds[i]!;
          const metrics = await extractAgentMetrics(agentId, {
            projectPath: options.project,
            provider: options.provider,
          });

          if (!metrics) {
            console.error(`Agent file not found for ID: ${agentId}`);
            if (agentIds.length === 1) {
              console.error('Run "agent-metrics list" to see available agent IDs.');
              process.exit(1);
            }
            continue;
          }

          // Resolve agent name: --agent-names (batch) > --agent-name (single) > buffer lookup
          let agentName = nameList?.[i] || options.agentName;
          if (!agentName) {
            const bufferEntries = queryBuffer({ agentId });
            const bufferEntry = bufferEntries.find(e => e.agent_id === agentId);
            agentName = bufferEntry?.agent_name || metrics.slug || 'unknown';
          }

          switch (format) {
            case 'summary':
              if (agentIds.length > 1) {
                console.log(`\n─── ${agentName} (${agentId}) ───`);
              }
              console.log(formatMetricsSummary(metrics));
              break;
            case 'tracker':
              jsonResults.push(toTrackerFormat(metrics, agentName));
              break;
            case 'json':
              jsonResults.push(metrics);
              break;
          }
        }

        // For JSON/tracker formats, output array if batch, single object if solo
        if (format === 'json' || format === 'tracker') {
          if (jsonResults.length === 1) {
            console.log(JSON.stringify(jsonResults[0], null, 2));
          } else if (jsonResults.length > 1) {
            console.log(JSON.stringify(jsonResults, null, 2));
          } else {
            console.error('No agent metrics were extracted.');
            console.error('Run "agent-metrics list" to see available agent IDs.');
            process.exit(1);
          }
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
    .addOption(providerOption())
    .action(async (options: { limit: string; project?: string; provider: MetricsProvider }) => {
      try {
        const limit = parseInt(options.limit, 10);
        if (isNaN(limit) || limit <= 0) {
          console.error(`Invalid --limit: '${options.limit}'. Expected a positive integer.`);
          process.exit(1);
        }
        const recentFiles = await findRecentFiles(options.provider, limit, options.project);

        const items: AgentListItem[] = [];
        const errors: string[] = [];

        for (const { filePath, projectDir } of recentFiles) {
          const filename = path.basename(filePath);
          const agentId = extractAgentIdFromFilename(filename) ?? extractCodexAgentIdFromFilename(filename);
          const projectName = getProjectName(projectDir);

          if (!agentId) continue;

          try {
            const metrics = filename.startsWith('rollout-')
              ? await extractCodexMetricsFromFile(filePath)
              : await extractMetricsFromFile(filePath);
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
    .addOption(providerOption())
    .action(async (agentId: string, options: { project?: string; provider: MetricsProvider }) => {
      const provider = options.provider === 'auto'
        ? (CODEX_UUIDV7_PATTERN.test(agentId) ? 'codex' : 'claude')
        : options.provider;
      const location = provider === 'codex'
        ? await findCodexAgentFile(agentId)
        : findAgentFile(agentId, options.project);

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
