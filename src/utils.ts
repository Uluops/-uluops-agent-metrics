/**
 * Utility functions for agent metrics extraction
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { AgentFileLocation } from './types.js';

/**
 * Get the Claude Code projects directory
 *
 * @returns Absolute path to `~/.claude/projects`
 */
export function getClaudeProjectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * Get the Codex sessions directory.
 *
 * Uses `$CODEX_HOME/sessions` when `CODEX_HOME` is set, otherwise
 * `~/.codex/sessions`.
 *
 * @returns Absolute path to the Codex sessions directory
 */
export function getCodexSessionsDir(): string {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(codexHome, 'sessions');
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
 * Search for an agent file within a project directory.
 * Checks both the flat layout (legacy) and the session/subagents layout (current).
 *
 * @param projectDir - The project directory to search in
 * @param filename - The agent filename (e.g., "agent-abc123.jsonl")
 * @returns Location of the agent file, or null if not found
 */
function findAgentFileInProject(
  projectDir: string,
  filename: string
): AgentFileLocation | null {
  if (!fs.existsSync(projectDir)) return null;

  // Check flat layout: {projectDir}/agent-{id}.jsonl (legacy)
  const flatPath = path.join(projectDir, filename);
  if (fs.existsSync(flatPath)) {
    return { filePath: flatPath, projectDir };
  }

  // Check session/subagents layout: {projectDir}/{session-uuid}/subagents/agent-{id}.jsonl
  try {
    const entries = fs.readdirSync(projectDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subagentsPath = path.join(projectDir, entry.name, 'subagents', filename);
      if (fs.existsSync(subagentsPath)) {
        return { filePath: subagentsPath, projectDir };
      }
    }
  } catch {
    // Permission or read error — skip silently
  }

  return null;
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

  // Validate before building a filesystem path — parity with the hook's
  // isValidAgentId gate. Claude agent IDs are lowercase hex; reject anything
  // else (path traversal, injection) by returning null. Codex UUIDv7 IDs use
  // findCodexAgentFile (a separate path) and are unaffected.
  if (!/^[a-f0-9]+$/.test(normalizedId)) {
    return null;
  }

  const filename = `agent-${normalizedId}.jsonl`;

  // If project path provided, search there first
  if (projectPath) {
    const projectFolder = sanitizePathAsFolderName(path.resolve(projectPath));
    const projectDir = path.join(projectsDir, projectFolder);
    const result = findAgentFileInProject(projectDir, filename);
    if (result) return result;
  }

  // Search all project directories
  if (!fs.existsSync(projectsDir)) {
    return null;
  }

  const projectFolders = fs.readdirSync(projectsDir, { withFileTypes: true });

  for (const folder of projectFolders) {
    if (!folder.isDirectory()) continue;

    const projectDir = path.join(projectsDir, folder.name);
    const result = findAgentFileInProject(projectDir, filename);
    if (result) return result;
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

      const agentFiles: Array<AgentFileLocation & { mtime: number }> = [];

      // Collect agent file paths from both layouts
      const candidateFiles: Array<{ filePath: string; projectDir: string }> = [];

      const entries = await fs.promises.readdir(projectDir, { withFileTypes: true });

      for (const entry of entries) {
        // Flat layout (legacy): agent-{id}.jsonl directly in project dir
        if (!entry.isDirectory() && entry.name.startsWith('agent-') && entry.name.endsWith('.jsonl')) {
          candidateFiles.push({ filePath: path.join(projectDir, entry.name), projectDir });
        }

        // Session/subagents layout: {session-uuid}/subagents/agent-{id}.jsonl
        if (entry.isDirectory()) {
          const subagentsDir = path.join(projectDir, entry.name, 'subagents');
          try {
            const subFiles = await fs.promises.readdir(subagentsDir);
            for (const subFile of subFiles) {
              if (subFile.startsWith('agent-') && subFile.endsWith('.jsonl')) {
                candidateFiles.push({ filePath: path.join(subagentsDir, subFile), projectDir });
              }
            }
          } catch {
            // subagents dir doesn't exist or isn't readable — skip
          }
        }
      }

      // Get stats for all candidate files in parallel
      const statResults = await Promise.allSettled(
        candidateFiles.map(async ({ filePath, projectDir: pDir }) => {
          const stats = await fs.promises.stat(filePath);
          return { filePath, projectDir: pDir, mtime: stats.mtimeMs };
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

function isCodexRolloutFile(filename: string): boolean {
  return filename.startsWith('rollout-') && filename.endsWith('.jsonl');
}

async function walkCodexSessionFiles(dir: string, files: string[] = []): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }

  await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkCodexSessionFiles(entryPath, files);
      return;
    }
    if (entry.isFile() && isCodexRolloutFile(entry.name)) {
      files.push(entryPath);
    }
  }));

  return files;
}

