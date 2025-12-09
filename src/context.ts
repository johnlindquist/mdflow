/**
 * RunContext factory and utilities
 *
 * Provides functions to create and manage RunContext instances,
 * replacing global state with explicit dependency injection.
 */

import type { RunContext, RunContextOptions, Logger, GlobalConfig } from "./types";
import { BUILTIN_DEFAULTS, mergeConfigs as mergeConfigsImpl } from "./config";

// Re-export for backward compatibility
export { BUILTIN_DEFAULTS };
export const mergeConfigs = mergeConfigsImpl;

/**
 * Create a silent logger that discards all output
 * Useful for testing or when logging is not desired
 */
export function createSilentLogger(): Logger {
  const silentLogger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => silentLogger,
    level: "silent",
  };
  return silentLogger;
}

/**
 * Create a console logger that outputs to console
 * Useful for debugging or CLI output
 */
export function createConsoleLogger(level: string = "info"): Logger {
  const levels = ["debug", "info", "warn", "error"];
  const levelIndex = levels.indexOf(level);

  const shouldLog = (msgLevel: string) => levels.indexOf(msgLevel) >= levelIndex;

  const consoleLogger: Logger = {
    debug: (objOrMsg: object | string, msg?: string) => {
      if (shouldLog("debug")) {
        if (typeof objOrMsg === "string") {
          console.debug("[DEBUG]", objOrMsg);
        } else {
          console.debug("[DEBUG]", msg || "", objOrMsg);
        }
      }
    },
    info: (objOrMsg: object | string, msg?: string) => {
      if (shouldLog("info")) {
        if (typeof objOrMsg === "string") {
          console.info("[INFO]", objOrMsg);
        } else {
          console.info("[INFO]", msg || "", objOrMsg);
        }
      }
    },
    warn: (objOrMsg: object | string, msg?: string) => {
      if (shouldLog("warn")) {
        if (typeof objOrMsg === "string") {
          console.warn("[WARN]", objOrMsg);
        } else {
          console.warn("[WARN]", msg || "", objOrMsg);
        }
      }
    },
    error: (objOrMsg: object | string, msg?: string) => {
      if (shouldLog("error")) {
        if (typeof objOrMsg === "string") {
          console.error("[ERROR]", objOrMsg);
        } else {
          console.error("[ERROR]", msg || "", objOrMsg);
        }
      }
    },
    child: (bindings: Record<string, unknown>) => {
      // Return a new logger that prefixes with bindings
      const childLogger = createConsoleLogger(level);
      const originalMethods = { ...childLogger };
      const prefix = Object.entries(bindings)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");

      childLogger.debug = (objOrMsg: object | string, msg?: string) => {
        if (typeof objOrMsg === "string") {
          originalMethods.debug(`[${prefix}] ${objOrMsg}`);
        } else {
          originalMethods.debug(objOrMsg, `[${prefix}] ${msg || ""}`);
        }
      };
      childLogger.info = (objOrMsg: object | string, msg?: string) => {
        if (typeof objOrMsg === "string") {
          originalMethods.info(`[${prefix}] ${objOrMsg}`);
        } else {
          originalMethods.info(objOrMsg, `[${prefix}] ${msg || ""}`);
        }
      };
      childLogger.warn = (objOrMsg: object | string, msg?: string) => {
        if (typeof objOrMsg === "string") {
          originalMethods.warn(`[${prefix}] ${objOrMsg}`);
        } else {
          originalMethods.warn(objOrMsg, `[${prefix}] ${msg || ""}`);
        }
      };
      childLogger.error = (objOrMsg: object | string, msg?: string) => {
        if (typeof objOrMsg === "string") {
          originalMethods.error(`[${prefix}] ${objOrMsg}`);
        } else {
          originalMethods.error(objOrMsg, `[${prefix}] ${msg || ""}`);
        }
      };

      return childLogger;
    },
    level,
  };

  return consoleLogger;
}

/**
 * Create a test logger that captures all log messages
 * Useful for testing to verify logging behavior
 */
export interface TestLogger extends Logger {
  messages: Array<{ level: string; msg?: string; obj?: object }>;
  clear(): void;
}

export function createTestLogger(): TestLogger {
  const messages: Array<{ level: string; msg?: string; obj?: object }> = [];

  const testLogger: TestLogger = {
    messages,
    clear: () => {
      messages.length = 0;
    },
    debug: (objOrMsg: object | string, msg?: string) => {
      if (typeof objOrMsg === "string") {
        messages.push({ level: "debug", msg: objOrMsg });
      } else {
        messages.push({ level: "debug", obj: objOrMsg, msg });
      }
    },
    info: (objOrMsg: object | string, msg?: string) => {
      if (typeof objOrMsg === "string") {
        messages.push({ level: "info", msg: objOrMsg });
      } else {
        messages.push({ level: "info", obj: objOrMsg, msg });
      }
    },
    warn: (objOrMsg: object | string, msg?: string) => {
      if (typeof objOrMsg === "string") {
        messages.push({ level: "warn", msg: objOrMsg });
      } else {
        messages.push({ level: "warn", obj: objOrMsg, msg });
      }
    },
    error: (objOrMsg: object | string, msg?: string) => {
      if (typeof objOrMsg === "string") {
        messages.push({ level: "error", msg: objOrMsg });
      } else {
        messages.push({ level: "error", obj: objOrMsg, msg });
      }
    },
    child: () => testLogger, // Child loggers share the same messages array
    level: "debug",
  };

  return testLogger;
}

/**
 * Create a fresh copy of BUILTIN_DEFAULTS
 * This ensures each context gets an independent configuration object.
 */
function cloneBuiltinDefaults(): GlobalConfig {
  return mergeConfigs(BUILTIN_DEFAULTS, {});
}

/**
 * Create a RunContext with the specified options
 *
 * @param options - Options for creating the context
 * @returns A new RunContext instance
 */
export function createRunContext(options: RunContextOptions = {}): RunContext {
  return {
    logger: options.logger ?? createSilentLogger(),
    // Clone BUILTIN_DEFAULTS to ensure isolation between contexts
    config: options.config ?? cloneBuiltinDefaults(),
    env: options.env ?? { ...process.env },
    cwd: options.cwd ?? process.cwd(),
  };
}

/**
 * Create a RunContext suitable for testing
 * Uses a test logger and isolated environment by default
 *
 * @param options - Options for creating the test context
 * @returns A new RunContext with a TestLogger
 */
export function createTestRunContext(
  options: RunContextOptions & { logger?: TestLogger } = {}
): RunContext & { logger: TestLogger } {
  const logger = options.logger ?? createTestLogger();
  return {
    logger,
    // Clone BUILTIN_DEFAULTS to ensure isolation between contexts
    config: options.config ?? cloneBuiltinDefaults(),
    env: options.env ?? {},
    cwd: options.cwd ?? "/tmp/test",
  };
}

/**
 * Get child logger with module binding
 */
export function getModuleLogger(ctx: RunContext, module: string): Logger {
  return ctx.logger.child({ module });
}
