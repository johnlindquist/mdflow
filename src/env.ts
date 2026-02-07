/**
 * Environment variable loading using Bun's native .env support
 *
 * Bun automatically loads .env files from the current working directory.
 * This module extends that to also load from the markdown file's directory.
 *
 * Loading order (later files override earlier):
 * 1. .env (base environment)
 * 2. .env.local (local overrides, not committed)
 * 3. .env.[NODE_ENV] (environment-specific: .env.development, .env.production)
 * 4. .env.[NODE_ENV].local (environment-specific local overrides)
 */

import { join } from "path";
import { ConfigError, getErrorMessage } from "./errors";
import { detectSensitiveEnvVars } from "./security";
import { getLogger } from "./logger";

/**
 * Load environment files from a directory using Bun's native file reading
 * Files are loaded in order, with later files overriding earlier ones
 */
export async function loadEnvFiles(
  directory: string,
  verbose: boolean = false
): Promise<number> {
  const nodeEnv = process.env.NODE_ENV || "development";

  // Files to load in order (later overrides earlier)
  const envFiles = [
    ".env",
    ".env.local",
    `.env.${nodeEnv}`,
    `.env.${nodeEnv}.local`,
  ];

  // Track which keys were set by our loading (so later files can override)
  const loadedKeys = new Set<string>();
  // Snapshot of env vars that existed before we started loading
  const preExistingKeys = new Set(Object.keys(process.env));

  let loadedCount = 0;

  for (const envFile of envFiles) {
    const envPath = join(directory, envFile);
    const file = Bun.file(envPath);
    let exists = false;

    try {
      exists = await file.exists();
    } catch (err) {
      throw new ConfigError(
        `Failed to check env file "${envPath}".`,
        {
          errorCode: "ENV_FILE_READ_FAILED",
          context: {
            envPath,
            directory,
            suggestion: "Verify directory permissions and confirm the path exists.",
          },
          cause: err,
        }
      );
    }

    if (!exists) {
      continue;
    }

    let content = "";
    try {
      content = await file.text();
    } catch (err) {
      throw new ConfigError(
        `Failed to read env file "${envPath}".`,
        {
          errorCode: "ENV_FILE_READ_FAILED",
          context: {
            envPath,
            directory,
            suggestion: "Check file permissions (e.g. chmod 600/644) and ensure the file is not locked.",
          },
          cause: err,
        }
      );
    }

    try {
      const vars = parseEnvFile(content);
      const sensitiveKeys = detectSensitiveEnvVars(vars);

      if (sensitiveKeys.length > 0) {
        getLogger().warn(
          {
            module: "env",
            envFile,
            envPath,
            sensitiveKeys,
          },
          "Sensitive-looking environment variable keys detected in .env file"
        );
        console.error(
          `[env][security] ${envFile} contains sensitive-looking keys: ${sensitiveKeys.join(", ")}`
        );
      }

      for (const [key, value] of Object.entries(vars)) {
        // Don't override pre-existing env vars (CLI/system take precedence)
        // But DO allow later .env files to override earlier .env files
        if (!preExistingKeys.has(key) || loadedKeys.has(key)) {
          process.env[key] = value;
          loadedKeys.add(key);
        }
      }

      loadedCount++;
      if (verbose) {
        console.error(`[env] Loaded: ${envFile} (${Object.keys(vars).length} vars)`);
      }
    } catch (err) {
      throw new ConfigError(
        `Failed to parse env file "${envPath}": ${getErrorMessage(err)}`,
        {
          errorCode: "CONFIG_FILE_PARSE_FAILED",
          context: {
            envPath,
            suggestion: "Ensure each line is KEY=value and quoted multiline values are closed.",
          },
          cause: err,
        }
      );
    }
  }

  return loadedCount;
}

/**
 * Parse .env file content into key-value pairs
 * Supports:
 * - KEY=value
 * - KEY="quoted value"
 * - KEY='single quoted'
 * - # comments
 * - Empty lines
 * - Multiline values with quotes
 */
function parseEnvFile(content: string): Record<string, string> {
  const vars: Record<string, string> = {};
  const lines = content.split("\n");

  let currentKey: string | null = null;
  let currentValue: string[] = [];
  let inMultiline = false;
  let quoteChar: string | null = null;

  for (const line of lines) {
    // Skip empty lines and comments (unless in multiline)
    if (!inMultiline && (line.trim() === "" || line.trim().startsWith("#"))) {
      continue;
    }

    if (inMultiline) {
      // Continue collecting multiline value
      currentValue.push(line);

      // Check if this line ends the multiline
      if (line.trimEnd().endsWith(quoteChar!)) {
        const fullValue = currentValue.join("\n");
        // Remove the closing quote
        vars[currentKey!] = fullValue.slice(0, -1);
        inMultiline = false;
        currentKey = null;
        currentValue = [];
        quoteChar = null;
      }
      continue;
    }

    // Parse KEY=value
    const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.*)/);
    if (!match) continue;

    const key = match[1];
    const rawValue = match[2];
    if (!key || rawValue === undefined) continue;

    let value = rawValue.trim();

    // Handle quoted values
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      // Simple quoted value on one line
      vars[key] = value.slice(1, -1);
    } else if (value.startsWith('"') || value.startsWith("'")) {
      // Start of multiline quoted value
      inMultiline = true;
      currentKey = key;
      quoteChar = value[0] ?? null;
      currentValue = [value.slice(1)]; // Remove opening quote
    } else {
      // Unquoted value - remove inline comments
      const commentIndex = value.indexOf(" #");
      if (commentIndex !== -1) {
        value = value.slice(0, commentIndex).trim();
      }
      vars[key] = value;
    }
  }

  return vars;
}

/**
 * Get a list of env files that would be loaded from a directory
 */
export async function getEnvFilesInDirectory(directory: string): Promise<string[]> {
  const nodeEnv = process.env.NODE_ENV || "development";
  const envFiles = [
    ".env",
    ".env.local",
    `.env.${nodeEnv}`,
    `.env.${nodeEnv}.local`,
  ];

  const existing: string[] = [];
  for (const envFile of envFiles) {
    const envPath = join(directory, envFile);
    try {
      if (await Bun.file(envPath).exists()) {
        existing.push(envFile);
      }
    } catch (err) {
      throw new ConfigError(
        `Failed to inspect env file "${envPath}".`,
        {
          errorCode: "ENV_FILE_READ_FAILED",
          context: {
            envPath,
            directory,
            suggestion: "Verify directory/file permissions before retrying.",
          },
          cause: err,
        }
      );
    }
  }

  return existing;
}
