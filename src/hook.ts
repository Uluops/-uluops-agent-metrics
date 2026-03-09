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
import { formatModelName } from './utils.js';

interface HookInput {
  session_id: string;
  transcript_path?: string;
  agent_id?: string;
  agent_transcript_path?: string;
  cwd: string;
  hook_event_name?: string;
  permission_mode?: string;
  stop_hook_active?: boolean;
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
 * Agent pattern entry: [regex pattern, canonical agent name]
 *
 * ORDERING: Patterns are matched in order. More specific patterns should come
 * before general ones to ensure correct matching. For example, "code-auditor"
 * must come before "code-validator" since both contain "code".
 */
export type AgentPattern = readonly [RegExp, string];

/**
 * Known agent patterns for auto-detection from task prompts.
 *
 * ## Ordering Rationale
 *
 * Patterns are matched in array order - the FIRST match wins. This means:
 * - More specific patterns MUST come before less specific ones
 * - "code-auditor" must precede "code-validator" (both contain "code")
 * - "prompt-pattern" must precede "prompt-engineer" (both contain "prompt")
 *
 * If ordering is wrong, a prompt mentioning "code-auditor" would incorrectly
 * match "code-validator" first.
 *
 * ## Categories (in order)
 *
 * 1. Code quality (auditor → optimizer → validator)
 * 2. Security/API
 * 3. Frontend/Publishing
 * 4. Prompt/ADL (pattern → quality → engineer)
 * 5. Infrastructure
 * 6. Domain-specific
 */
export const AGENT_PATTERNS: readonly AgentPattern[] = [
  // Code quality - ordered by specificity
  [/code.?auditor/i, 'code-auditor'],
  [/code.?optimizer/i, 'code-optimizer'],
  [/code.?validator/i, 'code-validator'],
  [/test.?architect/i, 'test-architect'],
  [/type.?safety/i, 'type-safety-validator'],

  // Security and API
  [/security.?analyst/i, 'security-analyst'],
  [/api.?contract/i, 'api-contract-validator'],
  [/mcp.?validator/i, 'mcp-validator'],

  // Frontend
  [/frontend.?validator/i, 'frontend-validator'],
  [/public.?interface/i, 'public-interface-validator'],
  [/dx.?validator/i, 'dx-validator'],
  [/release.?readiness/i, 'release-readiness'],

  // Prompt and ADL - ordered by specificity
  [/prompt.?pattern/i, 'prompt-pattern-analyzer'],
  [/prompt.?quality/i, 'prompt-quality-validator'],
  [/prompt.?engineer/i, 'prompt-engineer'],
  [/adl.?meta/i, 'adl-meta-validator'],

  // Infrastructure
  [/docker.?validator/i, 'docker-validator'],
  [/kubernetes.?validator/i, 'kubernetes-validator'],
  [/sql.?validator/i, 'sql-validator'],
  [/python.?validator/i, 'python-validator'],
  [/websocket.?validator/i, 'websocket-validator'],

  // Domain-specific
  [/data.?science/i, 'data-science'],
  [/ml.?algorithm/i, 'ml-algorithms'],
] as const;

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
  return match ? match[1] : null;
}

/**
 * Match content against validator patterns.
 * Returns the first matching validator name, or null if no match.
 *
 * @param content - The text content to search
 * @param patterns - Agent patterns to match against (uses AGENT_PATTERNS if not provided)
 * @returns The matched validator name, or null
 */
export function matchAgentPattern(
  content: string,
  patterns: readonly AgentPattern[] = AGENT_PATTERNS
): string | null {
  for (const [pattern, name] of patterns) {
    if (pattern.test(content)) {
      return name;
    }
  }
  return null;
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
        const data = JSON.parse(line);

        // Return content of first user message (the task prompt)
        if (data.type === 'user' && data.message?.content) {
          return typeof data.message.content === 'string'
            ? data.message.content
            : JSON.stringify(data.message.content);
        }
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    // Error reading file
  } finally {
    rl.close();
    fileStream.destroy();
  }

  return null;
}

/**
 * Pattern for explicit agent tag: [agent:name] or [validator:name] (legacy)
 * This is the highest-priority detection method, used by workflow commands
 * to explicitly declare which agent is being invoked.
 *
 * Example: "[agent:code-validator] Validate code quality..."
 */
export const EXPLICIT_AGENT_TAG_PATTERN = /\[(?:agent|validator):([a-z][a-z0-9-]*)\]/i;

/**
 * Extract agent name from explicit tag in content.
 * Looks for pattern: [agent:name] or [validator:name] (legacy)
 *
 * @param content - The text content to search
 * @returns The extracted validator name, or null if no tag found
 */
export function extractExplicitAgentTag(content: string): string | null {
  const match = content.match(EXPLICIT_AGENT_TAG_PATTERN);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Detect validator name from the first user message in transcript.
 * Uses two-tier detection:
 * 1. Explicit tag: [agent:name] or [validator:name] (highest priority)
 * 2. Pattern matching: AGENT_PATTERNS (fallback)
 *
 * @param transcriptPath - Path to the agent transcript file (may start with ~)
 * @returns The detected validator name, or null if not found
 */
export async function detectAgentName(transcriptPath: string): Promise<string | null> {
  const content = await getFirstUserMessageContent(transcriptPath);
  if (!content) {
    return null;
  }

  // First try explicit tag (highest priority)
  const explicitName = extractExplicitAgentTag(content);
  if (explicitName) {
    return explicitName;
  }

  // Fall back to pattern matching
  return matchAgentPattern(content);
}

/**
 * Main hook handler
 */
async function handleHook(input: HookInput): Promise<HookOutput> {
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

    // Try to detect validator name
    const agentName = await detectAgentName(expandedPath);

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
async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    let resolved = false;

    const done = (value: string): void => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
      if (Buffer.byteLength(data) > MAX_STDIN_BYTES) {
        done('{}');
      }
    });
    process.stdin.on('end', () => {
      done(data || '{}');
    });
    process.stdin.on('error', () => {
      done('{}');
    });

    // Handle case where stdin is empty or closed (e.g., piped empty input)
    setTimeout(() => {
      done(data || '{}');
    }, STDIN_READ_TIMEOUT_MS);
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
    const input: HookInput = (parsed && typeof parsed === 'object') ? parsed as HookInput : {} as HookInput;

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
