/**
 * Zod schemas for frontmatter validation
 * Minimal validation - most keys pass through to the command
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

/** String or array of strings */
const stringOrArraySchema = z.union([
  z.string(),
  z.array(z.string()),
]).optional();

/** Main frontmatter schema - minimal, passthrough everything else */
export const frontmatterSchema = z.object({
  // Command to execute
  command: z.string().optional(),

  // Wizard mode inputs
  inputs: z.array(inputFieldSchema).optional(),

  // Context globs
  context: stringOrArraySchema,

  // Caching
  cache: z.boolean().optional(),

  // Prerequisites
  requires: z.object({
    bin: z.array(z.string()).optional(),
    env: z.array(z.string()).optional(),
  }).optional(),
}).passthrough(); // Allow all other keys - they become CLI flags

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
