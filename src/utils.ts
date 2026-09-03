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
  const defaultHome = path.join(os.homedir(), '.codex');
  const envHome = process.env.CODEX_HOME?.trim();
  // Normalize CODEX_HOME to an absolute, canonical path; fall back to the
  // default if it is empty or contains a NUL byte. The recursive session walk
  // is additionally depth-bounded and does not follow symlinked directories
  // (walkCodexSessionFiles), so a redirected CODEX_HOME cannot cause unbounded
  // or cyclic traversal.
  const codexHome =
    envHome && !envHome.includes('\0') ? path.resolve(envHome) : defaultHome;
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
    // AUDIT-OK(no_empty_catch): per-project readdir skip inside a loop over
    // every project dir — one unreadable project directory is expected
    // noise (permissions, races with concurrent writers) and reporting it
    // per-project would be N-noisy for a single caller trying to find one
    // agent file. Callers only care whether the file was found at all.
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

  const scan: ScanObservation = { skipped: 0 };

  // Scan each project directory in parallel
  const scanResults = await Promise.allSettled(
    directories.map(async (folder) => {
      const projectDir = path.join(projectsDir, folder.name);

      const agentFiles: Array<AgentFileLocation & { mtime: number }> = [];

      // Collect agent file paths from both layouts
      const candidateFiles: Array<{ filePath: string; projectDir: string }> = [];

      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(projectDir, { withFileTypes: true });
      } catch (err) {
        recordScanSkip(scan, projectDir, err);
        return agentFiles;
      }

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
            // AUDIT-OK(no_empty_catch): a missing subagents/ dir is the
            // common case — most session dirs never spawn a subagent, so
            // this fires far more often than it signals a real problem.
            // Documented as the expected edge case in the JSDoc above
            // ("Individual project folder scan fails → that project is
            // skipped silently").
          }
        }
      }

      // Get stats for all candidate files in parallel
      const statResults = await Promise.allSettled(
        candidateFiles.map(async ({ filePath, projectDir: pDir }) => {
          try {
            const stats = await fs.promises.stat(filePath);
            return { filePath, projectDir: pDir, mtime: stats.mtimeMs };
          } catch (err) {
            recordScanSkip(scan, filePath, err);
            return null;
          }
        })
      );

      for (const result of statResults) {
        if (result.status === 'fulfilled' && result.value) {
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

  reportScanSkips('findRecentAgentFiles', scan);

  // Sort by modification time (newest first) and limit
  return allAgentFiles
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map(({ filePath, projectDir }) => ({ filePath, projectDir }));
}

function isCodexRolloutFile(filename: string): boolean {
  return filename.startsWith('rollout-') && filename.endsWith('.jsonl');
}

/**
 * Lightweight accumulator for scan-time skip observability. Threaded through
 * a single scan by reference so every skip records once; the caller emits
 * ONE summary line at the end — never per-file — naming the count and the
 * first failing path (precedent: hook.ts's malformedLineCount).
 */
interface ScanObservation {
  skipped: number;
  firstSkipPath?: string;
  firstSkipError?: string;
}

function recordScanSkip(scan: ScanObservation, skipPath: string, err: unknown): void {
  scan.skipped++;
  if (scan.firstSkipPath === undefined) {
    scan.firstSkipPath = skipPath;
    scan.firstSkipError = err instanceof Error ? err.message : String(err);
  }
}

function reportScanSkips(label: string, scan: ScanObservation): void {
  if (scan.skipped === 0) return;
  process.stderr.write(
    `Warning: ${label} skipped ${scan.skipped} unreadable path(s); first: ${scan.firstSkipPath} (${scan.firstSkipError})\n`
  );
}

/**
 * Threshold past which a Codex session scan emits a size notice. This is an
 * OBSERVATION, not a cap (house style: see CODEX_WALK_MAX_DEPTH below) — the
 * scan remains exhaustive by contract regardless of how many files it finds;
 * this only tells an operator that a scan is unusually large, in case a
 * runaway CODEX_HOME warrants investigation.
 */
const CODEX_SCAN_NOTICE_THRESHOLD = 1000;

function reportCodexScan(label: string, filesWalked: number, scan: ScanObservation): void {
  if (filesWalked > CODEX_SCAN_NOTICE_THRESHOLD) {
    process.stderr.write(`Warning: scanning ${filesWalked} Codex session files…\n`);
  }
  reportScanSkips(label, scan);
}

/**
 * Max directory recursion depth for the Codex session walk. Bounds stack usage
 * on pathological trees. Symlinked directories are NOT followed — a Dirent from
 * readdir reports isDirectory() === false for a symlink — so directory cycles
 * cannot form; this cap is defense-in-depth against a very deep real tree.
 */
const CODEX_WALK_MAX_DEPTH = 12;

async function walkCodexSessionFiles(dir: string, scan: ScanObservation): Promise<string[]> {
  // The file accumulator is function-internal (closes 7f75881c): callers get
  // a fresh array from the return value, not a shared buffer threaded through
  // recursive calls as a parameter.
  const files: string[] = [];

  async function walk(currentDir: string, depth: number): Promise<void> {
    if (depth > CODEX_WALK_MAX_DEPTH) return;

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    } catch (err) {
      // depth 0 is the sessions dir itself not existing — the common case
      // when Codex has never been used on this machine; stays silent (same
      // reasoning as the AUDIT-OK precedents elsewhere in this file). A
      // deeper directory failing to read while its siblings are readable is
      // the genuinely unusual case worth surfacing.
      if (depth > 0) {
        recordScanSkip(scan, currentDir, err);
      }
      return;
    }

    await Promise.all(entries.map(async (entry) => {
      const entryPath = path.join(currentDir, entry.name);
      // Only recurse into REAL directories. Dirent.isDirectory() is false for a
      // symlink (readdir reports the link type, not its target), so a symlinked
      // directory — and any cycle it could form — is skipped, not followed.
      if (entry.isDirectory()) {
        await walk(entryPath, depth + 1);
        return;
      }
      if (entry.isFile() && isCodexRolloutFile(entry.name)) {
        files.push(entryPath);
      }
    }));
  }

  await walk(dir, 0);
  return files;
}

