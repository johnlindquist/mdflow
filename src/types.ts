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
