/**
 * AgentRuntime - Pipeline-based execution for markdown agents
 *
 * Refactors the monolithic main() into distinct phases:
 * 1. ResolutionPhase - Determine if source is local file or remote URL
 * 2. ContextPhase - Handle imports, globs, and file expansion
 * 3. TemplatePhase - LiquidJS variable substitution
 * 4. ExecutionPhase - Build args and spawn subprocess
 */

import { dirname, resolve } from "path";
import { parseFrontmatter } from "./parse";
import { substituteTemplateVars, extractTemplateVars } from "./template";
import { isRemoteUrl, fetchRemote, cleanupRemote } from "./remote";
import { resolveCommand, buildArgs, runCommand, extractPositionalMappings, extractEnvVars, killCurrentChildProcess } from "./command";
import { expandImports, hasImports, type ResolvedImportsTracker } from "./imports";
import { loadEnvFiles } from "./env";
import { loadGlobalConfig, getCommandDefaults, applyDefaults } from "./config";
import { initLogger, getParseLogger, getTemplateLogger, getCommandLogger, getImportLogger, getCurrentLogPath } from "./logger";
import type { AgentFrontmatter, ExecutionPlan } from "./types";
import type { RunResult } from "./command";
import { countTokens } from "./tokenizer";
import {
  FileNotFoundError,
  NetworkError,
  ImportError,
  TemplateError,
  HookError,
} from "./errors";
import { maskArgsArray } from "./secrets";

/**
 * Run a lifecycle hook command and capture its output
 *
 * @param command - Shell command to execute
 * @param cwd - Working directory for the command
 * @param env - Additional environment variables
 * @returns The stdout output from the command
 * @throws Error if the command fails (non-zero exit code)
 */
