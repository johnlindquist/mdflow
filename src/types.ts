import type { HarnessName } from "./harnesses/types";

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
  "permission-mode"?: "acceptEdits" | "bypassPermissions" | "default" | "dontAsk" | "plan";
  "mcp-config"?: string | string[];
  "strict-mcp-config"?: boolean;
  "allowed-tools"?: string;
  "disallowed-tools"?: string;
  "system-prompt"?: string;
  "append-system-prompt"?: string;
  betas?: string[];
  "fork-session"?: boolean;
  ide?: boolean;
  /** Passthrough: any flag not explicitly defined */
  [key: string]: unknown;
}

/** Codex-specific configuration */
export interface CodexConfig {
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  approval?: "untrusted" | "on-failure" | "on-request" | "never";
  "full-auto"?: boolean;
  oss?: boolean;
  "local-provider"?: "lmstudio" | "ollama" | string;
  cd?: string;
  search?: boolean;
  image?: string | string[];
  profile?: string;
  /** Passthrough: any flag not explicitly defined */
  [key: string]: unknown;
}

/** Copilot-specific configuration */
export interface CopilotConfig {
  agent?: string;
  /** Suppress session metadata/stats (default: true in our impl) */
  silent?: boolean;
  "allow-all-paths"?: boolean;
  stream?: "on" | "off";
  banner?: boolean;
  "no-color"?: boolean;
  "no-custom-instructions"?: boolean;
  "log-level"?: "none" | "error" | "warning" | "info" | "debug" | "all" | "default";
  /** Passthrough: any flag not explicitly defined */
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
  "screen-reader"?: boolean;
  /** Passthrough: any flag not explicitly defined */
  [key: string]: unknown;
}

/** Tool permission configuration */
export interface ToolsConfig {
  /** Tools to allow without confirmation */
  allow?: string | string[];
  /** Tools to deny (takes precedence over allow) */
  deny?: string | string[];
}

/** Session management configuration */
export interface SessionConfig {
  /** Resume session: true = latest, string = session ID */
  resume?: string | boolean;
  /** Fork the session (create new ID when resuming) */
  fork?: boolean;
}

/** Universal frontmatter that maps to all backends */
export interface AgentFrontmatter {
  // --- Harness Selection ---
  harness?: HarnessName | "auto";  // Default: auto

  // --- Identity ---
  model?: string;  // Maps to --model on all backends

  // --- Execution Mode ---
  /**
   * Interactive mode: true = REPL (default), false = run once and exit
   * Maps to: -p (Claude), exec (Codex), positional (Gemini), -p (Copilot)
   */
  interactive?: boolean;

  // --- Session Management ---
  /**
   * Session configuration (preferred)
   * @example session: { resume: true }
   * @example session: { resume: "abc123", fork: true }
   */
  session?: SessionConfig;
  /** @deprecated Use session.resume instead */
  resume?: string | boolean;
  /** @deprecated Use session: { resume: true } instead */
  continue?: boolean;

  // --- Approval Mode ---
  /**
   * Approval mode for tool execution:
   * - "ask": Prompt before running tools (default)
   * - "sandbox": Auto-approve but sandboxed where supported (Codex --full-auto)
   * - "yolo": Bypass all approvals (dangerous)
   *
   * Maps to:
   * - Claude: ask=default, sandbox=default, yolo=--dangerously-skip-permissions
   * - Codex: ask=untrusted, sandbox=--full-auto, yolo=--dangerously-bypass-approvals-and-sandbox
   * - Gemini: ask=default, sandbox=default, yolo=--yolo
   * - Copilot: ask=default, sandbox=default, yolo=--allow-all-tools
   */
  approval?: "ask" | "sandbox" | "yolo";
  /** @deprecated Use approval: "yolo" instead */
  "allow-all-tools"?: boolean;

  // --- Tool Permissions ---
  /**
   * Tool whitelist/blacklist (preferred nested form)
   * @example tools: { allow: ["read", "write"], deny: ["shell"] }
   */
  tools?: ToolsConfig;
  /** @deprecated Use tools.allow instead */
  "allow-tool"?: string | string[];
  /** @deprecated Use tools.deny instead */
  "deny-tool"?: string | string[];

  // --- Path Permissions ---
  "allow-all-paths"?: boolean;
  /**
   * Additional directories for tool access (preferred)
   * @example dirs: ["./src", "./tests"]
   */
  dirs?: string | string[];
  /** @deprecated Use dirs instead */
  "add-dir"?: string | string[];

  // --- MCP Configuration ---
  /** MCP server configs (paths or JSON) */
  "mcp-config"?: string | string[];

  // --- Output Control ---
  /**
   * Output format (preferred)
   * @example output: "json"
   */
  output?: "text" | "json" | "stream-json";
  /** @deprecated Use output instead */
  "output-format"?: "text" | "json" | "stream-json";

  // --- Debug ---
  /** Enable debug mode (boolean or filter string) */
  debug?: boolean | string;

  // --- Wizard Mode ---
  inputs?: InputField[];

  // --- Context ---
  context?: string | string[];  // Glob patterns for files to include


  // --- Output Extraction ---
  extract?: "json" | "code" | "markdown" | "raw";  // Output extraction mode

  // --- Caching ---
  cache?: boolean;  // Enable result caching

  // --- Prerequisites ---
  requires?: Prerequisites;


  // --- Backend Specific Config (Escape Hatches) ---
  claude?: ClaudeConfig;
  codex?: CodexConfig;
  copilot?: CopilotConfig;
  gemini?: GeminiConfig;

  /**
   * Passthrough: any flag not explicitly defined above.
   * These get passed through to the runner if they look like CLI flags.
   * This allows using any runner flag directly in frontmatter even if
   * we haven't mapped it to a universal key yet.
   *
   * Example: If you set `yolo: true` it passes through as --yolo to the runner.
   */
  [key: string]: unknown;
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
