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
  /** Effective total: input + cache_creation + output (excludes cheap cache reads) */
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
}

/**
 * Complete metrics extracted from an agent session file
 */
export interface AgentMetrics {
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
  git_branch: string;
  /** Working directory during execution */
  cwd: string;
  /** Claude Code version */
  claude_code_version: string;
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

  // Tokens
  /** Token usage breakdown */
  tokens: TokenMetrics;

  // Execution
  /** Execution statistics */
  execution: ExecutionMetrics;
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
  slug: string;
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
 * Type predicate for ToolUseBlock
 */
export function isToolUseBlock(block: unknown): block is ToolUseBlock {
  return block != null && typeof block === 'object' && (block as Record<string, unknown>).type === 'tool_use';
}

/**
 * Output format options for the extract command
 */
export type ExtractFormat = 'json' | 'summary' | 'tracker';

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