async function runHookCommand(
  command: string,
  cwd: string,
  env?: Record<string, string>
): Promise<string> {
  const proc = Bun.spawn(["sh", "-c", command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const errorMsg = stderr.trim() || `Command exited with code ${exitCode}`;
    throw new HookError(`Hook command failed: ${errorMsg}`);
  }

  return stdout;
}

/**
 * Result of the resolution phase
 */
export interface ResolvedSource {
  /** Whether source is local or remote */
  type: "local" | "remote";
  /** The file content */
  content: string;
  /** Local file path (original or temp file for remote) */
  path: string;
  /** Original source (file path or URL) */
  originalSource: string;
  /** Directory containing the file */
  directory: string;
}

/**
 * Result of the context building phase
 */
export interface AgentContext {
  /** Parsed frontmatter configuration */
  frontmatter: AgentFrontmatter;
  /** Raw body before template substitution */
  rawBody: string;
  /** Body with imports expanded */
  expandedBody: string;
  /** Resolved command to execute */
  command: string;
  /** Directory containing the agent file */
  directory: string;
  /** Environment variables from frontmatter */
  envVars?: Record<string, string>;
  /** Output from pre/before hook (prepended to body) */
  preHookOutput?: string;
  /** Post/after hook command to run after execution */
  postHookCommand?: string;
  /** List of resolved imports (files and URLs) */
  resolvedImports: string[];
}

/**
 * Result of the template processing phase
 */
export interface ProcessedTemplate {
  /** Final body after template substitution */
  body: string;
  /** Template variables that were used */
  templateVars: Record<string, string>;
  /** CLI args built from frontmatter */
  args: string[];
  /** Positional mappings from frontmatter */
  positionalMappings: Map<number, string>;
}

/**
 * Options for running an agent
 */
export interface RuntimeOptions {
  /** Command override (from CLI --_command flag) */
  command?: string;
  /** Passthrough args for the command */
  passthroughArgs?: string[];
  /** Stdin content if piped */
  stdinContent?: string;
  /** Dry run mode - don't execute, just show what would run */
  dryRun?: boolean;
  /** Whether to capture command output */
  captureOutput?: boolean;
  /** Template variables provided externally */
  templateVars?: Record<string, string>;
  /** Prompt for missing variables (requires TTY) */
  promptForMissing?: (varName: string) => Promise<string>;
  /**
   * Return structured ExecutionPlan without logging to console
   * When true, dry-run returns ExecutionPlan instead of logging
   */
  returnPlan?: boolean;
}

/**
 * Result of a complete agent run
 */
export interface RuntimeResult {
  /** Exit code from the command */
  exitCode: number;
  /** Captured output (if captureOutput was true) */
  output?: string;
  /** Path to log file */
  logPath: string | null;
  /** Whether this was a dry run */
  dryRun: boolean;
  /** Structured execution plan (when returnPlan is true or dryRun is true) */
  plan?: ExecutionPlan;
}

/**
 * AgentRuntime - Orchestrates the execution of markdown agents
 *
 * Provides a clean pipeline architecture with distinct phases that can be
 * tested and used independently.
 */
export class AgentRuntime {
  private logPath: string | null = null;
  private isRemote: boolean = false;
  private localFilePath: string = "";

  /**
   * Resolution Phase - Determine source type and load content
   *
   * @param source - File path or URL to the agent markdown
   * @returns Resolved source information
   */
  async resolve(source: string): Promise<ResolvedSource> {
    let localPath = source;
    let isRemote = false;

    if (isRemoteUrl(source)) {
      const remoteResult = await fetchRemote(source);
      if (!remoteResult.success) {
        throw new NetworkError(`Failed to fetch remote file: ${remoteResult.error}`);
      }
      localPath = remoteResult.localPath!;
      isRemote = true;
    }

    // Store for cleanup
    this.isRemote = isRemote;
    this.localFilePath = localPath;

    const file = Bun.file(localPath);

    if (!await file.exists()) {
      throw new FileNotFoundError(`File not found: ${localPath}`);
    }

    const content = await file.text();
    const directory = dirname(resolve(localPath));

    return {
      type: isRemote ? "remote" : "local",
      content,
      path: localPath,
      originalSource: source,
      directory,
    };
  }

  /**
   * Context Phase - Parse frontmatter, expand imports, resolve command
   *
   * @param resolved - Resolved source from resolution phase
   * @param options - Runtime options
   * @returns Agent context with expanded content
   */
  async buildContext(
    resolved: ResolvedSource,
    options: RuntimeOptions = {}
  ): Promise<AgentContext> {
    // Load .env files from the markdown file's directory
    await loadEnvFiles(resolved.directory);

    // Initialize logger for this agent
    initLogger(resolved.path);
    this.logPath = getCurrentLogPath();

    // Parse frontmatter
    const { frontmatter: baseFrontmatter, body: rawBody } = parseFrontmatter(resolved.content);
    getParseLogger().debug({ frontmatter: baseFrontmatter, bodyLength: rawBody.length }, "Frontmatter parsed");

    // Resolve command: options.command > filename pattern
    let command: string;
    if (options.command) {
      command = options.command;
      getCommandLogger().debug({ command, source: "options" }, "Command from options");
    } else {
      command = resolveCommand(resolved.path);
      getCommandLogger().debug({ command }, "Command resolved from filename");
    }

    // Load global config and apply command defaults
    await loadGlobalConfig();
    const commandDefaults = await getCommandDefaults(command);
    const frontmatter = applyDefaults(baseFrontmatter, commandDefaults);

    // Extract and apply environment variables (object form) to process.env
    // This must happen BEFORE import expansion so !`command` inlines can use them
    const envVars = extractEnvVars(frontmatter);
    if (envVars) {
      for (const [key, value] of Object.entries(envVars)) {
        process.env[key] = value;
      }
    }

    // Expand @file imports and !`command` inlines
    let expandedBody = rawBody;
    const resolvedImports: ResolvedImportsTracker = [];

    if (hasImports(rawBody)) {
      try {
        getImportLogger().debug({ directory: resolved.directory }, "Expanding imports");
        expandedBody = await expandImports(rawBody, resolved.directory, new Set(), false, resolvedImports);
        getImportLogger().debug({ originalLength: rawBody.length, expandedLength: expandedBody.length }, "Imports expanded");
      } catch (err) {
        getImportLogger().error({ error: (err as Error).message }, "Import expansion failed");
        throw new ImportError(`Import error: ${(err as Error).message}`);
      }
    }

    // Run pre/before lifecycle hook
    const preCommandRaw = frontmatter.pre || frontmatter.before;
    const preCommand = typeof preCommandRaw === 'string' ? preCommandRaw : undefined;
    let preHookOutput: string | undefined;

    if (preCommand) {
      getCommandLogger().debug({ preCommand }, "Running pre hook");
      try {
        preHookOutput = await runHookCommand(preCommand, resolved.directory, envVars);
        getCommandLogger().debug({ outputLength: preHookOutput.length }, "Pre hook completed");
      } catch (err) {
        getCommandLogger().error({ error: (err as Error).message }, "Pre hook failed");
        throw new HookError(`Pre hook failed: ${(err as Error).message}`);
      }
    }

    // Capture post/after hook command for later execution
    const postHookRaw = frontmatter.post || frontmatter.after;
    const postHookCommand = typeof postHookRaw === 'string' ? postHookRaw : undefined;

    return {
      frontmatter,
      rawBody,
      expandedBody,
      command,
      directory: resolved.directory,
      envVars,
      preHookOutput,
      postHookCommand,
      resolvedImports,
    };
  }

  /**
   * Template Phase - Substitute template variables
   *
   * @param context - Agent context from context phase
   * @param options - Runtime options with template vars and passthrough args
   * @returns Processed template with final body and args
   */
  async processTemplate(
    context: AgentContext,
    options: RuntimeOptions = {}
  ): Promise<ProcessedTemplate> {
    const { frontmatter, expandedBody } = context;
    let remainingArgs = [...(options.passthroughArgs || [])];
    let templateVars: Record<string, string> = { ...(options.templateVars || {}) };

    // Inject stdin as _stdin template variable
    if (options.stdinContent) {
      templateVars["_stdin"] = options.stdinContent;
    }

    // Extract _varname fields from frontmatter and match with --_varname CLI flags
    // Variables starting with _ are template variables (except internal keys)
    const internalKeys = new Set(["_interactive", "_i", "_cwd", "_subcommand"]);
    const namedVarFields = Object.keys(frontmatter)
      .filter(key => key.startsWith("_") && !internalKeys.has(key));

    for (const key of namedVarFields) {
      const defaultValue = frontmatter[key];

      // CLI flag matches the full key including underscore: --_name
      const flag = `--${key}`;
      const flagIndex = remainingArgs.findIndex(arg => arg === flag);

      const flagValue = remainingArgs[flagIndex + 1];
      if (flagIndex !== -1 && flagIndex + 1 < remainingArgs.length && flagValue !== undefined) {
        templateVars[key] = flagValue;
        // Consume both flag and value
        remainingArgs.splice(flagIndex, 2);
      } else if (defaultValue !== undefined && defaultValue !== null && defaultValue !== "") {
        // Use default value from frontmatter if not provided via CLI
        templateVars[key] = String(defaultValue);
      }
    }

    // Check for missing template variables
    const requiredVars = extractTemplateVars(expandedBody);
    const missingVars = requiredVars.filter(v => !(v in templateVars));

    if (missingVars.length > 0) {
      if (options.promptForMissing) {
        // Interactive mode - prompt for missing vars
        for (const v of missingVars) {
          templateVars[v] = await options.promptForMissing(v);
        }
      } else {
        // Non-interactive - throw error
        throw new TemplateError(
          `Missing template variables: ${missingVars.join(", ")}. ` +
          `Use 'args:' in frontmatter to map CLI arguments to variables`
        );
      }
    }

    // Apply template substitution to body
    getTemplateLogger().debug({ vars: Object.keys(templateVars) }, "Substituting template variables");
    const body = substituteTemplateVars(expandedBody, templateVars);
    getTemplateLogger().debug({ bodyLength: body.length }, "Template substitution complete");

    // Build CLI args from frontmatter + remaining passthrough args
    const templateVarSet = new Set(Object.keys(templateVars));
    const args = [
      ...buildArgs(frontmatter, templateVarSet),
      ...remainingArgs,
    ];

    // Extract positional mappings ($1, $2, etc.)
    const positionalMappings = extractPositionalMappings(frontmatter);

    return {
      body,
      templateVars,
      args,
      positionalMappings,
    };
  }

  /**
   * Execution Phase - Build final args and run the command
   *
   * @param context - Agent context
   * @param processed - Processed template
   * @param options - Runtime options
   * @returns Run result with exit code
   */
  async execute(
    context: AgentContext,
    processed: ProcessedTemplate,
    options: RuntimeOptions = {}
  ): Promise<RunResult> {
    const { command, envVars, preHookOutput } = context;
    const { body, args, positionalMappings } = processed;

    // Build final prompt with pre-hook output
    // Note: stdin is injected as $stdin template variable during processTemplate phase
    let finalBody = body;

    // Prepend pre-hook output if present
    if (preHookOutput) {
      finalBody = `${preHookOutput.trim()}\n\n${finalBody}`;
    }

    // Build positionals array: body is $1
    const positionals = [finalBody];

    getCommandLogger().info({ command, argsCount: args.length, promptLength: finalBody.length }, "Executing command");

    const result = await runCommand({
      command,
      args,
      positionals,
      positionalMappings,
      captureOutput: options.captureOutput ?? false,
      env: envVars,
    });

    getCommandLogger().info({ exitCode: result.exitCode }, "Command completed");

    return result;
  }

  /**
   * Run a complete agent pipeline
   *
   * Orchestrates all phases: resolve -> buildContext -> processTemplate -> execute
   *
   * @param source - File path or URL to the agent markdown
   * @param options - Runtime options
   * @returns Complete runtime result
   */
  async run(source: string, options: RuntimeOptions = {}): Promise<RuntimeResult> {
    try {
      // Phase 1: Resolution
      const resolved = await this.resolve(source);

      // Phase 2: Context Building
      const context = await this.buildContext(resolved, options);

      // Phase 3: Template Processing
      const processed = await this.processTemplate(context, options);

      // Handle dry-run mode
      if (options.dryRun) {
        let finalBody = processed.body;

        // Prepend pre-hook output if present
        if (context.preHookOutput) {
          finalBody = `${context.preHookOutput.trim()}\n\n${finalBody}`;
        }
        // Note: stdin is already substituted as $stdin during processTemplate phase

        // Use real token counting instead of approximation
        const estimatedTokens = countTokens(finalBody);

        // Convert positionalMappings Map to plain object for ExecutionPlan
        const positionalMappingsObj: Record<number, string> = {};
        for (const [key, value] of processed.positionalMappings.entries()) {
          positionalMappingsObj[key] = value;
        }

        // Build the structured execution plan
        const plan: ExecutionPlan = {
          type: "dry-run",
          finalPrompt: finalBody,
          command: context.command,
          args: processed.args,
          env: context.envVars || {},
          estimatedTokens,
          frontmatter: context.frontmatter,
          resolvedImports: context.resolvedImports,
          templateVars: processed.templateVars,
          positionalMappings: positionalMappingsObj,
        };

        // Only log to console if not in returnPlan mode (backward compatibility for CLI)
        if (!options.returnPlan) {
          console.log("═══════════════════════════════════════════════════════════");
          console.log("DRY RUN - Command will NOT be executed");
          console.log("═══════════════════════════════════════════════════════════\n");

          console.log("Command:");
          // Mask sensitive argument values in console output
          console.log(`   ${context.command} ${maskArgsArray(processed.args).join(" ")}\n`);

          console.log("Final Prompt:");
          console.log("───────────────────────────────────────────────────────────");
          console.log(finalBody);
          console.log("───────────────────────────────────────────────────────────\n");

          console.log(`Estimated tokens: ~${estimatedTokens.toLocaleString()}`);
        }

        await this.cleanup();

        return {
          exitCode: 0,
          logPath: this.logPath,
          dryRun: true,
          plan,
        };
      }

      // Phase 4: Execution
      const result = await this.execute(context, processed, options);

      // Phase 5: Post hook (if configured)
      if (context.postHookCommand) {
        getCommandLogger().debug({ postCommand: context.postHookCommand }, "Running post hook");
        try {
          await runHookCommand(context.postHookCommand, context.directory, {
            ...context.envVars,
            MA_EXIT_CODE: String(result.exitCode),
          });
          getCommandLogger().debug("Post hook completed");
        } catch (err) {
          getCommandLogger().error({ error: (err as Error).message }, "Post hook failed");
          // Post hook failures are logged but don't change the exit code
        }
      }

      await this.cleanup();

      return {
        exitCode: result.exitCode,
        output: result.output,
        logPath: this.logPath,
        dryRun: false,
      };

    } catch (err) {
      await this.cleanup();
      throw err;
    }
  }

  /**
   * Cleanup resources (remote temp files)
   */
  async cleanup(): Promise<void> {
    if (this.isRemote && this.localFilePath) {
      await cleanupRemote(this.localFilePath);
    }
  }

  /**
   * Get the current log path
   */
  getLogPath(): string | null {
    return this.logPath;
  }

  /**
   * Kill the current child process if running
   */
  killChildProcess(): boolean {
    return killCurrentChildProcess();
  }

  /**
   * Setup signal handlers for graceful shutdown
   */
  setupSignalHandlers(): void {
    const handleSignal = async (signal: string) => {
      this.killChildProcess();
      await this.cleanup();

      // Exit with appropriate code (128 + signal number)
      // SIGINT = 2, SIGTERM = 15
      const exitCode = signal === "SIGINT" ? 130 : 143;
      process.exit(exitCode);
    };

    process.on("SIGINT", () => handleSignal("SIGINT"));
    process.on("SIGTERM", () => handleSignal("SIGTERM"));
  }
}

/**
 * Create a new AgentRuntime instance
 */
export function createRuntime(): AgentRuntime {
  return new AgentRuntime();
}

// Re-export ExecutionPlan for convenience
export type { ExecutionPlan } from "./types";

// Re-export streams utilities for testability
export {
  createDefaultStreams,
  createTestStreams,
  stringToStream,
  createCaptureStream,
  readStream,
  readStdinFromStreams,
  isInteractive,
  writeStdout,
  writeStderr,
} from "./streams";

// Re-export IOStreams type
export type { IOStreams } from "./types";
