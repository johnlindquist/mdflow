/**
 * Secret masking and redaction for mdflow
 *
 * Provides utilities to detect sensitive argument keys and mask/redact their values
 * in console output and debug logs. This prevents accidental exposure of secrets
 * in logs, error messages, and terminal output.
 *
 * Key detection is case-insensitive and matches common sensitive key patterns:
 * - key, token, secret, password, credential, auth
 *
 * Masking vs Redaction:
 * - Masking: For console output, preserves prefixes (e.g., "sk-abc123" -> "sk-****")
 * - Redaction: For logs, replaces entire value with "[REDACTED]"
 */

/**
 * Patterns that indicate a sensitive key (case-insensitive)
 */
const SENSITIVE_KEY_PATTERNS = [
  /key/i,
  /token/i,
  /secret/i,
  /password/i,
  /credential/i,
  /auth/i,
];

/**
 * Check if a key name indicates a sensitive value
 *
 * @param key - The key/argument name to check
 * @returns true if the key appears to be sensitive
 *
 * @example
 * isSensitiveKey("api_key") // true
 * isSensitiveKey("API_TOKEN") // true
 * isSensitiveKey("model") // false
 */
export function isSensitiveKey(key: string): boolean {
  if (!key || typeof key !== "string") return false;
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

/**
 * Mask a sensitive value for console output
 *
 * Preserves common prefixes (like "sk-", "pk-", "ghp_", etc.) followed by asterisks.
 * For values without recognizable prefixes, returns "*****".
 *
 * @param value - The sensitive value to mask
 * @returns The masked value
 *
 * @example
 * maskValue("sk-abc123def456") // "sk-****"
 * maskValue("ghp_xxxxxxxxxxxx") // "ghp_****"
 * maskValue("mysecretvalue") // "*****"
 */
export function maskValue(value: string): string {
  if (!value || typeof value !== "string") return "*****";

  // Common API key prefixes (2-4 chars followed by separator)
  // Examples: sk-, pk-, ghp_, ghr_, npm_, xox-
  const prefixMatch = value.match(/^([a-zA-Z]{2,4}[-_])/);

  if (prefixMatch) {
    return `${prefixMatch[1]}****`;
  }

  return "*****";
}

/**
 * Redact a value for log output
 *
 * Always returns "[REDACTED]" to completely hide the value in logs.
 *
 * @param _value - The value to redact (unused, always returns [REDACTED])
 * @returns "[REDACTED]"
 */
export function redactValue(_value: unknown): string {
  return "[REDACTED]";
}

/**
 * Redact sensitive values from an args object for logging
 *
 * Creates a shallow copy of the object with sensitive values replaced by "[REDACTED]".
 * This is safe to pass to loggers without exposing secrets.
 *
 * @param args - The arguments object to redact
 * @returns A new object with sensitive values redacted
 *
 * @example
 * redactArgs({ model: "opus", api_key: "sk-secret" })
 * // { model: "opus", api_key: "[REDACTED]" }
 */
export function redactArgs(
  args: Record<string, unknown>
): Record<string, unknown> {
  if (!args || typeof args !== "object") return args;

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    if (isSensitiveKey(key)) {
      result[key] = redactValue(value);
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      // Recursively redact nested objects
      result[key] = redactArgs(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Mask sensitive values from an args object for console display
 *
 * Creates a shallow copy of the object with sensitive values masked.
 * Preserves value prefixes for easier identification.
 *
 * @param args - The arguments object to mask
 * @returns A new object with sensitive values masked
 *
 * @example
 * maskArgs({ model: "opus", api_key: "sk-secret123" })
 * // { model: "opus", api_key: "sk-****" }
 */
export function maskArgs(
  args: Record<string, unknown>
): Record<string, unknown> {
  if (!args || typeof args !== "object") return args;

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    if (isSensitiveKey(key) && typeof value === "string") {
      result[key] = maskValue(value);
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      // Recursively mask nested objects
      result[key] = maskArgs(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Mask sensitive values in a CLI args array for console display
 *
 * Detects flags that match sensitive key patterns and masks their following values.
 *
 * @param args - The CLI args array to mask
 * @returns A new array with sensitive values masked
 *
 * @example
 * maskArgsArray(["--model", "opus", "--api-key", "sk-secret123"])
 * // ["--model", "opus", "--api-key", "sk-****"]
 */
export function maskArgsArray(args: string[]): string[] {
  if (!Array.isArray(args)) return args;

  const result: string[] = [];
  let maskNext = false;

  for (const arg of args) {
    if (maskNext) {
      result.push(maskValue(arg));
      maskNext = false;
    } else if (arg.startsWith("-")) {
      // Extract key name from flag (e.g., "--api-key" -> "api-key")
      const keyName = arg.replace(/^-+/, "");
      result.push(arg);
      if (isSensitiveKey(keyName)) {
        maskNext = true;
      }
    } else {
      result.push(arg);
    }
  }

  return result;
}

/**
 * Redact sensitive values in a CLI args array for logging
 *
 * Detects flags that match sensitive key patterns and redacts their following values.
 *
 * @param args - The CLI args array to redact
 * @returns A new array with sensitive values redacted
 *
 * @example
 * redactArgsArray(["--model", "opus", "--api-key", "sk-secret123"])
 * // ["--model", "opus", "--api-key", "[REDACTED]"]
 */
export function redactArgsArray(args: string[]): string[] {
  if (!Array.isArray(args)) return args;

  const result: string[] = [];
  let redactNext = false;

  for (const arg of args) {
    if (redactNext) {
      result.push("[REDACTED]");
      redactNext = false;
    } else if (arg.startsWith("-")) {
      // Extract key name from flag (e.g., "--api-key" -> "api-key")
      const keyName = arg.replace(/^-+/, "");
      result.push(arg);
      if (isSensitiveKey(keyName)) {
        redactNext = true;
      }
    } else {
      result.push(arg);
    }
  }

  return result;
}
