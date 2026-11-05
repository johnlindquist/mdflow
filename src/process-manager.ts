/**
 * ProcessManager - Centralized process lifecycle management
 *
 * Provides:
 * - Single AbortController per run for coordinated cancellation
 * - Process registry to track all spawned child processes
 * - Signal propagation (SIGINT/SIGTERM) to all children
 * - Process tree killing where supported
 * - Terminal state restoration (cursor visibility)
 * - Configurable timeouts
 */

/**
 * Timeout configuration (in milliseconds)
 * Can be overridden via environment variables or frontmatter
 */
export interface TimeoutConfig {
  /** Timeout for HTTP fetch operations (default: 10000ms) */
  fetchTimeout: number;
  /** Timeout for inline command execution (default: 30000ms) */
  commandTimeout: number;
  /** Timeout for agent execution (default: 0 = no timeout) */
  agentTimeout: number;
}

/** Default timeout values */
export const DEFAULT_TIMEOUTS: TimeoutConfig = {
  fetchTimeout: 10_000,    // 10 seconds
  commandTimeout: 30_000,  // 30 seconds
  agentTimeout: 0,         // No timeout by default
};

/** Environment variable names for timeout configuration */
export const TIMEOUT_ENV_VARS = {
  fetchTimeout: "MDFLOW_FETCH_TIMEOUT",
  commandTimeout: "MDFLOW_COMMAND_TIMEOUT",
  agentTimeout: "MDFLOW_AGENT_TIMEOUT",
} as const;

/**
 * Parse timeout from environment variable or return default
 */
function parseTimeoutEnv(envVar: string, defaultValue: number): number {
  const value = process.env[envVar];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) || parsed < 0 ? defaultValue : parsed;
}

/**
 * Get timeout configuration from environment variables
 */
export function getTimeoutConfig(): TimeoutConfig {
  return {
    fetchTimeout: parseTimeoutEnv(TIMEOUT_ENV_VARS.fetchTimeout, DEFAULT_TIMEOUTS.fetchTimeout),
    commandTimeout: parseTimeoutEnv(TIMEOUT_ENV_VARS.commandTimeout, DEFAULT_TIMEOUTS.commandTimeout),
    agentTimeout: parseTimeoutEnv(TIMEOUT_ENV_VARS.agentTimeout, DEFAULT_TIMEOUTS.agentTimeout),
  };
}

/**
 * Tracked process entry in the registry
 */
interface TrackedProcess {
  /** The spawned process */
  proc: ReturnType<typeof Bun.spawn>;
  /** Optional label for debugging */
  label?: string;
  /** Timestamp when process was started */
  startedAt: number;
}

/**
 * ProcessManager - Singleton for managing process lifecycle
 *
 * Usage:
 * ```typescript
 * const pm = ProcessManager.getInstance();
 * pm.initialize(); // Sets up signal handlers
 *
 * // Register a process
 * const proc = Bun.spawn([...]);
 * pm.register(proc, "my-command");
 *
 * // Process is automatically cleaned up on SIGINT/SIGTERM
 * // Or manually unregister when done
 * pm.unregister(proc);
 * ```
 */
export class ProcessManager {
  private static instance: ProcessManager | null = null;

  /** AbortController for the current run */
  private abortController: AbortController;

  /** Registry of active child processes */
  private processes: Map<number, TrackedProcess> = new Map();

  /** Whether signal handlers have been set up */
  private signalHandlersInstalled = false;

  /** Whether cursor is currently hidden (by spinner) */
  private cursorHidden = false;

  /** Timeout configuration */
  private timeoutConfig: TimeoutConfig;

  /** Cleanup callbacks to run on shutdown */
  private cleanupCallbacks: Array<() => void | Promise<void>> = [];

  private constructor() {
    this.abortController = new AbortController();
    this.timeoutConfig = getTimeoutConfig();
  }

  /**
   * Get the singleton instance
   */
  static getInstance(): ProcessManager {
    if (!ProcessManager.instance) {
      ProcessManager.instance = new ProcessManager();
    }
    return ProcessManager.instance;
  }

  /**
   * Reset the singleton (for testing)
   */
  static reset(): void {
    if (ProcessManager.instance) {
      ProcessManager.instance.cleanup();
      ProcessManager.instance = null;
    }
  }

  /**
   * Initialize the ProcessManager and set up signal handlers
   * Should be called once at application startup
   */
  initialize(): void {
    if (this.signalHandlersInstalled) return;

    const handleSignal = async (signal: NodeJS.Signals) => {
      await this.handleShutdown(signal);
    };

    process.on("SIGINT", () => handleSignal("SIGINT"));
    process.on("SIGTERM", () => handleSignal("SIGTERM"));

    this.signalHandlersInstalled = true;
  }

  /**
   * Get the AbortSignal for cancellation
   */
  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  /**
   * Check if the run has been aborted
   */
  get isAborted(): boolean {
    return this.abortController.signal.aborted;
  }

  /**
   * Get timeout configuration
   */
  get timeouts(): TimeoutConfig {
    return { ...this.timeoutConfig };
  }

  /**
   * Update timeout configuration (e.g., from frontmatter)
   */
  setTimeouts(config: Partial<TimeoutConfig>): void {
    this.timeoutConfig = { ...this.timeoutConfig, ...config };
  }

  /**
   * Register a callback to run on cleanup/shutdown
   */
  onCleanup(callback: () => void | Promise<void>): void {
    this.cleanupCallbacks.push(callback);
  }

