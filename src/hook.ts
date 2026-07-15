#!/usr/bin/env node
/**
 * SubagentStop Hook - Auto-capture agent metrics
 *
 * This script is called by Claude Code's SubagentStop hook.
 * It extracts metrics from the agent's transcript and writes to the global buffer.
 *
 * Usage (configured in Claude Code hooks):
 *   Hook receives JSON on stdin with transcript_path
 *
 * Input (stdin):
 *   {
 *     "session_id": "abc123",
 *     "agent_id": "a80e24f",
 *     "agent_transcript_path": "~/.claude/projects/.../agent-a80e24f.jsonl",
 *     "cwd": "/path/to/project"
 *   }
 *
 * Output (stdout):
 *   { "decision": "approve" }  // Always approve, we're just capturing metrics
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { extractMetricsFromFile } from './extractor.js';
import { appendToBuffer } from './buffer.js';
import { debug } from './logger.js';
import { formatModelName } from './utils.js';

interface HookInput {
  session_id: string;
  transcript_path?: string;
  agent_id?: string;
  agent_transcript_path?: string;
  /**
   * Subagent type reported by Claude Code (e.g. "code-validator").
   * Not guaranteed present — observed in docs-adjacent sources for CC 2.1.x
   * but unverified against the official hooks reference. Parsed defensively;
   * the payload-keys debug log in main() confirms empirically per capture.
   */
  agent_type?: string;
  cwd: string;
  hook_event_name?: string;
  permission_mode?: string;
  stop_hook_active?: boolean;
}

/**
 * Parse and validate hook input from stdin.
 * Returns a Partial<HookInput> — callers must handle missing fields.
 */
export function parseHookInput(parsed: unknown): Partial<HookInput> {
  if (!parsed || typeof parsed !== 'object') return {};
  const obj = parsed as Record<string, unknown>;
  const result: Partial<HookInput> = {};

  if (typeof obj.session_id === 'string') result.session_id = obj.session_id;
  if (typeof obj.cwd === 'string') result.cwd = obj.cwd;
  if (typeof obj.transcript_path === 'string') result.transcript_path = obj.transcript_path;
  if (typeof obj.agent_transcript_path === 'string') result.agent_transcript_path = obj.agent_transcript_path;
  if (typeof obj.agent_id === 'string') result.agent_id = obj.agent_id;
  if (typeof obj.agent_type === 'string') {
    // Strip control characters (including newlines that would split JSONL lines)
    // and cap length before persisting to the buffer.
    const cleaned = obj.agent_type.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 64);
    if (cleaned.length > 0) result.agent_type = cleaned;
  }

  return result;
}

interface HookOutput {
  decision: 'approve' | 'block';
  reason?: string;
  systemMessage?: string;  // Shown to user as warning per Claude Code docs
}

/**
 * Configuration constants
 */
const STDIN_READ_TIMEOUT_MS = 100; // Timeout for reading stdin when no data received
const MAX_STDIN_BYTES = 1 * 1024 * 1024; // 1MB max stdin to prevent memory exhaustion

/** Valid agent ID pattern: lowercase hex string */
export const AGENT_ID_PATTERN = /^[a-f0-9]+$/;

/**
 * Validate that a string is a valid agent ID format.
 *
 * @param agentId - The agent ID to validate
 * @returns true if valid, false otherwise
 */
export function isValidAgentId(agentId: string): boolean {
  return AGENT_ID_PATTERN.test(agentId);
}

/**
 * Extract agent ID from transcript path
 * e.g., "~/.claude/projects/.../agent-a80e24f.jsonl" -> "a80e24f"
 */
export function extractAgentIdFromPath(transcriptPath: string): string | null {
  const filename = path.basename(transcriptPath);
  const match = filename.match(/^agent-([a-f0-9]+)\.jsonl$/);
  return match?.[1] ?? null;
}

/**
 * Read the first user message content from a transcript file.
 *
 * @param transcriptPath - Path to the agent transcript file (may start with ~)
 * @returns The content of the first user message, or null if not found
 */
