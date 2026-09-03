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
import { debug, warn } from './logger.js';
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
 * Strip control characters (including newlines that would split JSONL lines)
 * and cap length at 64 before a value is persisted to the buffer. This is the
 * single line-safety path shared by agent_type (parseHookInput) and the run
 * token (handleHook) — belt-and-suspenders for the run token, whose regex
 * character class already excludes ']' and control chars.
 */
export function sanitizeLineSafe(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 64);
}

/**
 * Parse and validate hook input from stdin.
 * Returns a Partial<HookInput> — callers must handle missing fields.
 */
export function parseHookInput(parsed: unknown): Partial<HookInput> {
  if (!parsed || typeof parsed !== 'object') return {};
  const obj = parsed as Record<string, unknown>; // safe: guarded by typeof check above
  const result: Partial<HookInput> = {};

  if (typeof obj.session_id === 'string') result.session_id = obj.session_id;
  if (typeof obj.cwd === 'string') result.cwd = obj.cwd;
  if (typeof obj.transcript_path === 'string') result.transcript_path = obj.transcript_path;
  if (typeof obj.agent_transcript_path === 'string') result.agent_transcript_path = obj.agent_transcript_path;
  if (typeof obj.agent_id === 'string') result.agent_id = obj.agent_id;
  if (typeof obj.agent_type === 'string') {
    // Strip control characters (including newlines that would split JSONL lines)
    // and cap length before persisting to the buffer.
    const cleaned = sanitizeLineSafe(obj.agent_type);
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
// Absolute ceiling on total read time, independent of the idle timer above.
// The idle timer only resolves the never-received-anything case (it keeps
// rescheduling as long as data keeps arriving); a peer that sends a partial
// chunk and then stalls mid-stream — without ever hitting 'end', 'error', or
// another 'data' event — would otherwise hang readStdin (and the hook)
// indefinitely. This timer fires regardless of activity.
const STDIN_HARD_DEADLINE_MS = 5000;
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

  let malformedLineCount = 0;

  // Reports the malformed-line count exactly once, on whichever exit path is
  // taken. Extracted because the loop below can exit via an early `return`
  // (a valid user message was found) as well as by running out of lines —
  // a check placed only after the loop would silently never fire on the
  // early-return path, undercounting the common case (malformed lines
  // followed by the actual user message).
  const reportMalformedIfAny = (): void => {
    if (malformedLineCount > 0) {
      warn('Skipped malformed transcript lines while looking for the first user message', {
        transcript_path: expandedPath,
        skipped_line_count: malformedLineCount,
      });
    }
  };

  try {
    for await (const line of rl) {
      try {
        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== 'object') continue;
        const data = parsed as { type?: unknown; message?: { content?: unknown } }; // safe: guarded by typeof check above

        // Return content of first user message (the task prompt)
        if (data.type === 'user' && data.message?.content) {
          reportMalformedIfAny();
          return typeof data.message.content === 'string'
            ? data.message.content
            : JSON.stringify(data.message.content);
        }
      } catch {
        // Expected: transcript lines may be truncated or malformed; skip and continue
        malformedLineCount++;
      }
    }
    reportMalformedIfAny();
  } catch (err) {
    // This read runs at SubagentStop, i.e. after the agent has already
    // stopped — it is not racing a lock held during agent execution.
    // Realistic causes are a disappeared/rotated file, EACCES, EMFILE, or a
    // transcript truncated mid-stream. Without this log, a genuine read
    // failure is indistinguishable from "no [agent:] tag in this
    // transcript" — both would otherwise return null silently.
    warn('Failed to read transcript while looking for the first user message', {
      transcript_path: expandedPath,
      error: err instanceof Error ? err.message : String(err),
    });
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
 * Pattern for explicit run tag: [run:token]
 *
 * Minted by an orchestrator (e.g. the pdl-executor skill) and emitted in the
 * first user message of every agent prompt in a run, alongside [agent:name].
 * Its own namespace/grammar: identifiers, not names — a leading digit is
 * permitted (a wider grammar than EXPLICIT_AGENT_TAG_PATTERN, since a token
 * segment may begin with a hex/numeric char, e.g. a session-id prefix). Total
 * length 3–64 (leading char + {2,63}). Line-safe by construction: the character
 * class excludes ']' (which would close the tag early) and control chars (which
 * would split JSONL lines), so the regex cannot capture either — but the
 * extracted value is still passed through the same \x00-\x1f\x7f strip + 64-slice
 * as agent_type before persistence, keeping one line-safety code path.
 *
 * See docs/decisions/0004-run-scoped-attribution.md for the rationale.
 */
export const RUN_TAG_PATTERN = /\[run:([a-z0-9][a-z0-9-]{2,63})\]/i;

/**
 * Extract the run token from an explicit `[run:token]` tag in content.
 *
 * @param content - The text content to search
 * @returns The extracted run token (lowercased), or null if no tag found
 */
export function extractRunTag(content: string): string | null {
  const match = content.match(RUN_TAG_PATTERN);
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * Detect the run token from the first user message in a transcript.
 *
 * Convenience helper mirroring detectAgentName for symmetry/testing. The hot
 * path in handleHook uses the single-read form (getFirstUserMessageContent
 * called once, then both extractors applied) so the transcript is read exactly
 * once; this helper is for callers that only want the run token.
 *
 * @param transcriptPath - Path to the agent transcript file (may start with ~)
 * @returns The tagged run token, or null if no tag is present
 */
export async function detectRunToken(transcriptPath: string): Promise<string | null> {
  const content = await getFirstUserMessageContent(transcriptPath);
  if (!content) {
    return null;
  }
  return extractRunTag(content);
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
 * Main hook handler.
 *
 * @param input - Parsed hook input.
 * @param deps.readFirstMessage - Injectable transcript reader (defaults to
 *   getFirstUserMessageContent). Exists so tests can assert the first user
 *   message is read EXACTLY ONCE even though both the agent name and the run
 *   token are extracted from it (the single-read invariant, spec §2.2).
 * @param deps.appendToBuffer - Injectable buffer writer (defaults to
 *   appendToBuffer). Exists so tests can force the lock-contention/null-return
 *   path (issue c3234628) without racing a real lock file.
 */
export async function handleHook(
  input: Partial<HookInput>,
  deps: {
    readFirstMessage?: typeof getFirstUserMessageContent;
    appendToBuffer?: typeof appendToBuffer;
  } = {}
): Promise<HookOutput> {
  const readFirstMessage = deps.readFirstMessage ?? getFirstUserMessageContent;
  const doAppendToBuffer = deps.appendToBuffer ?? appendToBuffer;
  try {
    // Use agent_transcript_path (new field) or fall back to transcript_path
    const transcriptPath = input.agent_transcript_path || input.transcript_path;

    // Validate required fields
    if (!transcriptPath) {
      return { decision: 'approve' };
    }

    const expandedPath = transcriptPath.replace(/^~/, os.homedir());

    // Validate path is under ~/.claude/ to prevent reading arbitrary files.
    // Resolve symlinks with realpath (not just path.resolve, which only
    // normalizes '..' as a string and does NOT follow links) so a symlink
    // planted inside ~/.claude cannot escape containment (CWE-61). Both sides
    // are realpath-resolved in case ~/.claude itself is a symlink. realpathSync
    // throws if the path does not exist / is unreadable — treat that as
    // "nothing to capture" and approve, same as the existsSync check below.
    let realPath: string;
    let realClaudeDir: string;
    try {
      realClaudeDir = fs.realpathSync(path.join(os.homedir(), '.claude'));
      realPath = fs.realpathSync(expandedPath);
    } catch {
      return { decision: 'approve' };
    }
    if (realPath !== realClaudeDir && !realPath.startsWith(realClaudeDir + path.sep)) {
      console.error(`[agent-metrics] Transcript path outside ~/.claude/: ${realPath}`);
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

    // Read from the realpath-resolved path (not expandedPath) for the metrics
    // extraction and the first-message read below. realPath was verified to be
    // inside ~/.claude above; reusing it collapses the check and the use onto
    // one resolved path, closing the TOCTOU window a post-check symlink swap
    // would otherwise open (CWE-367). realpathSync also already confirmed the
    // path exists, so the prior existsSync check is redundant and removed.
    const metrics = await extractMetricsFromFile(realPath);

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

    // Read the first user message ONCE, then extract both the agent name and
    // the run token from it. Both signals ride the same channel (the first
    // user message), so a single read serves both — no second transcript read.
    // Uses the verified realPath (see TOCTOU note above), not expandedPath.
    const firstMsg = await readFirstMessage(realPath);

    // Resolve agent name: explicit [agent:name] tag (workflow-emitted intent)
    // wins over the harness-reported agent_type, which wins over nameless.
    const agentName =
      (firstMsg && extractExplicitAgentTag(firstMsg)) || input.agent_type || null;

    // Resolve run token: explicit [run:token] tag minted by the orchestrator.
    // Absent when the prompt carried no [run:] tag (same absence semantics as
    // a missing [agent:name]). Passed through the shared line-safety path.
    const rawRunId = firstMsg ? extractRunTag(firstMsg) : null;
    const runId = rawRunId ? sanitizeLineSafe(rawRunId) : null;

    // Write to buffer. A null return means appendToBuffer skipped the write
    // under lock contention (buffer.ts already wrote its own "Could not
    // acquire lock … skipping" warning) — do not follow it with a
    // capture-success summary, which would claim a capture that didn't
    // happen. TODO: if the null-vs-throw contention convention (84d49989)
    // later flips appendToBuffer to throwing LockAcquisitionError instead of
    // returning null, this becomes a `catch (LockAcquisitionError)` around
    // the call below rather than a null check.
    const appended = doAppendToBuffer(metrics, {
      agentName: agentName || undefined,
      projectPath: input.cwd,
      runId: runId || undefined,
      source: 'hook',
    });

    if (appended !== null) {
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
    }

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
export async function readStdin(
  stream?: NodeJS.ReadableStream,
  hardDeadlineMs: number = STDIN_HARD_DEADLINE_MS
): Promise<string> {
  const src = stream ?? process.stdin;
  return new Promise((resolve) => {
    let data = '';
    let resolved = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;

    const done = (value: string): void => {
      if (resolved) return;
      resolved = true;
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      clearTimeout(deadlineTimer);
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

    // Absolute ceiling, started once at promise construction and independent
    // of the idle timer: a stalled partial write (data flowing, then silence
    // with no 'end'/'error') keeps rescheduling the idle timer forever and
    // would otherwise never resolve. On fire, resolve with whatever has
    // accumulated so far — matching the 'end' handler's fallback — so a
    // genuinely truncated payload fails diagnostically in main()'s JSON.parse
    // rather than hanging the hook.
    const deadlineTimer = setTimeout(() => {
      process.stderr.write(
        `[agent-metrics] stdin read exceeded ${hardDeadlineMs}ms hard deadline with ${Buffer.byteLength(data)} bytes accumulated; proceeding with partial data\n`
      );
      done(data || '{}');
    }, hardDeadlineMs);

    if (src === process.stdin) src.setEncoding('utf8');
    src.on('data', (chunk) => {
      // done() only flips `resolved` and returns early on later calls — it
      // does not stop this handler from running, so without this guard every
      // remaining chunk of an adversarial payload still gets appended to
      // `data` and re-scanned by Buffer.byteLength for the rest of the
      // stream. The 1MB cap below then only bounds resolution latency, not
      // memory: `data` keeps growing unboundedly after the cap has already
      // fired.
      if (resolved) return;

      const chunkStr = chunk instanceof Buffer ? chunk.toString('utf8') : chunk;
      if (Buffer.byteLength(data) + Buffer.byteLength(chunkStr) > MAX_STDIN_BYTES) {
        process.stderr.write(
          `[agent-metrics] stdin exceeded ${MAX_STDIN_BYTES} bytes; discarding payload\n`
        );
        done('{}');
        return;
      }

      data += chunkStr;
      scheduleIdleTimeout();
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