/**
 * Read and parse the leading `session_meta` record of a Codex rollout file.
 *
 * @param filePath - Path to the rollout file
 * @param scan - Optional scan-observation accumulator. When provided, a
 *   read failure (open/read) or a JSON.parse failure on the first line is
 *   recorded into it — distinguished from the four shape-mismatch returns
 *   below (empty first line, non-object JSON, wrong `type`, non-object
 *   `payload`), which are all silent: they mean "not a session_meta record
 *   we care about", not "failed to read the file".
 * @returns The `session_meta.payload` object, or null
 */
function readCodexSessionMeta(filePath: string, scan?: ScanObservation): Record<string, unknown> | null {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch (err) {
    if (scan) recordScanSkip(scan, filePath, err);
    return null;
  }
  try {
    let bytesRead: number;
    const buffer = Buffer.alloc(8192);
    try {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    } catch (err) {
      if (scan) recordScanSkip(scan, filePath, err);
      return null;
    }
    const firstLine = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/, 1)[0];
    if (!firstLine) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(firstLine);
    } catch (err) {
      if (scan) recordScanSkip(scan, filePath, err);
      return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    if (record.type !== 'session_meta') return null;
    const payload = record.payload;
    return payload && typeof payload === 'object' ? payload as Record<string, unknown> : null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Find a Codex rollout file by subagent/session id.
 *
 * Searches `$CODEX_HOME/sessions` when `CODEX_HOME` is set, otherwise
 * `~/.codex/sessions`. The filename suffix is checked first, then the
 * `session_meta.payload.id` value is used as a fallback for older or renamed
 * rollout files. This fallback is why the scan is exhaustive by contract:
 * every rollout file under the sessions directory must be considered, not
 * sampled or capped, or a renamed file's id would never be found.
 *
 * @param agentId - Codex UUIDv7 subagent/session id
 * @returns Location of the rollout file, or null if not found
 */
export async function findCodexAgentFile(agentId: string): Promise<AgentFileLocation | null> {
  const sessionsDir = getCodexSessionsDir();
  const filenameSuffix = `-${agentId}.jsonl`;
  const scan: ScanObservation = { skipped: 0 };
  const files = await walkCodexSessionFiles(sessionsDir, scan);

  let result: AgentFileLocation | null = null;
  for (const filePath of files) {
    if (!path.basename(filePath).endsWith(filenameSuffix)) continue;
    const meta = readCodexSessionMeta(filePath, scan);
    const cwd = typeof meta?.cwd === 'string' ? meta.cwd : sessionsDir;
    result = { filePath, projectDir: cwd };
    break;
  }

  if (!result) {
    for (const filePath of files) {
      const meta = readCodexSessionMeta(filePath, scan);
      if (meta?.id === agentId) {
        const cwd = typeof meta.cwd === 'string' ? meta.cwd : sessionsDir;
        result = { filePath, projectDir: cwd };
        break;
      }
    }
  }

  reportCodexScan('findCodexAgentFile', files.length, scan);
  return result;
}

/**
 * Find recent Codex subagent rollout files.
 *
 * Scans Codex session rollout JSONL files and returns only files whose
 * `session_meta.payload.thread_source` is `subagent`. Results are sorted by
 * modification time, newest first. The scan is exhaustive by contract: every
 * rollout file under the sessions directory is read (via readCodexSessionMeta,
 * the same session_meta.payload fallback path used by findCodexAgentFile's id
 * lookup), not sampled or capped.
 *
 * @param limit - Maximum number of files to return (default: 10)
 * @returns Recent Codex subagent rollout locations
 */
export async function findRecentCodexAgentFiles(limit: number = 10): Promise<AgentFileLocation[]> {
  if (limit <= 0) return [];
  const sessionsDir = getCodexSessionsDir();
  const scan: ScanObservation = { skipped: 0 };
  const files = await walkCodexSessionFiles(sessionsDir, scan);
  const candidates: Array<AgentFileLocation & { mtime: number }> = [];

  const stats = await Promise.allSettled(
    files.map(async (filePath) => {
      const meta = readCodexSessionMeta(filePath, scan);
      if (meta?.thread_source !== 'subagent') return null;
      try {
        const stat = await fs.promises.stat(filePath);
        const cwd = typeof meta.cwd === 'string' ? meta.cwd : sessionsDir;
        return { filePath, projectDir: cwd, mtime: stat.mtimeMs };
      } catch (err) {
        recordScanSkip(scan, filePath, err);
        return null;
      }
    })
  );

  for (const result of stats) {
    if (result.status === 'fulfilled' && result.value) {
      candidates.push(result.value);
    }
  }

  reportCodexScan('findRecentCodexAgentFiles', files.length, scan);

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
