export type ErrorContext = Record<string, unknown>;

export type MdflowErrorCode =
  | "MDFLOW_UNKNOWN"
  | "CONFIG_FILE_READ_FAILED"
  | "CONFIG_FILE_PARSE_FAILED"
  | "CONFIG_FILE_VALIDATION_FAILED"
  | "CONFIG_FILE_DISCOVERY_FAILED"
  | "ENV_FILE_READ_FAILED"
  | "IMPORT_FILE_NOT_FOUND"
  | "IMPORT_FILE_READ_FAILED"
  | "IMPORT_BINARY_FILE"
  | "IMPORT_CIRCULAR_DEPENDENCY"
  | "IMPORT_COMMAND_FAILED"
  | "IMPORT_URL_FETCH_FAILED"
  | "COMMAND_MISSING"
  | "COMMAND_INVALID"
  | "COMMAND_NOT_FOUND"
  | "COMMAND_EXECUTION_FAILED"
  | "SYSTEM_PROMPT_UNSUPPORTED"
  | "SYSTEM_PROMPT_INVALID"
  | "HOOKS_UNSUPPORTED"
  | "HOOKS_REQUIRE_ISOLATION"
  | "TEMPLATE_MISSING_VARIABLE"
  | "TEMPLATE_PROCESSING_FAILED"
  | "SECURITY_TRUST_FAILED"
  | "INPUT_LIMIT_EXCEEDED"
  | "PROMPT_TOKEN_LIMIT"
  | "NETWORK_REQUEST_FAILED"
  | "HOOK_EXECUTION_FAILED"
  | "VALIDATION_FAILED"
  | "USER_CANCELLED"
  | "EARLY_EXIT";

export interface MdflowErrorOptions {
  exitCode?: number;
  errorCode?: MdflowErrorCode;
  context?: ErrorContext;
  cause?: unknown;
}

export type MarkdownAgentErrorOptions = MdflowErrorOptions;
type ErrorInput = MdflowErrorOptions | number;

function withDefaults(optionsOrCode: ErrorInput, errorCode: MdflowErrorCode, exitCode = 1): MdflowErrorOptions {
  if (typeof optionsOrCode === "number") return { exitCode: optionsOrCode, errorCode, context: {} };
  return {
    exitCode: optionsOrCode.exitCode ?? exitCode,
    errorCode: optionsOrCode.errorCode ?? errorCode,
    context: optionsOrCode.context ?? {},
    cause: optionsOrCode.cause,
  };
}

export class MdflowError extends Error {
  public readonly code: number;
  public readonly errorCode: MdflowErrorCode;
  public readonly context: ErrorContext;

  constructor(message: string, optionsOrCode: ErrorInput = {}) {
    const options = withDefaults(optionsOrCode, "MDFLOW_UNKNOWN");
    super(message);
    this.name = new.target.name;
    this.code = options.exitCode ?? 1;
    this.errorCode = options.errorCode ?? "MDFLOW_UNKNOWN";
    this.context = options.context ?? {};
    if (options.cause !== undefined) (this as Error & { cause?: unknown }).cause = options.cause;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

export class MarkdownAgentError extends MdflowError {}

export class ConfigError extends MarkdownAgentError {
  constructor(message: string, optionsOrCode: ErrorInput = {}) { super(message, withDefaults(optionsOrCode, "CONFIG_FILE_READ_FAILED")); }
}
export class ImportError extends MarkdownAgentError {
  constructor(message: string, optionsOrCode: ErrorInput = {}) { super(message, withDefaults(optionsOrCode, "IMPORT_FILE_READ_FAILED")); }
}
export class CommandError extends MarkdownAgentError {
  constructor(message: string, optionsOrCode: ErrorInput = {}) { super(message, withDefaults(optionsOrCode, "COMMAND_EXECUTION_FAILED")); }
}
export class TemplateError extends MarkdownAgentError {
  constructor(message: string, optionsOrCode: ErrorInput = {}) { super(message, withDefaults(optionsOrCode, "TEMPLATE_PROCESSING_FAILED")); }
}
export class ValidationError extends MarkdownAgentError {
  constructor(message: string, optionsOrCode: ErrorInput = {}) { super(message, withDefaults(optionsOrCode, "VALIDATION_FAILED")); }
}

export class ConfigurationError extends ConfigError {}
export class CommandResolutionError extends CommandError {}

export class SecurityError extends MarkdownAgentError {
  constructor(message: string, optionsOrCode: ErrorInput = {}) { super(message, withDefaults(optionsOrCode, "SECURITY_TRUST_FAILED")); }
}
export class InputLimitError extends MarkdownAgentError {
  constructor(message: string, optionsOrCode: ErrorInput = {}) { super(message, withDefaults(optionsOrCode, "INPUT_LIMIT_EXCEEDED")); }
}
export class FileNotFoundError extends MarkdownAgentError {
  constructor(message: string, optionsOrCode: ErrorInput = {}) { super(message, withDefaults(optionsOrCode, "IMPORT_FILE_NOT_FOUND")); }
}
export class NetworkError extends MarkdownAgentError {
  constructor(message: string, optionsOrCode: ErrorInput = {}) { super(message, withDefaults(optionsOrCode, "NETWORK_REQUEST_FAILED")); }
}
export class HookError extends MarkdownAgentError {
  constructor(message: string, optionsOrCode: ErrorInput = {}) { super(message, withDefaults(optionsOrCode, "HOOK_EXECUTION_FAILED")); }
}
export class UserCancelledError extends MarkdownAgentError {
  constructor(message = "Operation cancelled by user", optionsOrCode: ErrorInput = {}) { super(message, withDefaults(optionsOrCode, "USER_CANCELLED")); }
}
export class EarlyExitRequest extends MarkdownAgentError {
  constructor(message = "", optionsOrCode: ErrorInput = {}) { super(message, withDefaults(optionsOrCode, "EARLY_EXIT", 0)); }
}

export function getErrorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}
