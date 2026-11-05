#!/usr/bin/env bun
/**
 * Entry point for mdflow CLI
 *
 * This is a minimal entry point that:
 * 1. Initializes ProcessManager for centralized lifecycle management
 * 2. Sets up EPIPE handlers for graceful pipe handling
 * 3. Creates a CliRunner with the real system environment
 * 4. Runs the CLI and exits with the appropriate code
 *
 * All orchestration logic is in CliRunner for testability.
 */

import { GLOBAL_HELP_TEXT } from "./help-text";

const isExactGlobalHelpRoute = (argv: string[]): boolean =>
  argv.length === 1 && ["help", "--help", "-h"].includes(argv[0]!);

function setupFastHelpEpipeHandlers(): void {
  const handleStreamError = (err: NodeJS.ErrnoException): void => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  };

  process.stdout.on("error", handleStreamError);
  process.stderr.on("error", handleStreamError);
}

async function main() {
  const [
    { CliRunner },
    { BunSystemEnvironment },
    { getProcessManager },
    { MdflowError, getErrorMessage },
  ] = await Promise.all([
    import("./cli-runner"),
    import("./system-environment"),
    import("./process-manager"),
    import("./errors"),
  ]);

  function printTopLevelError(err: InstanceType<typeof MdflowError>): void {
    console.error(`[${err.errorCode}] ${err.message}`);
  }

  function printUnknownTopLevelError(prefix: string, err: unknown): void {
    console.error(`[MDFLOW_UNKNOWN] ${prefix}${getErrorMessage(err)}`);
  }

  // Initialize ProcessManager early for centralized signal handling
  // This ensures cursor restoration and process cleanup on SIGINT/SIGTERM
  const pm = getProcessManager();
  pm.initialize();

  let shuttingDown = false;
  const shutdown = (exitCode: number): void => {
    if (shuttingDown) return;
    shuttingDown = true;

    pm.abort();

    try {
      pm.killAll();
    } catch {
      // Best-effort cleanup during shutdown
    }

    try {
      pm.restoreTerminal();
    } catch {
      // Best-effort cleanup during shutdown
    }

    // Let the active run unwind after its child is terminated. Forced exit
    // here bypasses runCommand finally blocks (including isolated-home
    // disposal). The normal top-level completion path exits afterward.
    process.exitCode = exitCode;
  };

  process.once("SIGINT", () => shutdown(130));
  process.once("SIGTERM", () => shutdown(143));

  process.once("uncaughtException", (err: Error) => {
    if (err instanceof MdflowError) {
      printTopLevelError(err);
      shutdown(err.code);
      return;
    }
    printUnknownTopLevelError("Uncaught exception: ", err);
    shutdown(1);
  });

  process.once("unhandledRejection", (reason: unknown) => {
    if (reason instanceof MdflowError) {
      printTopLevelError(reason);
      shutdown(reason.code);
      return;
    }
    printUnknownTopLevelError("Unhandled promise rejection: ", reason);
    shutdown(1);
  });

  // Handle EPIPE gracefully when downstream closes the pipe early
  // (e.g., `md task.md | head -n 5`)
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") {
      pm.restoreTerminal(); // Ensure cursor is visible
      process.exit(0);
    }
    throw err;
  });

  process.stderr.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") {
      pm.restoreTerminal(); // Ensure cursor is visible
      process.exit(0);
    }
    throw err;
  });

  // Create the runner with the real system environment
  const runner = new CliRunner({
    env: new BunSystemEnvironment(),
  });

  // Run the CLI and exit with the result code
  try {
    const result = await runner.run(process.argv);
    await pm.releaseResources();
    pm.restoreTerminal();
    process.exit(result.exitCode);
  } catch (err) {
    await pm.releaseResources();
    pm.restoreTerminal();
    if (err instanceof MdflowError) {
      printTopLevelError(err);
      process.exit(err.code);
    }
    printUnknownTopLevelError("", err);
    process.exit(1);
  }
}

if (isExactGlobalHelpRoute(process.argv.slice(2))) {
  setupFastHelpEpipeHandlers();
  console.log(GLOBAL_HELP_TEXT);
  process.exitCode = 0;
} else {
  void main();
}
