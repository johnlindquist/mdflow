/**
 * Zod schemas for frontmatter and config validation
 * Minimal validation - most keys pass through to the command
 */

import { z } from "zod";

/** Coerce any primitive value to string (for env vars where YAML may parse as bool/number) */
const stringCoerce = z.union([z.string(), z.number(), z.boolean()]).transform(v => String(v));
const formInputKeySchema = z
  .string()
  .regex(/^_.+/, "Input keys in _inputs object format must start with '_'")
  .describe("Underscore-prefixed template variable key");

// ============================================================================
// Input Definition Schema (for form-style prompts)
// ============================================================================

/**
 * Input definition schema for typed prompts
 * Validates input type and associated options
 */
const inputDefinitionBaseSchema = z.object({
  description: z.string().optional(),
  required: z.boolean().optional(),
}).strict();

const inputDefinitionSchema = z.discriminatedUnion("type", [
  inputDefinitionBaseSchema.extend({
    type: z.literal("text"),
    default: z.string().optional(),
  }),
  inputDefinitionBaseSchema.extend({
    type: z.literal("select"),
    options: z.array(z.string()).min(1, "Select type requires 'options' array with at least one item"),
    default: z.string().optional(),
  }),
  inputDefinitionBaseSchema.extend({
    type: z.literal("number"),
    default: z.number().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
  inputDefinitionBaseSchema.extend({
    type: z.literal("confirm"),
    default: z.boolean().optional(),
  }),
  inputDefinitionBaseSchema.extend({
    type: z.literal("password"),
    default: z.string().optional(),
  }),
]);

/**
 * Form inputs schema - either legacy string array or new object format
 */
const formInputsSchema = z.union([
  z.array(z.string()),
  z.record(formInputKeySchema, inputDefinitionSchema),
]);

export type InputDefinitionSchema = z.infer<typeof inputDefinitionSchema>;

/**
 * Result of non-throwing schema parsing helpers.
 */
export type SafeParseResult<T> =
  | { success: true; data: T }
  | { success: false; errors: string[] };

// ============================================================================
// Config Schema (for ~/.mdflow/config.yaml and project configs)
// ============================================================================

/**
 * Command defaults schema - allows any key that becomes a CLI flag
 * Special keys:
 * - $1, $2, etc.: Positional argument mappings
 * - context_window: Token limit override (number)
 * - All other keys: CLI flag values (string, number, boolean, array)
 */
const commandDefaultsSchema = z.record(
  z.string(),
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.union([z.string(), z.number(), z.boolean()])),
  ])
).describe("Command-specific default flags");

/**
 * Global config schema for config.yaml files
 * Structure:
 * ```yaml
 * commands:
 *   claude:
 *     model: sonnet
 *     print: true
 *   gemini:
 *     model: pro
 * ```
 */
export const globalConfigSchema = z.object({
  engine: z.string().min(1).optional(),
  commands: z.record(z.string(), commandDefaultsSchema).optional(),
}).strict().describe("Global mdflow configuration");

/** Type inferred from config schema */
export type GlobalConfigSchema = z.infer<typeof globalConfigSchema>;

/**
 * Validate config.yaml content.
 *
 * @param data - Parsed config object from YAML/JSON.
 * @returns Strongly typed config object when valid.
 * @throws Error with detailed message if validation fails
 */
export function validateConfig(data: unknown): GlobalConfigSchema {
  const result = globalConfigSchema.safeParse(data);

  if (!result.success) {
    const errors = formatZodIssues(result.error.issues);
    throw new Error(`Invalid config.yaml:\n  ${errors.join("\n  ")}`);
  }

  return result.data;
}

/**
 * Validate config without throwing.
 *
 * @param data - Parsed config object from YAML/JSON.
 * @returns Discriminated result containing either validated data or errors.
 */
export function safeParseConfig(data: unknown): SafeParseResult<GlobalConfigSchema> {
  const result = globalConfigSchema.safeParse(data);

  if (result.success) {
    return { success: true, data: result.data };
  }

  const errors = formatZodIssues(result.error.issues);
  return { success: false, errors };
}

// ============================================================================
// Frontmatter Schema (for agent .md files)
// ============================================================================

/** Main frontmatter schema - minimal, passthrough everything else */
export const frontmatterSchema = z.object({
  // Form inputs - either legacy string array or new object format with typed definitions
  _inputs: formInputsSchema.optional(),

  // Environment variables (underscore-prefixed system key)
  // Object form sets process.env
  _env: z.record(z.string(), stringCoerce).optional(),

  // Isolation mode: strip the engine's ambient context (adapter-translated)
  _isolated: z.boolean().optional(),

  // System prompt override / append (adapter-translated per engine)
  "_system-prompt": z.string().optional(),
  "_append-system-prompt": z.union([z.string(), z.array(z.string())]).optional(),
}).passthrough(); // Allow all other keys - they become CLI flags (including $1, $2, etc.)

/** Type inferred from schema */
export type FrontmatterSchema = z.infer<typeof frontmatterSchema>;

/**
 * Format zod issues into readable error strings
 */
function formatZodIssues(issues: Array<{ path: PropertyKey[]; message: string }>): string[] {
  return issues.map(issue => {
    const path = issue.path.map(String).join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}

/**
 * Validate parsed YAML against frontmatter schema.
 *
 * @param data - Parsed frontmatter object from YAML.
 * @returns Strongly typed frontmatter object when valid.
 */
export function validateFrontmatter(data: unknown): FrontmatterSchema {
  const result = frontmatterSchema.safeParse(data);

  if (!result.success) {
    const errors = formatZodIssues(result.error.issues);
    throw new Error(`Invalid frontmatter:\n  ${errors.join("\n  ")}`);
  }

  return result.data;
}

/**
 * Validate frontmatter without throwing.
 *
 * @param data - Parsed frontmatter object from YAML.
 * @returns Discriminated result containing either validated data or errors.
 */
export function safeParseFrontmatter(data: unknown): SafeParseResult<FrontmatterSchema> {
  const result = frontmatterSchema.safeParse(data);

  if (result.success) {
    return { success: true, data: result.data };
  }

  const errors = formatZodIssues(result.error.issues);
  return { success: false, errors };
}