  /**
   * Remove a cleanup callback
   */
  offCleanup(callback: () => void | Promise<void>): void {
    const index = this.cleanupCallbacks.indexOf(callback);
    if (index !== -1) {
      this.cleanupCallbacks.splice(index, 1);
    }
  }

  /**
   * Register a spawned process for tracking
   */
  register(proc: ReturnType<typeof Bun.spawn>, label?: string): void {
    const pid = proc.pid;
    this.processes.set(pid, {
      proc,
      label,
      startedAt: Date.now(),
    });

    // Auto-unregister when process exits
    proc.exited.then(() => {
      this.processes.delete(pid);
    }).catch(() => {
      this.processes.delete(pid);
    });
  }

  /**
   * Unregister a process from tracking
   */
  unregister(proc: ReturnType<typeof Bun.spawn>): void {
    this.processes.delete(proc.pid);
  }

  /**
   * Mark cursor as hidden (called by spinner)
   */
  setCursorHidden(hidden: boolean): void {
    this.cursorHidden = hidden;
  }

  /**
   * Restore terminal state (cursor visibility)
   */
  restoreTerminal(): void {
    if (this.cursorHidden && process.stderr.isTTY) {
      // Clear any partial output and show cursor
      process.stderr.write("\r\x1B[K"); // Clear line
      process.stderr.write("\x1B[?25h"); // Show cursor
      this.cursorHidden = false;
    }
  }

  /**
   * Kill a single process, attempting process group kill first
   */
  private killProcess(tracked: TrackedProcess): boolean {
    const { proc, label } = tracked;

    try {
      // Try to kill the process group (negative PID) to kill all children
      // This only works on Unix-like systems and when the process is a group leader
      try {
        process.kill(-proc.pid, "SIGTERM");
        return true;
      } catch {
        // Process group kill failed (Windows or not a group leader)
        // Fall back to direct kill
      }

      proc.kill("SIGTERM");
      return true;
    } catch (err) {
      // Process may have already exited
      return false;
    }
  }

  /**
   * Kill all registered processes
   */
  killAll(): number {
    let killed = 0;

    for (const [pid, tracked] of this.processes) {
      if (this.killProcess(tracked)) {
        killed++;
      }
    }

    // Clear the registry
    this.processes.clear();

    return killed;
  }

  /**
   * Abort the current run
   * Signals all operations to cancel via AbortController
   */
  abort(reason?: string): void {
    if (!this.abortController.signal.aborted) {
      this.abortController.abort(reason);
    }
  }

  /**
   * Handle shutdown signal (SIGINT/SIGTERM)
   */
  private async handleShutdown(signal: NodeJS.Signals): Promise<void> {
    // Abort any pending operations
    this.abort(signal);

    // Kill all child processes
    this.killAll();

    // Restore terminal state
    this.restoreTerminal();

    await this.releaseResources();

    // Exit with appropriate code
    // SIGINT = 2, SIGTERM = 15
    const exitCode = signal === "SIGINT" ? 130 : 143;
    // Do not force-exit here. Registered runCommand calls are still awaiting
    // their children; letting those promises settle is what runs per-process
    // isolation cleanup and other finally blocks. The normal CLI completion
    // path exits once that cleanup has finished.
    process.exitCode = exitCode;
  }

  /** Release resources on normal completion too, not only on signals. */
  async releaseResources(): Promise<void> {
    for (const callback of this.cleanupCallbacks.splice(0).reverse()) {
      try { await callback(); } catch (err) { console.error("Resource cleanup failed:", err instanceof Error ? err.message : String(err)); }
    }
  }

  /**
   * Clean up resources (for testing)
   */
  cleanup(): void {
    this.killAll();
    this.restoreTerminal();
    this.abortController = new AbortController();
    this.cleanupCallbacks = [];
    this.timeoutConfig = getTimeoutConfig();
  }

  /**
   * Get the number of active processes
   */
  get activeCount(): number {
    return this.processes.size;
  }

  /**
   * Get info about active processes (for debugging)
   */
  getActiveProcesses(): Array<{ pid: number; label?: string; runningMs: number }> {
    const now = Date.now();
    return Array.from(this.processes.entries()).map(([pid, tracked]) => ({
      pid,
      label: tracked.label,
      runningMs: now - tracked.startedAt,
    }));
  }
}

/**
 * Convenience function to get the ProcessManager instance
 */
export function getProcessManager(): ProcessManager {
  return ProcessManager.getInstance();
}

/**
 * Create a timeout promise that rejects after the specified duration
 * Respects the ProcessManager's abort signal
 */
export function createTimeout(ms: number, message: string): Promise<never> {
  const pm = getProcessManager();

  return new Promise((_, reject) => {
    // If already aborted, reject immediately
    if (pm.isAborted) {
      reject(new Error("Operation cancelled"));
      return;
    }

    const timeoutId = setTimeout(() => {
      reject(new Error(message));
    }, ms);

    // Listen for abort signal
    pm.signal.addEventListener("abort", () => {
      clearTimeout(timeoutId);
      reject(new Error("Operation cancelled"));
    }, { once: true });
  });
}

/**
 * Race a promise against a timeout
 * Returns the promise result or throws on timeout/abort
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string
): Promise<T> {
  if (ms <= 0) return promise; // No timeout

  return Promise.race([
    promise,
    createTimeout(ms, message),
  ]);
}
