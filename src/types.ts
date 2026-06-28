/**
 * Agent Metrics Types
 *
 * Type definitions for extracting metrics from Claude Code agent session files.
 */

/**
 * Token usage breakdown from a single API message
 */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

/**
 * Aggregated token metrics across all messages in an agent session
 */
export interface TokenMetrics {
  /** Base input tokens (non-cached) */
  input: number;
  /** Output tokens generated */
  output: number;
  /** Tokens used to create cache entries */
  cache_creation: number;
  /** Tokens read from cache (cheap) */
  cache_read: number;
  /** Cached input tokens reported by Codex (OpenAI cached input). Subtracted in total_effective — the analog of Claude's excluded cache_read. */
  cached_input?: number;
  /** Reasoning output tokens (OpenAI/Codex). A subset of GROSS output — stored, NOT added to total_effective (it's already inside output). */
  reasoning_output?: number;
  /** Thinking tokens (Google/Gemini). A subset of GROSS output — stored, NOT added to total_effective. Populated by the future Gemini provider. */
  thinking?: number;
  /** Tool-call tokens reported as a component of output. A subset of GROSS output — stored, NOT added to total_effective. */
  tool?: number;
  /** Canonical effective total: (input − cached_input) + output_gross + cache_creation. reasoning/thinking/tool are subsets of output and are never added. */
  total_effective: number;
  /** Raw total: all tokens summed */
  total_raw: number;
}

/**
 * Tool usage statistics
 */
export interface ToolBreakdown {
  [toolName: string]: number;
}

/**
 * Execution statistics for an agent run
 */
export interface ExecutionMetrics {
  /** Total number of messages/lines in the JSONL file */
  message_count: number;
  /** Number of tool invocations */
  tool_use_count: number;
  /** Breakdown of tool usage by tool name */
  tool_breakdown: ToolBreakdown;
  /** Number of failed tool calls */
  error_count: number;
  /** Number of Codex reasoning response records */
  reasoning_record_count?: number;
}

/**
 * Complete metrics extracted from an agent session file
 */
export interface AgentMetrics {
  /**
   * Producing harness/runtime that emitted this record. Canonical vocabulary §2.4
   * (renamed from `provider` in v0.6.0; 'claude' → 'claude-code'). The `provider`
   * dispatch *option* on ExtractOptions is unrelated and unchanged.
   */
  harness: 'claude-code' | 'codex';
  // Identification
  /** Unique agent identifier (e.g., "ac51171") */
  agent_id: string;
  /** Parent session UUID */
  session_id: string;
  /** Human-readable session name */
  slug: string;

  // Context
  /** Model used (e.g., "claude-sonnet-4-5-20250929") */
  model: string;
  /** Git branch at execution time */
  git_branch?: string;
  /** Working directory during execution */
  cwd: string;
  /** Claude Code version */
  claude_code_version?: string;
  /** Codex CLI version */
  codex_cli_version?: string;
  /** Model provider reported by Codex */
  model_provider?: string;
  /** Codex parent thread id. Same value as session_id in this release. */
  parent_thread_id?: string;
  /** Prompt ID — shared by all agents spawned from the same user message (workflow grouping key) */
  prompt_id: string | null;

  // Timing
  /** Start time in ISO 8601 format */
  start_time: string;
  /** End time in ISO 8601 format */
  end_time: string;
  /** Duration in milliseconds */
  duration_ms: number;
  /** Human-readable duration (e.g., "4m 39s") */
  duration_formatted: string;
  /** Time to first token for providers that expose it */
  time_to_first_token_ms?: number;

  // Tokens
  /** Token usage breakdown */
  tokens: TokenMetrics;

  // Execution
  /** Execution statistics */
  execution: ExecutionMetrics;
  /** Final provider-reported message, when available */
  final_message?: string;
}

/**
 * Raw message structure from Claude Code JSONL files
 */
export interface RawAgentMessage {
  parentUuid: string | null;
  isSidechain: boolean;
  userType: string;
  cwd: string;
  sessionId: string;
  version: string;
  gitBranch: string;
  agentId: string;
  slug?: string;
  type: 'user' | 'assistant' | 'tool_result';
  message?: {
    role: string;
    content: unknown[];
    model?: string;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  toolUseResult?: {
    is_error?: boolean;
    content?: unknown;
  };
  uuid: string;
  timestamp: string;
  requestId?: string;
  promptId?: string;
}

/**
 * Content block types in assistant messages
 */
export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

/** Text content block in assistant messages */
export interface TextBlock {
  type: 'text';
  text: string;
}

/** Thinking/reasoning content block in assistant messages */
export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
}

/** Union of known content block types, plus a catch-all for unknown block types (e.g. future API additions) */
export type ContentBlock = ToolUseBlock | TextBlock | ThinkingBlock | { type: string };

/**
 * Type predicate for `ToolUseBlock` content blocks.
 *
 * @param block - Unknown content block to inspect
 * @returns True when the block has `type: "tool_use"`
 */
export function isToolUseBlock(block: unknown): block is ToolUseBlock {
  return block != null && typeof block === 'object' && (block as Record<string, unknown>).type === 'tool_use';
}

/**
 * Output format options for the extract command
 */
export type ExtractFormat = 'json' | 'summary' | 'tracker';

/**
 * Metrics provider selection.
 */
export type MetricsProvider = 'claude' | 'codex' | 'auto';

/**
 * Output format options for buffer commands
 */
export type BufferFormat = 'table' | 'json' | 'tracker';

/**
 * Options for the extract function
 */
export interface ExtractOptions {
  /** Override project path (auto-detected if not provided) */
  projectPath?: string;
  /** Metrics provider to read from. Defaults to shape-based auto dispatch. */
  provider?: MetricsProvider;
}

/**
 * Result of finding an agent file
 */
export interface AgentFileLocation {
  /** Full path to the agent JSONL file */
  filePath: string;
  /** Project directory the file was found in */
  projectDir: string;
}
