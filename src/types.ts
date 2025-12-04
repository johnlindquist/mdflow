export interface CopilotFrontmatter {
  before?: string | string[];
  after?: string | string[];
  model?:
  | "claude-sonnet-4.5"
  | "claude-haiku-4.5"
  | "claude-opus-4.5"
  | "claude-sonnet-4"
  | "gpt-5"
  | "gpt-5.1"
  | "gpt-5.1-codex-mini"
  | "gpt-5.1-codex"
  | "gpt-5-mini"
  | "gpt-4.1"
  | "gemini-3-pro-preview";
  agent?: string;
  silent?: boolean;
  interactive?: boolean;
  "allow-all-tools"?: boolean;
  "allow-all-paths"?: boolean;
  "allow-tool"?: string;
  "deny-tool"?: string;
  "add-dir"?: string;
}

export interface ParsedMarkdown {
  frontmatter: CopilotFrontmatter;
  body: string;
}

export interface CommandResult {
  command: string;
  output: string;
  exitCode: number;
}

/** @deprecated Use CommandResult instead */
export type PreCommandResult = CommandResult;