function readCodexSessionMeta(filePath: string): Record<string, unknown> | null {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(8192);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const firstLine = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/, 1)[0];
      if (!firstLine) return null;
      const parsed = JSON.parse(firstLine) as unknown;
      if (!parsed || typeof parsed !== 'object') return null;
      const record = parsed as Record<string, unknown>;
      if (record.type !== 'session_meta') return null;
      const payload = record.payload;
      return payload && typeof payload === 'object' ? payload as Record<string, unknown> : null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Find a Codex rollout file by subagent/session id.
 *
 * Searches `$CODEX_HOME/sessions` when `CODEX_HOME` is set, otherwise
 * `~/.codex/sessions`. The filename suffix is checked first, then the
 * `session_meta.payload.id` value is used as a fallback for older or renamed
 * rollout files.
 *
 * @param agentId - Codex UUIDv7 subagent/session id
 * @returns Location of the rollout file, or null if not found
 */
export async function findCodexAgentFile(agentId: string): Promise<AgentFileLocation | null> {
  const sessionsDir = getCodexSessionsDir();
  const filenameSuffix = `-${agentId}.jsonl`;
  const files = await walkCodexSessionFiles(sessionsDir);

  for (const filePath of files) {
    if (!path.basename(filePath).endsWith(filenameSuffix)) continue;
    const meta = readCodexSessionMeta(filePath);
    const cwd = typeof meta?.cwd === 'string' ? meta.cwd : sessionsDir;
    return { filePath, projectDir: cwd };
  }

  for (const filePath of files) {
    const meta = readCodexSessionMeta(filePath);
    if (meta?.id === agentId) {
      const cwd = typeof meta.cwd === 'string' ? meta.cwd : sessionsDir;
      return { filePath, projectDir: cwd };
    }
  }

  return null;
}

/**
 * Find recent Codex subagent rollout files.
 *
 * Scans Codex session rollout JSONL files and returns only files whose
 * `session_meta.payload.thread_source` is `subagent`. Results are sorted by
 * modification time, newest first.
 *
 * @param limit - Maximum number of files to return (default: 10)
 * @returns Recent Codex subagent rollout locations
 */
export async function findRecentCodexAgentFiles(limit: number = 10): Promise<AgentFileLocation[]> {
  if (limit <= 0) return [];
  const sessionsDir = getCodexSessionsDir();
  const files = await walkCodexSessionFiles(sessionsDir);
  const candidates: Array<AgentFileLocation & { mtime: number }> = [];

  const stats = await Promise.allSettled(
    files.map(async (filePath) => {
      const meta = readCodexSessionMeta(filePath);
      if (meta?.thread_source !== 'subagent') return null;
      const stat = await fs.promises.stat(filePath);
      const cwd = typeof meta.cwd === 'string' ? meta.cwd : sessionsDir;
      return { filePath, projectDir: cwd, mtime: stat.mtimeMs };
    })
  );

  for (const result of stats) {
    if (result.status === 'fulfilled' && result.value) {
      candidates.push(result.value);
    }
  }

  return candidates
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

/** Pattern to match Claude model prefix */
const CLAUDE_PREFIX_PATTERN = /^claude-/;

/** Pattern to match 8-digit date suffix (e.g., -20250929) */
const DATE_SUFFIX_PATTERN = /-\d{8}$/;

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
  const startMs = parseTimestamp(start).getTime();
  const endMs = parseTimestamp(end).getTime();
  if (isNaN(startMs) || isNaN(endMs)) return 0;
  return endMs - startMs;
}

/**
 * Extract agent ID from a filename
 *
 * @param filename - Filename (e.g., "agent-ac51171.jsonl")
 * @returns Agent ID (e.g., "ac51171") or null if not a valid agent file
 */
export function extractAgentIdFromFilename(filename: string): string | null {
  const match = filename.match(/^agent-([a-f0-9]+)\.jsonl$/);
  return match?.[1] ?? null;
}

/**
 * Extract a Codex session id from a rollout filename.
 *
 * @param filename - Rollout filename ending in a UUID, for example
 * `rollout-2026-06-27T03-00-00-000Z-019eaa28-8e2d-73a2-840f-a00d6cc8795f.jsonl`
 * @returns Codex UUID from the filename, or null if it is not a rollout file
 */
export function extractCodexAgentIdFromFilename(filename: string): string | null {
  const match = filename.match(/^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/);
  return match?.[1] ?? null;
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
    if (skipPrefixes.includes(segments[i]!.toLowerCase())) {
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
