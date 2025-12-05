/**
 * Zod schemas for frontmatter validation
 * Provides type safety and helpful error messages
 */

import { z } from "zod";

/** Input field types for wizard mode */
const inputTypeSchema = z.enum(["text", "confirm", "select", "password"]);

/** Single input field definition */
export const inputFieldSchema = z.object({
  name: z.string().min(1, "Input name is required"),
  type: inputTypeSchema,
  message: z.string().min(1, "Input message is required"),
  default: z.union([z.string(), z.boolean()]).optional(),
  choices: z.array(z.string()).optional(),
}).refine(
  (data) => {
    if (data.type === "select" && (!data.choices || data.choices.length === 0)) {
      return false;
    }
    return true;
  },
  { message: "Select inputs require a non-empty choices array" }
);

/** Runner selection */
const runnerSchema = z.enum(["claude", "codex", "copilot", "gemini", "auto"]).optional();

/** Supported AI models (flexible string to support all backends) */
const modelSchema = z.string().optional();

/** Output extraction modes */
const extractModeSchema = z.enum(["json", "code", "markdown", "raw"]).optional();

/** String or array of strings */
const stringOrArraySchema = z.union([
  z.string(),
  z.array(z.string()),
]).optional();

/** Claude-specific config */
const claudeConfigSchema = z.object({
  "dangerously-skip-permissions": z.boolean().optional(),
  "mcp-config": stringOrArraySchema,
  "allowed-tools": z.string().optional(),
}).passthrough().optional();

/** Codex-specific config */
const codexConfigSchema = z.object({
  sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
  approval: z.enum(["untrusted", "on-failure", "on-request", "never"]).optional(),
  "full-auto": z.boolean().optional(),
  oss: z.boolean().optional(),
  "local-provider": z.string().optional(),
  cd: z.string().optional(),
}).passthrough().optional();

/** Copilot-specific config (legacy) */
const copilotConfigSchema = z.object({
  agent: z.string().optional(),
}).passthrough().optional();

/** Gemini-specific config */
const geminiConfigSchema = z.object({
  sandbox: z.boolean().optional(),
  yolo: z.boolean().optional(),
  "approval-mode": z.enum(["default", "auto_edit", "yolo"]).optional(),
  "allowed-tools": stringOrArraySchema,
  extensions: stringOrArraySchema,
  resume: z.string().optional(),
  "allowed-mcp-server-names": stringOrArraySchema,
}).passthrough().optional();

/** Main frontmatter schema */
export const frontmatterSchema = z.object({
  // Runner selection
  runner: runnerSchema,

  // Wizard mode inputs
  inputs: z.array(inputFieldSchema).optional(),

  // Context globs
  context: stringOrArraySchema,

  // Output extraction
  extract: extractModeSchema,

  // Command hooks
  before: stringOrArraySchema,
  after: stringOrArraySchema,

  // Model configuration
  model: modelSchema,

  // Behavior flags
  silent: z.boolean().optional(),
  interactive: z.boolean().optional(),

  // Permission flags
  "allow-all-tools": z.boolean().optional(),
  "allow-all-paths": z.boolean().optional(),
  "allow-tool": z.string().optional(),
  "deny-tool": z.string().optional(),
  "add-dir": stringOrArraySchema,

  // Caching
  cache: z.boolean().optional(),

  // Prerequisites
  requires: z.object({
    bin: z.array(z.string()).optional(),
    env: z.array(z.string()).optional(),
  }).optional(),

  // Backend-specific configs
  claude: claudeConfigSchema,
  codex: codexConfigSchema,
  copilot: copilotConfigSchema,
  gemini: geminiConfigSchema,
}).passthrough(); // Allow unknown keys for forward compatibility

/** Type inferred from schema */
export type FrontmatterSchema = z.infer<typeof frontmatterSchema>;

/**
 * Format zod issues into readable error strings
 */
function formatZodIssues(issues: Array<{ path: (string | number)[]; message: string }>): string[] {
  return issues.map(issue => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}

/**
 * Validate parsed YAML against frontmatter schema
 * Returns validated data or throws with helpful error messages
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
 * Validate without throwing - returns result object
 */
export function safeParseFrontmatter(data: unknown): {
  success: boolean;
  data?: FrontmatterSchema;
  errors?: string[];
} {
  const result = frontmatterSchema.safeParse(data);

  if (result.success) {
    return { success: true, data: result.data };
  }

  const errors = formatZodIssues(result.error.issues);
  return { success: false, errors };
}
