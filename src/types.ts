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

/**
 * Frontmatter keys for underscore-prefixed system/template fields.
 * Examples: `_inputs`, `_env`, `_name`, `_target`.
 */
export type FrontmatterSystemKey = `_${string}`;

/**
 * Frontmatter keys for positional argument mappings.
 * Examples: `$1`, `$2`, `$10`.
 */
export type FrontmatterPositionalKey = `$${number}`;

/**
 * Values supported in YAML frontmatter/config payloads.
 * Keeps passthrough keys typed without falling back to `any`.
 */
export type FrontmatterValue =
  | string
  | number
  | boolean
  | null
  | FrontmatterValue[]
  | { [key: string]: FrontmatterValue }
  | undefined;

type InputDefinitionBase = {
  /** Description/help text shown to user */
  description?: string;
  /** Whether the input is required (defaults to true) */
  required?: boolean;
};

type TextInputDefinition = InputDefinitionBase & {
  /** Type of input prompt to display */
  type: "text";
  /** Default value for text input */
  default?: string;
};

type SelectInputDefinition = InputDefinitionBase & {
  /** Type of input prompt to display */
  type: "select";
  /** Options for select type */
  options: string[];
  /** Default selected option */
  default?: string;
};

type NumberInputDefinition = InputDefinitionBase & {
  /** Type of input prompt to display */
  type: "number";
  /** Default numeric value */
  default?: number;
  /** Minimum value for number type */
  min?: number;
  /** Maximum value for number type */
  max?: number;
};

type ConfirmInputDefinition = InputDefinitionBase & {
  /** Type of input prompt to display */
  type: "confirm";
  /** Default confirmation state */
  default?: boolean;
};

type PasswordInputDefinition = InputDefinitionBase & {
  /** Type of input prompt to display */
  type: "password";
  /** Optional default value (rarely used) */
  default?: string;
};

/**
 * Input definition for form-style prompts.
 * Discriminated by `type` so each prompt variant has type-safe fields.
 */
export type InputDefinition =
  | TextInputDefinition
  | SelectInputDefinition
  | NumberInputDefinition
  | ConfirmInputDefinition
  | PasswordInputDefinition;

/**
 * Form inputs schema - maps variable names to their input definitions
 * Example:
 * ```yaml
 * _inputs:
 *   _name:
 *     type: text
 *     description: "Enter your name"
 *     default: "World"
 *   _env:
 *     type: select
 *     options: [dev, staging, prod]
 * ```
 */
export type FormInputs = Record<FrontmatterSystemKey, InputDefinition>;

/** Frontmatter configuration - keys become CLI flags */
export interface AgentFrontmatter {
  /**
   * Form inputs schema for interactive prompts
   * Can be either:
   * - Simple array of strings (legacy): ["_name", "_value"]
   * - Object with input definitions (new): { _name: { type: "text", ... } }
   */
  _inputs?: string[] | FormInputs;

  /**
   * Environment variables to set in process.env before execution.
   * Uses underscore prefix to avoid namespace collision with CLI --env flags.
   */
  _env?: Record<string, string>;

  /**
   * Context window limit override (in tokens)
   * If set, overrides the model-based default context limit
   * Useful for custom models or when you want to enforce a specific limit
   * Note: This is a system key and is NOT passed as a CLI flag.
   */
  context_window?: number;

  /**
   * Positional argument mapping ($1, $2, etc.)
   * Maps positional arguments to CLI flags
   * Example: $1: prompt → body becomes --prompt <body>
   */
  [key: FrontmatterPositionalKey]: string;

  /**
   * Template variables (_varname)
   * Underscore-prefixed keys are template variables, not passed to CLI.
   * Available in body as {{ _varname }}, can be overridden via --_varname CLI flag.
   * Example: _name: "default" → {{ _name }} in body → --_name "override"
   * Note: Also includes system keys like _inputs (string[]) and _env (Record<string, string>)
   */
  [key: FrontmatterSystemKey]: FrontmatterValue;

  /**
   * All other keys are passed directly as CLI flags to the command.
   * - String values: --key value
   * - Boolean true: --key
   * - Boolean false: (omitted)
   * - Arrays: --key value1 --key value2
   */
  [key: string]: FrontmatterValue;
}

/**
 * Parsed markdown content split into frontmatter and body.
 */
export interface ParsedMarkdown {
  frontmatter: AgentFrontmatter;
  body: string;
}

/**
 * Result from command execution.
 */
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
  [key: FrontmatterPositionalKey]: string;
  /**
   * Context window limit override (in tokens)
   * Overrides model-based defaults for token limit calculations
   */
  context_window?: number;
  /** Default flag values */
  [key: string]: FrontmatterValue;
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

/**
 * Tool adapter interface for decoupling tool-specific logic
 *
 * Each adapter defines how a specific CLI tool (claude, copilot, gemini, etc.)
 * should be configured and how to transform between print and interactive modes.
 *
 * Adding support for a new tool only requires creating a new adapter file.
 */
export interface ToolAdapter {
  /** The tool name this adapter handles (e.g., "claude", "copilot") */
  name: string;

  /**
   * Default configuration for print mode (non-interactive)
   * These defaults are applied when no user config overrides them
   */
  getDefaults(): CommandDefaults;

  /**
   * Transform frontmatter for interactive mode
   * Called when _interactive is enabled (via flag or .i. filename marker)
   *
   * @param frontmatter - The frontmatter after defaults are applied
   * @returns Transformed frontmatter for interactive mode
   */
  applyInteractiveMode(frontmatter: AgentFrontmatter): AgentFrontmatter;
}
