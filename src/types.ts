/**
 * IO Streams abstraction for testable stdin/stdout handling
 */
export interface IOStreams {
  /** Input stream (null if not piped/TTY mode) */
  stdin: NodeJS.ReadableStream | null;
  /** Output stream for command results */
  stdout: NodeJS.WritableStream;
  /** Error stream for status messages */
  stderr: NodeJS.WritableStream;
  /** Whether stdin is from a TTY (interactive mode) */
  isTTY: boolean;
}

/** Frontmatter configuration - keys become CLI flags */
export interface AgentFrontmatter {
  /** Named positional arguments to consume from CLI and map to template vars */
  args?: string[];

  /**
   * Environment variables (polymorphic):
   * - Object { KEY: "VAL" }: Sets process.env before execution
   * - Array ["KEY=VAL"] or String "KEY=VAL": Passes as --env flags to command
   */
  env?: Record<string, string> | string[] | string;

  /**
   * Context window limit override (in tokens)
   * If set, overrides the model-based default context limit
   * Useful for custom models or when you want to enforce a specific limit
   */
  context_window?: number;

  /**
   * Positional argument mapping ($1, $2, etc.)
   * Maps positional arguments to CLI flags
   * Example: $1: prompt → body becomes --prompt <body>
   */
  [key: `$${number}`]: string;

  /**
   * Named template variables ($varname)
   * Reads value from --varname CLI flag and makes it available as {{ varname }}
   * Example: $feature_name: → reads --feature_name value → {{ feature_name }}
   */
  [key: `$${string}`]: string | undefined;

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

/**
 * Structured execution plan returned by dry-run mode
 *
 * Provides complete introspection of what would be executed,
 * enabling direct testing without parsing stdout.
 */
export interface ExecutionPlan {
  /** Type of result: dry-run shows plan, executed shows result, error shows failure */
  type: "dry-run" | "executed" | "error";
  /** The final prompt after all processing (imports, templates, stdin) */
  finalPrompt: string;
  /** The command that would be executed (e.g., "claude", "gemini") */
  command: string;
  /** CLI arguments built from frontmatter and passthrough */
  args: string[];
  /** Environment variables from frontmatter */
  env: Record<string, string>;
  /** Estimated token count for the final prompt */
  estimatedTokens: number;
  /** The parsed and merged frontmatter configuration */
  frontmatter: AgentFrontmatter;
  /** List of files that were imported/resolved (relative paths) */
  resolvedImports: string[];
  /** Template variables that were substituted */
  templateVars: Record<string, string>;
  /** Positional mappings from frontmatter ($1, $2, etc.) */
  positionalMappings: Record<number, string>;
}

/**
 * Logger interface for structured logging
 * Compatible with pino Logger but allows for custom implementations
 */
export interface Logger {
  debug(obj: object, msg?: string): void;
  debug(msg: string): void;
  info(obj: object, msg?: string): void;
  info(msg: string): void;
  warn(obj: object, msg?: string): void;
  warn(msg: string): void;
  error(obj: object, msg?: string): void;
  error(msg: string): void;
  child(bindings: Record<string, unknown>): Logger;
  level: string;
}

/**
 * Global configuration structure for mdflow
 */
export interface GlobalConfig {
  /** Default settings per command */
  commands?: Record<string, CommandDefaults>;
}

/**
 * Command-specific defaults
 * Keys starting with $ are positional mappings
 * Other keys are default flags
 */
export interface CommandDefaults {
  /** Map positional arg N to a flag (e.g., $1: "prompt" → --prompt <body>) */
  [key: `$${number}`]: string;
  /**
   * Context window limit override (in tokens)
   * Overrides model-based defaults for token limit calculations
   */
  context_window?: number;
  /** Default flag values */
  [key: string]: unknown;
}

/**
 * RunContext - Encapsulates all runtime dependencies
 *
 * This replaces global state (module-level singletons) with an explicit
 * context object that can be passed through the call chain. This enables:
 * - Complete test isolation (parallel tests don't interfere)
 * - Custom loggers/configs per test
 * - Easier mocking and dependency injection
 */
export interface RunContext {
  /** Logger instance for this run */
  logger: Logger;
  /** Global configuration */
  config: GlobalConfig;
  /** Environment variables (replaces process.env access) */
  env: Record<string, string | undefined>;
  /** Current working directory (replaces process.cwd()) */
  cwd: string;
}

/**
 * Options for creating a RunContext
 */
export interface RunContextOptions {
  /** Custom logger (defaults to silent logger) */
  logger?: Logger;
  /** Custom config (defaults to built-in defaults) */
  config?: GlobalConfig;
  /** Custom environment (defaults to process.env) */
  env?: Record<string, string | undefined>;
  /** Custom working directory (defaults to process.cwd()) */
  cwd?: string;
}
