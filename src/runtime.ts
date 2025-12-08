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
import { expandImports, hasImports } from "./imports";
import { loadEnvFiles } from "./env";
import { loadGlobalConfig, getCommandDefaults, applyDefaults } from "./config";
import { initLogger, getParseLogger, getTemplateLogger, getCommandLogger, getImportLogger, getCurrentLogPath } from "./logger";
import type { AgentFrontmatter } from "./types";
import type { RunResult } from "./command";

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
  /** Command override (from CLI --command flag) */
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
        throw new Error(`Failed to fetch remote file: ${remoteResult.error}`);
      }
      localPath = remoteResult.localPath!;
      isRemote = true;
    }

    // Store for cleanup
    this.isRemote = isRemote;
    this.localFilePath = localPath;

    const file = Bun.file(localPath);

    if (!await file.exists()) {
      throw new Error(`File not found: ${localPath}`);
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

    if (hasImports(rawBody)) {
      try {
        getImportLogger().debug({ directory: resolved.directory }, "Expanding imports");
        expandedBody = await expandImports(rawBody, resolved.directory, new Set());
        getImportLogger().debug({ originalLength: rawBody.length, expandedLength: expandedBody.length }, "Imports expanded");
      } catch (err) {
        getImportLogger().error({ error: (err as Error).message }, "Import expansion failed");
        throw new Error(`Import error: ${(err as Error).message}`);
      }
    }

    return {
      frontmatter,
      rawBody,
      expandedBody,
      command,
      directory: resolved.directory,
      envVars,
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

    // Consume named positional arguments from CLI (args: in frontmatter)
    if (frontmatter.args && Array.isArray(frontmatter.args)) {
      const requiredArgs = frontmatter.args;

      for (const argName of requiredArgs) {
        // Find the first non-flag argument
        const argIndex = remainingArgs.findIndex(arg => !arg.startsWith("-"));

        if (argIndex !== -1) {
          templateVars[argName] = remainingArgs[argIndex];
          // Consume it so it isn't passed to the command
          remainingArgs.splice(argIndex, 1);
        }
      }
    }

    // Extract $varname fields from frontmatter and match with --varname CLI flags
    const namedVarFields = Object.keys(frontmatter)
      .filter(key => key.startsWith("$") && !/^\$\d+$/.test(key));

    for (const key of namedVarFields) {
      const varName = key.slice(1); // Remove $ prefix
      const defaultValue = frontmatter[key];

      // Look for --varname or --var-name (convert underscores to hyphens for matching)
      const flagVariants = [
        `--${varName}`,
        `--${varName.replace(/_/g, "-")}`,
      ];

      let foundInCli = false;
      for (const flag of flagVariants) {
        const flagIndex = remainingArgs.findIndex(arg => arg === flag);
        if (flagIndex !== -1 && flagIndex + 1 < remainingArgs.length) {
          templateVars[varName] = remainingArgs[flagIndex + 1];
          // Consume both flag and value
          remainingArgs.splice(flagIndex, 2);
          foundInCli = true;
          break;
        }
      }

      // Use default value from frontmatter if not provided via CLI
      if (!foundInCli && defaultValue !== undefined && defaultValue !== null && defaultValue !== "") {
        templateVars[varName] = String(defaultValue);
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
        throw new Error(
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
    const { command, envVars } = context;
    const { body, args, positionalMappings } = processed;

    // Build final prompt with stdin
    let finalBody = body;
    if (options.stdinContent) {
      finalBody = `<stdin>\n${options.stdinContent}\n</stdin>\n\n${finalBody}`;
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
        const finalBody = options.stdinContent
          ? `<stdin>\n${options.stdinContent}\n</stdin>\n\n${processed.body}`
          : processed.body;

        console.log("═══════════════════════════════════════════════════════════");
        console.log("DRY RUN - Command will NOT be executed");
        console.log("═══════════════════════════════════════════════════════════\n");

        console.log("Command:");
        console.log(`   ${context.command} ${processed.args.join(" ")}\n`);

        console.log("Final Prompt:");
        console.log("───────────────────────────────────────────────────────────");
        console.log(finalBody);
        console.log("───────────────────────────────────────────────────────────\n");

        const estimatedTokens = Math.ceil(finalBody.length / 4);
        console.log(`Estimated tokens: ~${estimatedTokens.toLocaleString()}`);

        await this.cleanup();

        return {
          exitCode: 0,
          logPath: this.logPath,
          dryRun: true,
        };
      }

      // Phase 4: Execution
      const result = await this.execute(context, processed, options);

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
