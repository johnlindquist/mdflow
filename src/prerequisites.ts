/**
 * Prerequisite guardrails for script execution
 * Validates required binaries and environment variables exist
 */

import type { Prerequisites } from "./types";

export interface PrerequisiteResult {
  success: boolean;
  missingBinaries: string[];
  missingEnvVars: string[];
}

/**
 * Check if a binary is available in PATH
 */
export async function checkBinary(name: string): Promise<boolean> {
  const result = Bun.which(name);
  return result !== null;
}

/**
 * Check if an environment variable is set (and non-empty)
 */
export function checkEnvVar(name: string): boolean {
  const value = process.env[name];
  return value !== undefined && value !== "";
}

/**
 * Validate all prerequisites
 */
export async function validatePrerequisites(
  requires: Prerequisites
): Promise<PrerequisiteResult> {
  const missingBinaries: string[] = [];
  const missingEnvVars: string[] = [];

  // Check required binaries
  if (requires.bin) {
    for (const bin of requires.bin) {
      const exists = await checkBinary(bin);
      if (!exists) {
        missingBinaries.push(bin);
      }
    }
  }

  // Check required environment variables
  if (requires.env) {
    for (const envVar of requires.env) {
      if (!checkEnvVar(envVar)) {
        missingEnvVars.push(envVar);
      }
    }
  }

  return {
    success: missingBinaries.length === 0 && missingEnvVars.length === 0,
    missingBinaries,
    missingEnvVars,
  };
}

/**
 * Format prerequisite errors for display
 */
export function formatPrerequisiteErrors(result: PrerequisiteResult): string {
  const lines: string[] = [];

  if (result.missingBinaries.length > 0) {
    lines.push("Missing required binaries:");
    for (const bin of result.missingBinaries) {
      lines.push(`  • ${bin}`);
    }
  }

  if (result.missingEnvVars.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Missing required environment variables:");
    for (const envVar of result.missingEnvVars) {
      lines.push(`  • ${envVar}`);
    }
  }

  return lines.join("\n");
}

/**
 * Print prerequisite errors and exit
 */
export function handlePrerequisiteFailure(result: PrerequisiteResult): never {
  console.error("Prerequisites not met:\n");
  console.error(formatPrerequisiteErrors(result));
  console.error("\nPlease install missing dependencies or set required environment variables.");
  process.exit(1);
}
