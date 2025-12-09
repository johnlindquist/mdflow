/**
 * Typed error classes for mdflow
 *
 * These errors allow library code to signal failures without calling process.exit(),
 * enabling proper error handling in tests and when used as a library.
 *
 * Only the main entry point (index.ts) should catch these and set exit codes.
 */

/**
 * Base error class for all mdflow errors
 */
export class MarkdownAgentError extends Error {
  constructor(message: string, public code: number = 1) {
    super(message);
    this.name = "MarkdownAgentError";
    // Maintains proper stack trace for where error was thrown (only in V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Configuration-related errors (invalid config, missing required fields, etc.)
 */
export class ConfigurationError extends MarkdownAgentError {
  constructor(message: string, code: number = 1) {
    super(message, code);
    this.name = "ConfigurationError";
  }
}

/**
 * Security-related errors (untrusted domains, trust verification failures)
 */
export class SecurityError extends MarkdownAgentError {
  constructor(message: string, code: number = 1) {
    super(message, code);
    this.name = "SecurityError";
  }
}

/**
 * Input limit exceeded errors (stdin too large, file too large)
 */
export class InputLimitError extends MarkdownAgentError {
  constructor(message: string, code: number = 1) {
    super(message, code);
    this.name = "InputLimitError";
  }
}

/**
 * File not found or inaccessible errors
 */
export class FileNotFoundError extends MarkdownAgentError {
  constructor(message: string, code: number = 1) {
    super(message, code);
    this.name = "FileNotFoundError";
  }
}

/**
 * Network-related errors (failed fetches, connection issues)
 */
export class NetworkError extends MarkdownAgentError {
  constructor(message: string, code: number = 1) {
    super(message, code);
    this.name = "NetworkError";
  }
}

/**
 * Command execution errors (command not found, failed to spawn)
 */
export class CommandError extends MarkdownAgentError {
  constructor(message: string, code: number = 1) {
    super(message, code);
    this.name = "CommandError";
  }
}

/**
 * Command resolution errors (can't determine which command to run)
 */
export class CommandResolutionError extends MarkdownAgentError {
  constructor(message: string, code: number = 1) {
    super(message, code);
    this.name = "CommandResolutionError";
  }
}

/**
 * Import expansion errors (failed to expand @file imports)
 */
export class ImportError extends MarkdownAgentError {
  constructor(message: string, code: number = 1) {
    super(message, code);
    this.name = "ImportError";
  }
}

/**
 * Template processing errors (missing variables, syntax errors)
 */
export class TemplateError extends MarkdownAgentError {
  constructor(message: string, code: number = 1) {
    super(message, code);
    this.name = "TemplateError";
  }
}

/**
 * Hook execution errors (pre/post hook failures)
 */
export class HookError extends MarkdownAgentError {
  constructor(message: string, code: number = 1) {
    super(message, code);
    this.name = "HookError";
  }
}

/**
 * User cancelled the operation (e.g., declined trust prompt)
 */
export class UserCancelledError extends MarkdownAgentError {
  constructor(message: string = "Operation cancelled by user", code: number = 1) {
    super(message, code);
    this.name = "UserCancelledError";
  }
}

/**
 * Early exit request (for --help, --logs, etc. that need clean exit)
 * These are not errors per se, but signal that execution should stop with code 0
 */
export class EarlyExitRequest extends MarkdownAgentError {
  constructor(message: string = "", code: number = 0) {
    super(message, code);
    this.name = "EarlyExitRequest";
  }
}