export async function getFirstUserMessageContent(transcriptPath: string): Promise<string | null> {
  const expandedPath = transcriptPath.replace(/^~/, os.homedir());

  if (!fs.existsSync(expandedPath)) {
    return null;
  }

  const fileStream = fs.createReadStream(expandedPath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  try {
    for await (const line of rl) {
      try {
        const data = JSON.parse(line) as { type?: unknown; message?: { content?: unknown } };

        // Return content of first user message (the task prompt)
        if (data.type === 'user' && data.message?.content) {
          return typeof data.message.content === 'string'
            ? data.message.content
            : JSON.stringify(data.message.content);
        }
      } catch {
        // Expected: transcript lines may be truncated or malformed; skip and continue
      }
    }
  } catch {
    // Expected: file may be locked or unreadable during agent execution; return null
  } finally {
    rl.close();
    fileStream.destroy();
  }

  return null;
}

/**
 * Pattern for explicit agent tag: [agent:name]
 *
 * The tag is the sole detection signal; workflow commands emit it on every
 * agent invocation. Direct user invocations may include it manually.
 *
 * Example: "[agent:code-validator] Validate code quality..."
 */
export const EXPLICIT_AGENT_TAG_PATTERN = /\[agent:([a-z][a-z0-9-]*)\]/i;

/**
 * Extract agent name from an explicit `[agent:name]` tag in content.
 *
 * @param content - The text content to search
 * @returns The extracted agent name (lowercased), or null if no tag found
 */
export function extractExplicitAgentTag(content: string): string | null {
  const match = content.match(EXPLICIT_AGENT_TAG_PATTERN);
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * Detect agent name from the first user message in transcript.
 *
 * Detection is explicit-tag-only: the first user message must contain
 * `[agent:name]`. Untagged invocations return null and the consumer falls
 * back to the project name or agent ID.
 *
 * See docs/decisions/0001-explicit-tag-detection.md for the rationale.
 *
 * @param transcriptPath - Path to the agent transcript file (may start with ~)
 * @returns The tagged agent name, or null if no tag is present
 */
export async function detectAgentName(transcriptPath: string): Promise<string | null> {
  const content = await getFirstUserMessageContent(transcriptPath);
  if (!content) {
    return null;
  }
  return extractExplicitAgentTag(content);
}

/**
 * Main hook handler
 */
async function handleHook(input: Partial<HookInput>): Promise<HookOutput> {
  try {
    // Use agent_transcript_path (new field) or fall back to transcript_path
    const transcriptPath = input.agent_transcript_path || input.transcript_path;

    // Validate required fields
    if (!transcriptPath) {
      return { decision: 'approve' };
    }

    const expandedPath = transcriptPath.replace(/^~/, os.homedir());

    // Validate path is under ~/.claude/ to prevent reading arbitrary files
    const claudeDir = path.join(os.homedir(), '.claude');
    const resolvedPath = path.resolve(expandedPath);
    if (!resolvedPath.startsWith(claudeDir + path.sep)) {
      console.error(`[agent-metrics] Transcript path outside ~/.claude/: ${resolvedPath}`);
      return { decision: 'approve' };
    }

    // Use agent_id if provided, otherwise extract from path
    const agentId = input.agent_id || extractAgentIdFromPath(transcriptPath);
    if (!agentId) {
      // Not an agent file, just approve and continue
      return { decision: 'approve' };
    }

    // Validate agent ID format to prevent invalid IDs from propagating downstream
    if (!isValidAgentId(agentId)) {
      console.error(`[agent-metrics] Invalid agent ID format: ${agentId}`);
      return { decision: 'approve' };
    }

    // Check if file exists
    if (!fs.existsSync(expandedPath)) {
      return { decision: 'approve' };
    }

    // Extract metrics
    const metrics = await extractMetricsFromFile(expandedPath);

    // Enforce the join-key invariant at the persistence boundary: the id
    // persisted as metrics.agent_id (the downstream provenance join key)
    // must be the pattern-validated id gated above — not whatever string the
    // transcript's first message happened to carry. The two derive from the
    // same source today; this makes the guarantee hold by construction.
    if (metrics.agent_id !== agentId) {
      console.error(
        `[agent-metrics] Transcript agent id "${metrics.agent_id}" != validated id "${agentId}"; persisting validated id`
      );
      metrics.agent_id = agentId;
    }

    // Resolve agent name: explicit [agent:name] tag (workflow-emitted intent)
    // wins over the harness-reported agent_type, which wins over nameless.
    const agentName = (await detectAgentName(expandedPath)) || input.agent_type || null;

    // Write to buffer
    appendToBuffer(metrics, {
      agentName: agentName || undefined,
      projectPath: input.cwd,
      source: 'hook',
    });

    // Build summary components
    const modelShort = formatModelName(metrics.model);
    const tokensK = (metrics.tokens.total_effective / 1000).toFixed(1);
    const toolCount = metrics.execution.tool_use_count;
    const toolSummary = toolCount > 0
      ? `${toolCount} tool${toolCount !== 1 ? 's' : ''}`
      : 'no tools';
    const name = agentName || agentId;

    // Build summary line
    const summary = `[${name}] ${modelShort} | ${metrics.duration_formatted} | ${tokensK}k tokens | ${toolSummary}`;

    // Output to stderr for visibility
    console.error(summary);

    return {
      decision: 'approve',
    };
  } catch (error) {
    // Log error but don't block - format consistently
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[agent-metrics] Error capturing metrics: ${errorMessage}`);
    return { decision: 'approve' };
  }
}

/**
 * Read hook input from stdin
 */
export async function readStdin(stream?: NodeJS.ReadableStream): Promise<string> {
  const src = stream ?? process.stdin;
  return new Promise((resolve) => {
    let data = '';
    let resolved = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;

    const done = (value: string): void => {
      if (resolved) return;
      resolved = true;
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      resolve(value);
    };

    const scheduleIdleTimeout = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      // Only fire idle timeout to resolve empty when no data has arrived yet.
      // Once data is flowing, resolution comes from 'end' or MAX_STDIN_BYTES.
      idleTimer = setTimeout(() => {
        if (data === '') done('{}');
      }, STDIN_READ_TIMEOUT_MS);
    };

    if (src === process.stdin) src.setEncoding('utf8');
    src.on('data', (chunk) => {
      data += chunk instanceof Buffer ? chunk.toString('utf8') : chunk;
      scheduleIdleTimeout();
      if (Buffer.byteLength(data) > MAX_STDIN_BYTES) {
        done('{}');
      }
    });
    src.on('end', () => {
      done(data || '{}');
    });
    src.on('error', () => {
      done('{}');
    });

    // Handle case where stdin is empty or closed (e.g., piped empty input)
    scheduleIdleTimeout();
  });
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  try {
    // Read input from stdin
    const inputData = await readStdin();
    const parsed: unknown = JSON.parse(inputData || '{}');

    // Log payload key names (keys only, never values) so the actually-delivered
    // SubagentStop fields are empirically observable — agent_type is documented
    // inconsistently across Claude Code versions.
    if (parsed && typeof parsed === 'object') {
      debug('SubagentStop payload keys', { keys: Object.keys(parsed) });
    }

    const input = parseHookInput(parsed);

    // Handle the hook
    const output = await handleHook(input);

    // Write output to stdout
    console.log(JSON.stringify(output));
  } catch (error) {
    // On any error, approve to not block the agent - format consistently
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[agent-metrics] Hook error: ${errorMessage}`);
    console.log(JSON.stringify({ decision: 'approve' }));
  }
}

// Run if called directly (not when imported as a module for testing)
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename || process.argv[1]?.endsWith('/hook.js')) {
  main().catch(() => process.exit(1));
}
