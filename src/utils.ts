/**
 * Utility functions for agent metrics extraction
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { AgentFileLocation } from './types.js';

/**
 * Get the Claude Code projects directory
 */
export function getClaudeProjectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * Convert a directory path to Claude's project folder naming convention.
 * Replaces path separators with dashes to create a flat folder name.
 *
 * @param dirPath - The directory path to convert
 * @returns Folder name with dashes (e.g., "/home/user/my-project" -> "-home-user-my-project")
 */
export function sanitizePathAsFolderName(dirPath: string): string {
  return dirPath.replace(/\//g, '-');
}

/**
 * Find an agent file by ID, optionally within a specific project
 *
 * @param agentId - The agent ID (e.g., "ac51171")
 * @param projectPath - Optional project path to search in
 * @returns Location of the agent file, or null if not found
 */
export function findAgentFile(
  agentId: string,
  projectPath?: string
): AgentFileLocation | null {
  const projectsDir = getClaudeProjectsDir();

  // Normalize agent ID (remove 'agent-' prefix if present)
  const normalizedId = agentId.replace(/^agent-/, '');
  const filename = `agent-${normalizedId}.jsonl`;

  // If project path provided, search there first
  if (projectPath) {
    const projectFolder = sanitizePathAsFolderName(path.resolve(projectPath));
    const projectDir = path.join(projectsDir, projectFolder);
    const filePath = path.join(projectDir, filename);

    if (fs.existsSync(filePath)) {
      return { filePath, projectDir };
    }
  }

  // Search all project directories
  if (!fs.existsSync(projectsDir)) {
    return null;
  }

  const projectFolders = fs.readdirSync(projectsDir, { withFileTypes: true });

  for (const folder of projectFolders) {
    if (!folder.isDirectory()) continue;

    const projectDir = path.join(projectsDir, folder.name);
    const filePath = path.join(projectDir, filename);

    if (fs.existsSync(filePath)) {
      return { filePath, projectDir };
    }
  }

  return null;
}

/**
 * Find the most recent agent files across all projects
 *
 * Uses async fs operations to avoid blocking the event loop.
 * Project directories are scanned in parallel for better performance.
 *
 * Edge cases:
 * - Projects directory doesn't exist → returns empty array
 * - Individual project folder scan fails → that project is skipped silently
 * - Individual file stat fails (permission, deleted) → that file is skipped
 * - No agent files found → returns empty array
 * - limit <= 0 → returns empty array
 *
 * @param limit - Maximum number of files to return (default: 10)
 * @returns Array of agent file locations sorted by modification time (newest first)
 */
export async function findRecentAgentFiles(limit: number = 10): Promise<AgentFileLocation[]> {
  const projectsDir = getClaudeProjectsDir();

  try {
    await fs.promises.access(projectsDir);
  } catch {
    return [];
  }

  // Read all project folders
  const projectFolders = await fs.promises.readdir(projectsDir, { withFileTypes: true });
  const directories = projectFolders.filter((f) => f.isDirectory());

  // Scan each project directory in parallel
  const scanResults = await Promise.allSettled(
    directories.map(async (folder) => {
      const projectDir = path.join(projectsDir, folder.name);
      const files = await fs.promises.readdir(projectDir);

      const agentFiles: Array<AgentFileLocation & { mtime: number }> = [];

      // Get stats for agent files in parallel within each project
      const statResults = await Promise.allSettled(
        files
          .filter((file) => file.startsWith('agent-') && file.endsWith('.jsonl'))
          .map(async (file) => {
            const filePath = path.join(projectDir, file);
            const stats = await fs.promises.stat(filePath);
            return { filePath, projectDir, mtime: stats.mtimeMs };
          })
      );

      for (const result of statResults) {
        if (result.status === 'fulfilled') {
          agentFiles.push(result.value);
        }
      }

      return agentFiles;
    })
  );

  // Flatten results from all projects
  const allAgentFiles: Array<AgentFileLocation & { mtime: number }> = [];
  for (const result of scanResults) {
    if (result.status === 'fulfilled') {
      allAgentFiles.push(...result.value);
    }
  }

  // Sort by modification time (newest first) and limit
  return allAgentFiles
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map(({ filePath, projectDir }) => ({ filePath, projectDir }));
}

/**
 * Format duration in milliseconds to human-readable string
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted string (e.g., "4m 39s", "1h 23m", "45s")
 */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  }

  if (minutes > 0) {
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  }

  return `${seconds}s`;
}

