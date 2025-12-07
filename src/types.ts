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

/** Frontmatter configuration - keys become CLI flags */
export interface AgentFrontmatter {
  /** Command to execute (e.g., claude, codex, gemini) */
  command?: string;

  /** Wizard mode inputs - collect values interactively */
  inputs?: InputField[];

  /** Context globs - files to include in prompt */
  context?: string | string[];

  /** Prerequisites to check before running */
  requires?: Prerequisites;

  /** Enable result caching */
  cache?: boolean;

  /**
   * All other keys are passed directly as CLI flags to the command.
   * - String values: --key value
   * - Boolean true: --key
   * - Boolean false: (omitted)
   * - Arrays: --key value1 --key value2
   */
  [key: string]: unknown;
}

export interface ParsedMarkdown {
  frontmatter: AgentFrontmatter;
  body: string;
}

export interface CommandResult {
  command: string;
  output: string;
  exitCode: number;
}
