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
 * Examples: `_inputs`, `_env`, `_output`, `_steps`, `_name`, `_target`.
 */
export type ReservedFrontmatterSystemKey =
  | "_inputs"
  | "_env"
  | "_output"
  | "_interactive"
  | "_i"
  | "_cwd"
  | "_subcommand"
  | "_dry-run"
  | "_edit"
  | "_trust"
  | "_no-cache"
  | "_no-menu"
  | "_command"
  | "_c"
  | "_steps"
  | "_workflow"
  | "_context_budget_tokens"
  | "_max_prompt_tokens"
  | "_max_runtime_ms"
  | "_mdflow_version"
  | "_flow_id"
  | "_compat"
  | "_isolated"
  | "_system-prompt"
  | "_append-system-prompt";

export type FrontmatterSystemKey = ReservedFrontmatterSystemKey | `_${string}`;

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

/**
 * Structured output behavior for post-command processing.
 */
export interface StructuredOutputConfig extends Record<string, FrontmatterValue> {
  /** Expected output format for extraction */
  format?: "json" | "text" | "patch";
  /** Optional schema ref in `<path>#<ExportName>` format */
  schema?: string;
  /** Optional path to save extracted output */
  save?: string;
  /** Whether to apply extracted output as a patch via git apply */
  apply?: boolean;
}

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
   * Structured output processing config.
   * Runs extraction -> optional schema validation -> sink actions.
   */
  _output?: StructuredOutputConfig;

  /**
   * Multi-step workflow definition.
   * When present, mdflow executes `_steps` as a dependency graph instead of
   * running a single prompt body once.
   */
  _steps?: FrontmatterValue[];

  /**
   * Optional token budget for context providers (@git:diff, @tree, etc.).
   * When set, provider output is truncated/summarized to fit this budget.
   */
  _context_budget_tokens?: number;

  /**
   * Maximum allowed prompt token estimate before execution.
   * If estimated prompt tokens exceed this limit, execution is blocked.
   */
  _max_prompt_tokens?: number;

  /**
   * Maximum allowed runtime in milliseconds.
   * Used for telemetry budget enforcement checks.
   */
  _max_runtime_ms?: number;

  /**
   * Isolation is ON BY DEFAULT: every flow runs with the engine's ambient
   * context stripped (skills, MCP servers, memory/context files, plugins,
   * session persistence — whatever the engine exposes flags for), translated
   * per engine by the adapter's getIsolationDefaults(). Set `false` to opt
   * back into ambient context; set `true` explicitly to also surface a
   * warning on engines with no isolation controls (droid, cursor-agent,
   * agy), which otherwise run ambient silently.
   */
  _isolated?: boolean;

  /**
   * Replace the engine's default system prompt. Translated per engine
   * (claude/pi: --system-prompt; codex: model_instructions_file; gemini:
   * GEMINI_SYSTEM_MD). Engines with no supported mechanism fail the run
   * rather than silently ignoring the key.
   */
  "_system-prompt"?: string;

  /**
   * Append to the engine's default system prompt. String or list of strings.
   * Translated per engine (claude/pi: --append-system-prompt; codex:
   * developer_instructions). Unsupported engines fail the run.
   */
  "_append-system-prompt"?: string | string[];

  /**
   * mdflow version this flow was created with. Stamped automatically by
   * `md create` / `md init`; never passed as a CLI flag.
   */
  _mdflow_version?: string;

  /** Stable flow identity used by feedback and verification receipts. */
  _flow_id?: string;

  /**
   * Newest mdflow version verified to run this flow successfully. Stamped
   * automatically after clean runs; never passed as a CLI flag.
   */
  _compat?: string;

  /** Proposal-first evolution policy. Legacy `auto` maps to `mode: propose`. */
  evolve?:
    | "auto"
    | "off"
    | "observe"
    | "suggest"
    | "propose"
    | "apply"
    | {
        mode?: "off" | "observe" | "suggest" | "propose" | "apply";
        triggers?: Array<"explicit-feedback" | "classified-failure" | "quick-rerun">;
        maintainer?: { engine?: string; model?: string; "timeout-ms"?: number };
        budget?: { "max-invocations"?: number; "max-per-day"?: number; "cooldown-ms"?: number };
        gate?: { "require-feedback-eval"?: boolean; "allow-capability-delta"?: boolean; repetitions?: number };
        apply?: "review" | "automatic";
      };

  /**
   * Engine (agent CLI) that executes this flow, e.g. "claude", "codex", "pi".
   * v3 system key — replaces the deprecated `tool:`/`_tool:` aliases and is
   * never passed as a CLI flag. When absent, the resolution ladder applies
   * (env var, filename, config, then the built-in default).
   */
  engine?: string;

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
   * Note: Also includes system keys like _inputs, _env, _output, _steps,
   * _context_budget_tokens, _max_prompt_tokens, and _max_runtime_ms.
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
  /**
   * Default engine for flows that don't name one via filename or frontmatter.
   * Project config (mdflow.config.yaml / .mdflow.yaml / .mdflow.json) beats
   * ~/.mdflow/config.yaml; the built-in default applies when neither sets it.
   */
  engine?: string;

  /** Default settings per command */
  commands?: Record<string, CommandDefaults>;
  /** Default proposal-first evolution policy; flow frontmatter overrides it. */
  evolve?: FrontmatterValue;
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

  /**
   * Optional: contribute environment variables to the engine process, called
   * once just before spawn. Adapter vars never override an existing
   * process.env value or explicit run env (e.g. frontmatter _env).
   * Used by the pi adapter to point PI_CODING_AGENT_DIR at the bridged,
   * context-isolated agent dir.
   */
  prepareEnv?(): Record<string, string> | undefined;

  /**
   * Optional: flags that strip the engine's ambient context (skills, MCP,
   * memory/context files, plugins, session persistence). Isolation is ON BY
   * DEFAULT — these apply to every run unless the flow opts out with
   * `_isolated: false`. Layered after config defaults, before frontmatter,
   * so a flow can still re-enable one layer (e.g. `safe-mode: false`).
   * Absent = the engine has no isolation controls; it runs ambient, and an
   * explicit `_isolated: true` triggers a stderr warning.
   *
   * Only list flags verified against the engine's own --help/source; a
   * guessed flag breaks every flow on that engine.
   */
  getIsolationDefaults?(): CommandDefaults;

  /**
   * Optional: translate the canonical `_system-prompt` /
   * `_append-system-prompt` keys into engine-native configuration. Absent =
   * the engine has no supported mechanism and the run FAILS (a silently
   * dropped system prompt would change flow behavior).
   *
   * `writeTempFile` is injected so engines that need a file on disk (gemini
   * GEMINI_SYSTEM_MD, codex model_instructions_file) stay testable; callers
   * own the temp lifecycle.
   */
  applySystemPrompt?(
    spec: SystemPromptSpec,
    writeTempFile: (content: string) => string
  ): SystemPromptTranslation;

  /**
   * Optional: translate a discovered flow hooks file (`<flow>.hooks.ts`) into
   * engine-native lifecycle-hook configuration. Absent = the engine has no
   * verified hook mechanism and a flow WITH a hooks file FAILS the run (a
   * silently dropped hook would be a different flow; `_hooks: false` opts
   * out). Only add a translation verified against the engine's own
   * config/docs — codex is verified via `-c hooks={…}` inline overrides plus
   * `--dangerously-bypass-hook-trust`.
   */
  applyHooks?(spec: HooksSpec): HooksTranslation;
}