/**
 * Format a number with thousand separators
 *
 * @param num - Number to format
 * @returns Formatted string (e.g., "1,234,567")
 */
export function formatNumber(num: number): string {
  return num.toLocaleString('en-US');
}

/**
 * Format token count in K notation
 *
 * @param tokens - Token count
 * @returns Formatted string (e.g., "45.2k", "1.3M")
 */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}k`;
  }
  return tokens.toString();
}

/**
 * Format a model name for display by removing the "claude-" prefix and date suffix.
 * Handles various model name formats consistently.
 *
 * @param model - Full model name (e.g., "claude-sonnet-4-5-20250929")
 * @param maxLength - Maximum length for the output (default: 12)
 * @returns Shortened model name (e.g., "sonnet-4-5")
 *
 * @example
 * formatModelName('claude-sonnet-4-5-20250929') // 'sonnet-4-5'
 * formatModelName('claude-opus-4-5-20251101') // 'opus-4-5'
 * formatModelName('unknown-model') // 'unknown-mode'
 */
/** Pattern to match Claude model prefix */
const CLAUDE_PREFIX_PATTERN = /^claude-/;

/** Pattern to match 8-digit date suffix (e.g., -20250929) */
const DATE_SUFFIX_PATTERN = /-\d{8}$/;

export function formatModelName(model: string | undefined | null, maxLength: number = 12): string {
  if (!model) return 'unknown';
  return model
    .replace(CLAUDE_PREFIX_PATTERN, '')
    .replace(DATE_SUFFIX_PATTERN, '')
    .slice(0, maxLength);
}

/**
 * Parse an ISO 8601 timestamp string to Date
 *
 * @param timestamp - ISO 8601 timestamp string
 * @returns Date object
 */
export function parseTimestamp(timestamp: string): Date {
  return new Date(timestamp);
}

/**
 * Calculate duration between two ISO 8601 timestamps
 *
 * @param start - Start timestamp
 * @param end - End timestamp
 * @returns Duration in milliseconds
 */
export function calculateDuration(start: string, end: string): number {
  const startDate = parseTimestamp(start);
  const endDate = parseTimestamp(end);
  return endDate.getTime() - startDate.getTime();
}

/**
 * Extract agent ID from a filename
 *
 * @param filename - Filename (e.g., "agent-ac51171.jsonl")
 * @returns Agent ID (e.g., "ac51171") or null if not a valid agent file
 */
export function extractAgentIdFromFilename(filename: string): string | null {
  const match = filename.match(/^agent-([a-f0-9]+)\.jsonl$/);
  return match ? match[1] : null;
}

/**
 * Get project name from project directory path
 *
 * @param projectDir - Project directory path
 * @returns Human-readable project name
 */
export function getProjectName(projectDir: string): string {
  const folderName = path.basename(projectDir);
  // Convert "-home-user-project-name" to "project-name"
  // Take the last meaningful segment
  const segments = folderName.split('-').filter(Boolean);

  // Skip common path prefixes
  const skipPrefixes = ['home', 'users', 'user'];
  let startIndex = 0;
  for (let i = 0; i < segments.length; i++) {
    if (skipPrefixes.includes(segments[i].toLowerCase())) {
      startIndex = i + 1;
    } else {
      break;
    }
  }

  // Skip username (next segment after home/users)
  if (startIndex < segments.length) {
    startIndex++;
  }

  return segments.slice(startIndex).join('-') || folderName;
}
