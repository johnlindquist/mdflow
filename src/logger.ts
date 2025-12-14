/**
 * Structured logging for mdflow internals
 *
 * Logs are always written to ~/.mdflow/logs/<agent-name>/
 * Use `md logs` to show the log directory
 *
 * Secret Redaction:
 * - All log entries are processed to redact sensitive values
 * - Keys matching patterns like 'key', 'token', 'secret', 'password', etc.
 *   have their values replaced with '[REDACTED]'
 * - This prevents accidental exposure of secrets in log files
 */

import pino, { type Logger } from "pino";
import { homedir } from "os";
import { mkdirSync, existsSync, readdirSync } from "fs";
import { join, basename } from "path";
import { isSensitiveKey, redactArgs } from "./secrets";

const LOG_BASE_DIR = join(homedir(), ".mdflow", "logs");

// Ensure base log directory exists
if (!existsSync(LOG_BASE_DIR)) {
  try {
    mkdirSync(LOG_BASE_DIR, { recursive: true });
  } catch {
    // Ignore - logging to file is optional
  }
}

/**
 * Get the log directory path
 */
export function getLogDir(): string {
  return LOG_BASE_DIR;
}

/**
 * Get log file path for a specific agent
 */
export function getAgentLogPath(agentFile: string): string {
  const agentName = basename(agentFile, ".md").replace(/\./g, "-");
  return join(LOG_BASE_DIR, agentName, "debug.log");
}

/**
 * List all agent log directories
 */
export function listLogDirs(): string[] {
  try {
    if (!existsSync(LOG_BASE_DIR)) return [];
    return readdirSync(LOG_BASE_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => join(LOG_BASE_DIR, d.name));
  } catch {
    return [];
  }
}

// Default silent logger until initialized with agent file
let currentLogger: Logger = pino({ level: "silent" });
let currentAgentLogPath: string | null = null;

/**
 * Initialize logger for a specific agent file
 * Creates a log file at ~/.mdflow/logs/<agent-name>/debug.log
 */
export function initLogger(agentFile: string): Logger {
  const agentName = basename(agentFile, ".md").replace(/\./g, "-");
  const logDir = join(LOG_BASE_DIR, agentName);
  const logFile = join(logDir, "debug.log");

  // Ensure agent log directory exists
  if (!existsSync(logDir)) {
    try {
      mkdirSync(logDir, { recursive: true });
    } catch {
      // Fall back to silent logger
      return pino({ level: "silent" });
    }
  }

  currentAgentLogPath = logFile;

  // Create logger that writes to file only (no stderr spam)
  // Uses a custom serializer to redact sensitive values
  currentLogger = pino(
    {
      level: "debug",
      base: { agent: agentName },
      timestamp: pino.stdTimeFunctions.isoTime,
      // Custom hooks to redact sensitive data before logging
      hooks: {
        logMethod(inputArgs, method, level) {
          // Process each argument to redact sensitive values
          const redactedArgs = inputArgs.map((arg) => {
            if (arg && typeof arg === "object" && !Array.isArray(arg)) {
              return redactArgs(arg as Record<string, unknown>);
            }
            return arg;
          });
          return method.apply(this, redactedArgs as Parameters<typeof method>);
        },
      },
    },
    pino.destination({ dest: logFile, sync: false })
  );

  return currentLogger;
}

/**
 * Get the current logger instance
 */
export function getLogger(): Logger {
  return currentLogger;
}

/**
 * Get the current agent's log file path
 */
export function getCurrentLogPath(): string | null {
  return currentAgentLogPath;
}

// Convenience child loggers - these use the current logger
export function getParseLogger(): Logger {
  return currentLogger.child({ module: "parse" });
}

export function getTemplateLogger(): Logger {
  return currentLogger.child({ module: "template" });
}

export function getCommandLogger(): Logger {
  return currentLogger.child({ module: "command" });
}

export function getImportLogger(): Logger {
  return currentLogger.child({ module: "import" });
}
