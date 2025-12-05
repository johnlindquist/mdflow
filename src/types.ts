import type { RunnerName } from "./runners/types";

/** Input field definition for wizard mode */
export interface InputField {
  name: string;
  type: "text" | "confirm" | "select" | "password";
  message: string;
  default?: string | boolean;
  choices?: string[];  // For select type
}

/** Prerequisites for script execution */
export interface Prerequisites {
  bin?: string[];   // Required binaries
  env?: string[];   // Required environment variables
}

/** Claude-specific configuration */
export interface ClaudeConfig {
  "dangerously-skip-permissions"?: boolean;
  "mcp-config"?: string | string[];
  "allowed-tools"?: string;
  [key: string]: unknown;
}

/** Codex-specific configuration */
export interface CodexConfig {
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  approval?: "untrusted" | "on-failure" | "on-request" | "never";
  "full-auto"?: boolean;
  oss?: boolean;
  "local-provider"?: string;
  cd?: string;
  [key: string]: unknown;
}

/** Copilot-specific configuration (legacy) */
export interface CopilotConfig {
  agent?: string;
  [key: string]: unknown;
}

/** Gemini-specific configuration */
export interface GeminiConfig {
  sandbox?: boolean;
  yolo?: boolean;
  "approval-mode"?: "default" | "auto_edit" | "yolo";
  "allowed-tools"?: string | string[];
  extensions?: string | string[];
  resume?: string;
  "allowed-mcp-server-names"?: string | string[];
  [key: string]: unknown;
}

/** Universal frontmatter that maps to all backends */
export interface AgentFrontmatter {
  // --- Runner Selection ---
  runner?: RunnerName | "auto";  // Default: auto

  // --- Identity ---
  model?: string;  // Maps to --model on all backends

  // --- Modes ---
  silent?: boolean;        // Script mode (non-interactive output)
  interactive?: boolean;   // Force TTY session

  // --- Permissions (Universal) ---
  "allow-all-tools"?: boolean;  // Maps to "God Mode" flags
  "allow-all-paths"?: boolean;
  "allow-tool"?: string;
  "deny-tool"?: string;
  "add-dir"?: string | string[];  // Maps to native --add-dir if supported

  // --- Wizard Mode ---
  inputs?: InputField[];

  // --- Context ---
  context?: string | string[];  // Glob patterns for files to include

  // --- Output ---
  extract?: "json" | "code" | "markdown" | "raw";  // Output extraction mode

  // --- Caching ---
  cache?: boolean;  // Enable result caching

  // --- Prerequisites ---
  requires?: Prerequisites;

  // --- Hooks ---
  before?: string | string[];
  after?: string | string[];

  // --- Backend Specific Config (Escape Hatches) ---
  claude?: ClaudeConfig;
  codex?: CodexConfig;
  copilot?: CopilotConfig;
  gemini?: GeminiConfig;
}

/** @deprecated Use AgentFrontmatter instead */
export type CopilotFrontmatter = AgentFrontmatter;

export interface ParsedMarkdown {
  frontmatter: AgentFrontmatter;
  body: string;
}

export interface CommandResult {
  command: string;
  output: string;
  exitCode: number;
}

/** @deprecated Use CommandResult instead */
export type PreCommandResult = CommandResult;