/**
 * Canonical lifecycle-hooks request: one executable hooks file plus the
 * canonical events it declared via the `--mdflow-list-events` contract.
 * Event names are mdflow-canonical (camelCase); adapters own the mapping to
 * engine-native names.
 */
export interface HooksSpec {
  /** Absolute path to the executable hooks file. */
  hooksFile: string;
  /** Canonical events the file handles (validated, non-empty). */
  events: string[];
  /**
   * Whether the run is context-isolated. Adapters may require isolation for
   * hooks (codex does: its trust bypass is only safe against a prepared
   * home, which replaces ambient context anyway).
   */
  isolated: boolean;
  /**
   * False on passive surfaces (explain, dry-run): the translation must be
   * PURE — compute the same flags/env a real run would use, but perform no
   * filesystem preparation (no prepared-home writes). Defaults to true.
   */
  prepareEnvironment?: boolean;
}

/**
 * Engine-native translation of a HooksSpec. Same merge semantics as
 * SystemPromptTranslation: array values concat, scalars override, env merges
 * into `_env` and wins.
 */
export interface HooksTranslation {
  frontmatter?: Record<string, FrontmatterValue>;
  env?: Record<string, string>;
}

/**
 * Canonical system prompt request extracted from `_system-prompt` /
 * `_append-system-prompt` (frontmatter or CLI).
 */
export interface SystemPromptSpec {
  /** Full replacement for the engine's default system prompt. */
  replace?: string;
  /** Segments appended to the engine's default system prompt. */
  append?: string[];
}

/**
 * Engine-native translation of a SystemPromptSpec.
 */
export interface SystemPromptTranslation {
  /**
   * Frontmatter fragment to merge (keys become CLI flags via the normal
   * pipeline). Array values concat with existing arrays; scalars override.
   */
  frontmatter?: Record<string, FrontmatterValue>;
  /**
   * Env vars to set on the engine process (merged into _env; wins over an
   * existing _env key because `_system-prompt` is the more specific intent).
   */
  env?: Record<string, string>;
}

/**
 * Portable adapter capability flags.
 * Used by the portable agent spec translation layer.
 */
export interface AdapterCapabilities {
  /** Whether canonical `model` key is supported */
  model: boolean;
  /** Whether canonical `temperature` key is supported */
  temperature: boolean;
  /** Whether canonical `max-tokens` key is supported */
  maxTokens: boolean;
}

/**
 * Adapter interface for provider-agnostic frontmatter translation.
 *
 * This adapter layer maps canonical keys (model, temperature, max-tokens)
 * to provider-specific CLI flags before argument construction.
 */
export interface Adapter {
  /** Tool/provider name (e.g., "claude", "codex") */
  name: string;
  /** Declares canonical key support for this provider */
  capabilities: AdapterCapabilities;

  /**
   * Normalize/canonicalize frontmatter before building args.
   * Example: convert max_tokens/maxTokens to max-tokens.
   */
  normalizeFrontmatter(frontmatter: AgentFrontmatter): AgentFrontmatter;

  /**
   * Build CLI args for this provider from normalized frontmatter.
   *
   * `buildGenericArgs` is provided by command.ts and applies generic
   * key/value -> flag conversion for all non-system keys.
   */
  buildArgs(
    frontmatter: AgentFrontmatter,
    templateVars: Set<string>,
    buildGenericArgs: (frontmatter: AgentFrontmatter, templateVars: Set<string>) => string[]
  ): string[];
}
