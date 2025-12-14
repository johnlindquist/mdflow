/**
 * CliRunner - Testable entry point for mdflow CLI
 *
 * This class encapsulates all orchestration logic from main(), accepting
 * a SystemEnvironment for dependency injection. This enables testing
 * without spawning actual subprocesses or touching the real filesystem.
 */

import { parseFrontmatter } from "./parse";
import { parseCliArgs, handleMaCommands } from "./cli";
import type { AgentFrontmatter, FormInputs } from "./types";
import {
  isFormInputs,
  isLegacyInputs,
  collectFormInputs,
  getFormInputDefaults,
  getMissingRequiredInputs,
} from "./form-inputs";
import { substituteTemplateVars, extractTemplateVars } from "./template";
import { isRemoteUrl, fetchRemote, cleanupRemote } from "./remote";
import {
  resolveCommand, buildArgs, runCommand, extractPositionalMappings,
  extractEnvVars, killCurrentChildProcess, hasInteractiveMarker,
} from "./command";
import { startSpinner } from "./spinner";
import { getProcessManager } from "./process-manager";
import {
  expandImports, hasImports,
  expandContentImports, expandCommandImports,
  hasContentImports, hasCommandImports
} from "./imports";
import {
  analyzeContext, printDashboard, shouldShowDashboard
} from "./context-dashboard";
import { loadEnvFiles } from "./env";
import {
  loadGlobalConfig, getCommandDefaults, applyDefaults, applyInteractiveMode,
} from "./config";
import {
  initLogger, getParseLogger, getTemplateLogger, getCommandLogger,
  getImportLogger, getCurrentLogPath,
} from "./logger";
import { isDomainTrusted, promptForTrust, addTrustedDomain, extractDomain } from "./trust";
import { dirname, resolve, join, delimiter, sep } from "path";
import { homedir } from "os";
// Lazy-load heavy dependencies for cold start optimization
import { exceedsLimit, StdinSizeLimitError } from "./limits";
import { countTokensAsync, estimateTokens } from "./tokenizer";
import {
  MarkdownAgentError, EarlyExitRequest, UserCancelledError, FileNotFoundError,
  NetworkError, SecurityError, ConfigurationError, TemplateError, ImportError,
} from "./errors";
import type { SystemEnvironment } from "./system-environment";
import { editPrompt } from "./edit-prompt";

// Lazy-load @inquirer/prompts input function
let _input: typeof import("@inquirer/prompts").input | null = null;
async function getInputPrompt() {
  if (!_input) {
    const mod = await import("@inquirer/prompts");
    _input = mod.input;
  }
  return _input;
}

// Lazy-load history module (only needed for frecency tracking)
let _recordUsage: typeof import("./history").recordUsage | null = null;
async function getRecordUsage() {
  if (!_recordUsage) {
    const mod = await import("./history");
    _recordUsage = mod.recordUsage;
  }
  return _recordUsage;
}

/** Result from CliRunner.run() */
export interface CliRunResult {
  exitCode: number;
  errorMessage?: string;
  logPath?: string | null;
}

/** Options for CliRunner */
export interface CliRunnerOptions {
  env: SystemEnvironment;
  processEnv?: Record<string, string | undefined>;
  cwd?: string;
  isStdinTTY?: boolean;
  stdinContent?: string;
  promptInput?: (message: string) => Promise<string>;
}

/** CliRunner - Main orchestrator for mdflow CLI */
export class CliRunner {
  private env: SystemEnvironment;
  private processEnv: Record<string, string | undefined>;
  private cwd: string;
  private isStdinTTY: boolean;
  private stdinContent: string | undefined;
  private promptInput: (message: string) => Promise<string>;

  constructor(options: CliRunnerOptions) {
    this.env = options.env;
    this.processEnv = options.processEnv ?? process.env;
    this.cwd = options.cwd ?? process.cwd();
    this.isStdinTTY = options.isStdinTTY ?? Boolean(process.stdin.isTTY);
    this.stdinContent = options.stdinContent;
    // Lazy-load input prompt only when actually needed
    this.promptInput = options.promptInput ?? (async (msg) => {
      const inputFn = await getInputPrompt();
      return inputFn({ message: msg });
    });
  }

  private async readStdin(): Promise<string> {
    if (this.stdinContent !== undefined) return this.stdinContent;
    if (this.isStdinTTY) return "";
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of process.stdin) {
      totalBytes += chunk.length;
      if (exceedsLimit(totalBytes)) throw new StdinSizeLimitError(totalBytes);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf-8").trim();
  }

  private writeStdout(data: string): void { console.log(data); }
  private writeStderr(data: string): void { console.error(data); }

  private printErrorWithLogPath(message: string, logPath: string | null): void {
    this.writeStderr(`\n${message}`);
    if (logPath) this.writeStderr(`   Detailed logs: ${logPath}`);
  }

  /**
   * Resolve file path by checking multiple locations in order:
   * 1. As-is (absolute path or relative to cwd)
   * 2. Project agents: ./.mdflow/<filename>
   * 3. User agents: ~/.mdflow/<filename>
   * 4. PATH directories (for files without path separators)
   */
  private async resolveFilePath(filePath: string): Promise<string> {
    // 1. Try as-is (could be absolute or relative from cwd)
    if (await this.env.fs.exists(filePath)) {
      return filePath;
    }

    // Only search directories for simple filenames (no path separators)
    // Check for both forward slash and platform-specific separator for cross-platform support
    if (!filePath.includes("/") && !filePath.includes(sep)) {
      // 2. Try ./.mdflow/
      const projectPath = join(this.cwd, ".mdflow", filePath);
      if (await this.env.fs.exists(projectPath)) {
        return projectPath;
      }

      // 3. Try ~/.mdflow/
      const userPath = join(homedir(), ".mdflow", filePath);
      if (await this.env.fs.exists(userPath)) {
        return userPath;
      }

      // 4. Try $PATH directories
      // Use path.delimiter for cross-platform support (: on Unix, ; on Windows)
      const pathDirs = (this.processEnv.PATH || "").split(delimiter);
      for (const dir of pathDirs) {
        if (!dir) continue;
        const pathFilePath = join(dir, filePath);
        if (await this.env.fs.exists(pathFilePath)) {
          return pathFilePath;
        }
      }
    }

    // Not found anywhere - return original for error message
    return filePath;
  }

  async run(argv: string[]): Promise<CliRunResult> {
    let logPath: string | null = null;
    try {
      return await this.runInternal(argv, (lp) => { logPath = lp; });
    } catch (err) {
      return this.handleError(err, logPath);
    }
  }

  private handleError(err: unknown, logPath: string | null): CliRunResult {
    if (err instanceof EarlyExitRequest) return { exitCode: err.code, logPath };
    if (err instanceof UserCancelledError) return { exitCode: err.code, logPath };
    if (err instanceof MarkdownAgentError) {
      this.printErrorWithLogPath(`Agent failed: ${err.message}`, logPath);
      return { exitCode: err.code, errorMessage: err.message, logPath };
    }
    const errorMessage = (err as Error).message;
    this.printErrorWithLogPath(`Agent failed: ${errorMessage}`, logPath);
    return { exitCode: 1, errorMessage, logPath };
  }

  private async runInternal(
    argv: string[],
    setLogPath: (lp: string | null) => void
  ): Promise<CliRunResult> {
    const cliArgs = parseCliArgs(argv);
    const subcommand = cliArgs.filePath;

    // Handle subcommands
    if (subcommand === "create") {
      const { runCreate } = await import("./create");
      await runCreate(cliArgs.passthroughArgs);
      return { exitCode: 0 };
    }
    if (subcommand === "setup") {
      const { runSetup } = await import("./setup");
      await runSetup();
      return { exitCode: 0 };
    }
    if (subcommand === "logs") {
      const { getLogDir, listLogDirs } = await import("./logger");
      this.writeStdout(`Log directory: ${getLogDir()}\n`);
      const dirs = listLogDirs();
      if (dirs.length === 0) {
        this.writeStdout("No agent logs yet. Run an agent to generate logs.");
      } else {
        this.writeStdout("Agent logs:");
        dirs.forEach((d) => this.writeStdout(`  ${d}/`));
      }
      return { exitCode: 0 };
    }
    if (subcommand === "explain") {
      const { runExplain } = await import("./explain");
      await runExplain(cliArgs.passthroughArgs);
      return { exitCode: 0 };
    }
    if (subcommand === "help") cliArgs.help = true;

    let filePath = cliArgs.filePath;
    let passthroughArgs = cliArgs.passthroughArgs;
    if (!filePath || subcommand === "help") {
      const result = await handleMaCommands(cliArgs);
      if (result.selectedFile) {
        filePath = result.selectedFile;
        // If dry-run was selected via Shift+Enter, inject the flag
        if (result.dryRun) {
          passthroughArgs = ["--_dry-run", ...passthroughArgs];
        }
      } else if (!result.handled) {
        this.writeStderr("Usage: md <file.md> [flags for command]");
        this.writeStderr("       md <command> [options]");
        this.writeStderr("\nCommands: create, setup, logs, help");
        this.writeStderr("Run 'md help' for more info");
        throw new ConfigurationError("No agent file specified", 1);
      }
    }

    return this.runAgent(filePath, passthroughArgs, setLogPath);
  }

  private async runAgent(
    filePath: string,
    passthroughArgs: string[],
    setLogPath: (lp: string | null) => void
  ): Promise<CliRunResult> {
    let localFilePath = filePath;
    let isRemote = false;

    // Check for --_no-cache flag early (needed before fetchRemote call)
    let noCacheFlag = false;
    const noCacheIdx = passthroughArgs.indexOf("--_no-cache");
    if (noCacheIdx !== -1) {
      noCacheFlag = true;
      passthroughArgs = [...passthroughArgs.slice(0, noCacheIdx), ...passthroughArgs.slice(noCacheIdx + 1)];
    }

    if (isRemoteUrl(filePath)) {
      const remoteResult = await fetchRemote(filePath, { noCache: noCacheFlag });
      if (!remoteResult.success) {
        throw new NetworkError(`Failed to fetch remote file: ${remoteResult.error}`);
      }
      localFilePath = remoteResult.localPath!;
      isRemote = true;
    } else {
      // Resolve local file path by checking multiple directories
      localFilePath = await this.resolveFilePath(filePath);
    }

    // Initialize ProcessManager for centralized lifecycle management
    const pm = getProcessManager();
    pm.initialize();

    // Register cleanup callback for remote file cleanup
    if (isRemote) {
      pm.onCleanup(() => cleanupRemote(localFilePath));
    }

    if (!(await this.env.fs.exists(localFilePath))) {
      throw new FileNotFoundError(`File not found: ${localFilePath}`);
    }

    const fileDir = dirname(resolve(localFilePath));
    await loadEnvFiles(fileDir);

    const logger = initLogger(localFilePath);
    const logPath = getCurrentLogPath();
    setLogPath(logPath);
    logger.info({ filePath: localFilePath }, "Session started");

    const stdinContent = await this.readStdin();
    const content = await this.env.fs.readText(localFilePath);
    const { frontmatter: baseFrontmatter, body: rawBody } = parseFrontmatter(content);
    getParseLogger().debug({ frontmatter: baseFrontmatter, bodyLength: rawBody.length }, "Frontmatter parsed");

    // Parse CLI flags
    const parsed = this.parseFlags(passthroughArgs);

    // Context-only mode: show dashboard and exit without executing
    if (parsed.contextOnly) {
      if (shouldShowDashboard(rawBody)) {
        const analysis = await analyzeContext(localFilePath, rawBody, fileDir);
        printDashboard(analysis);
      } else {
        this.writeStderr("No imports found in this agent file.");
      }
      if (isRemote) await cleanupRemote(localFilePath);
      throw new EarlyExitRequest();
    }

    const { command, frontmatter, templateVars, finalBody, args, positionalMappings } =
      await this.processAgent(localFilePath, baseFrontmatter, rawBody, stdinContent, parsed);

    // Show context dashboard before execution (unless --_quiet)
    if (!parsed.quiet && shouldShowDashboard(rawBody)) {
      const analysis = await analyzeContext(localFilePath, rawBody, fileDir);
      printDashboard(analysis);
    }

    // Dry run
    if (parsed.dryRun) {
      return this.handleDryRun(command, frontmatter, args, [finalBody], positionalMappings, logger, isRemote, localFilePath, logPath);
    }

    // Edit before execute
    let promptToRun = finalBody;
    if (parsed.editFlag) {
      const editResult = await editPrompt(finalBody);
      if (!editResult.confirmed || editResult.prompt === null) {
        if (isRemote) await cleanupRemote(localFilePath);
        logger.info({ editCancelled: true }, "Edit cancelled by user");
        throw new UserCancelledError("Edit cancelled by user");
      }
      promptToRun = editResult.prompt;
      getCommandLogger().debug({ originalLength: finalBody.length, editedLength: promptToRun.length }, "Prompt edited");
    }

    // TOFU check
    if (isRemote && !parsed.trustFlag) {
      await this.handleTOFU(filePath, localFilePath, command, baseFrontmatter, rawBody);
    }

    // Execute
    let finalRunArgs = args;
    if (frontmatter._subcommand) {
      const subs = Array.isArray(frontmatter._subcommand) ? frontmatter._subcommand : [frontmatter._subcommand];
      finalRunArgs = [...subs, ...args];
    }

    getCommandLogger().info({ command, argsCount: finalRunArgs.length, promptLength: promptToRun.length }, "Executing command");

    // Start spinner with command preview (will be stopped when first output arrives)
    const preview = formatCommandPreview(command, finalRunArgs);
    startSpinner(preview);

    // Determine if we should capture output for post-run menu
    // Only capture when: TTY, not piped, menu not disabled
    const shouldShowMenu = this.isStdinTTY && !parsed.noMenu;
    const captureMode = shouldShowMenu ? "tee" as const : false;

    const runResult = await runCommand({
      command, args: finalRunArgs, positionals: [promptToRun], positionalMappings, captureOutput: captureMode, env: extractEnvVars(frontmatter), rawOutput: parsed.rawOutput,
    });

    getCommandLogger().info({ exitCode: runResult.exitCode }, "Command completed");

    // Record usage for frecency tracking (skip for failed runs, lazy-load history)
    if (runResult.exitCode === 0) {
      getRecordUsage().then(recordUsage => recordUsage(localFilePath)).catch(() => {}); // Fire and forget
    }

    if (isRemote) await cleanupRemote(localFilePath);

    if (runResult.exitCode !== 0) {
      this.printErrorWithLogPath(`Agent exited with code ${runResult.exitCode}`, logPath);
    }

    // Show post-run action menu if enabled and we have output
    if (shouldShowMenu && runResult.stdout) {
      try {
        const { showPostRunMenu, executePostRunAction } = await import("./post-run-menu");
        const menuResult = await showPostRunMenu(runResult.stdout);
        if (menuResult && menuResult.action !== "exit") {
          await executePostRunAction(menuResult, runResult.stdout);
        }
      } catch {
        // Menu cancelled or failed, just continue
      }
    }

    logger.info({ exitCode: runResult.exitCode }, "Session ended");
    return { exitCode: runResult.exitCode, logPath };
  }

  private parseFlags(passthroughArgs: string[]) {
    let remainingArgs = [...passthroughArgs];
    let commandFromCli: string | undefined;
    let dryRun = false, trustFlag = false, interactiveFromCli = false, noCache = false, rawOutput = false, editFlag = false;
    let contextOnly = false, quiet = false, noMenu = false;
    let cwdFromCli: string | undefined;

    const cmdIdx = remainingArgs.findIndex((a) => a === "--_command" || a === "-_c");
    if (cmdIdx !== -1 && cmdIdx + 1 < remainingArgs.length) {
      commandFromCli = remainingArgs[cmdIdx + 1];
      remainingArgs.splice(cmdIdx, 2);
    }
    const dryIdx = remainingArgs.indexOf("--_dry-run");
    if (dryIdx !== -1) { dryRun = true; remainingArgs.splice(dryIdx, 1); }
    const editIdx = remainingArgs.indexOf("--_edit");
    if (editIdx !== -1) { editFlag = true; remainingArgs.splice(editIdx, 1); }
    const trustIdx = remainingArgs.indexOf("--_trust");
    if (trustIdx !== -1) { trustFlag = true; remainingArgs.splice(trustIdx, 1); }
    const noCacheIdx = remainingArgs.indexOf("--_no-cache");
    if (noCacheIdx !== -1) { noCache = true; remainingArgs.splice(noCacheIdx, 1); }
    const noMenuIdx = remainingArgs.indexOf("--_no-menu");
    if (noMenuIdx !== -1) { noMenu = true; remainingArgs.splice(noMenuIdx, 1); }
    const intIdx = remainingArgs.findIndex((a) => a === "--_interactive" || a === "-_i");
    if (intIdx !== -1) { interactiveFromCli = true; remainingArgs.splice(intIdx, 1); }
    const cwdIdx = remainingArgs.findIndex((a) => a === "--_cwd");
    if (cwdIdx !== -1 && cwdIdx + 1 < remainingArgs.length) {
      cwdFromCli = remainingArgs[cwdIdx + 1];
      remainingArgs.splice(cwdIdx, 2);
    }
    // --raw flag: output raw markdown without rendering (for piping)
    const rawIdx = remainingArgs.indexOf("--raw");
    if (rawIdx !== -1) { rawOutput = true; remainingArgs.splice(rawIdx, 1); }
    // Context dashboard flags
    const contextIdx = remainingArgs.indexOf("--_context");
    if (contextIdx !== -1) { contextOnly = true; remainingArgs.splice(contextIdx, 1); }
    const quietIdx = remainingArgs.indexOf("--_quiet");
    if (quietIdx !== -1) { quiet = true; remainingArgs.splice(quietIdx, 1); }

    return { remainingArgs, commandFromCli, dryRun, editFlag, trustFlag, interactiveFromCli, cwdFromCli, noCache, rawOutput, contextOnly, quiet, noMenu };
  }

  private async processAgent(
    localFilePath: string,
    baseFrontmatter: Record<string, unknown>,
    rawBody: string,
    stdinContent: string,
    parsed: ReturnType<typeof this.parseFlags>
  ) {
    const { remainingArgs, commandFromCli, interactiveFromCli, cwdFromCli } = parsed;
    let remaining = [...remainingArgs];

    // Resolve command
    let command: string;
    if (commandFromCli) {
      command = commandFromCli;
      getCommandLogger().debug({ command, source: "cli" }, "Command from --_command flag");
    } else {
      command = resolveCommand(localFilePath);
      getCommandLogger().debug({ command }, "Command resolved");
    }

    await loadGlobalConfig();
    const commandDefaults = await getCommandDefaults(command);
    let frontmatter = applyDefaults(baseFrontmatter as AgentFrontmatter, commandDefaults);
    const interactiveFromFilename = hasInteractiveMarker(localFilePath);
    frontmatter = applyInteractiveMode(frontmatter, command, interactiveFromFilename || interactiveFromCli);

    const envVars = extractEnvVars(frontmatter);
    if (envVars) Object.entries(envVars).forEach(([k, v]) => { this.processEnv[k] = v; });

    // Template vars - all use _prefix (e.g., _name in frontmatter → {{ _name }} in body)
    let templateVars: Record<string, string> = {};

    // Inject stdin as _stdin template variable
    if (stdinContent) {
      templateVars["_stdin"] = stdinContent;
    }

    // Extract _varname fields from frontmatter and match with --_varname CLI flags
    // Variables starting with _ are template variables (except internal keys)
    const internalKeys = new Set(["_interactive", "_i", "_cwd", "_subcommand"]);
    const namedVarFields = Object.keys(frontmatter).filter((k) => k.startsWith("_") && !internalKeys.has(k));
    for (const key of namedVarFields) {
      const defaultValue = frontmatter[key];
      // CLI flag matches the full key including underscore: --_name
      const flag = `--${key}`;
      const idx = remaining.findIndex((a) => a === flag);
      const flagValue = idx !== -1 && idx + 1 < remaining.length ? remaining[idx + 1] : undefined;
      if (flagValue !== undefined) {
        templateVars[key] = flagValue;
        remaining.splice(idx, 2);
      } else if (defaultValue != null && defaultValue !== "") {
        templateVars[key] = String(defaultValue);
      }
    }

    // Also extract any --_varname CLI flags not declared in frontmatter
    // This allows optional template vars without frontmatter declaration
    // Supports both --_key value and --_key=value syntax
    for (let i = remaining.length - 1; i >= 0; i--) {
      const arg = remaining[i];
      if (!arg) continue;
      // Check for --_key=value syntax
      if (arg.startsWith("--_") && arg.includes("=")) {
        const eqIndex = arg.indexOf("=");
        const key = arg.slice(2, eqIndex); // Remove -- and get key before =
        if (!internalKeys.has(key)) {
          templateVars[key] = arg.slice(eqIndex + 1);
          remaining.splice(i, 1);
        }
      } else if (arg.startsWith("--_") && !internalKeys.has(arg.slice(2))) {
        const key = arg.slice(2); // Remove --
        const nextArg = remaining[i + 1];
        if (i + 1 < remaining.length && nextArg && !nextArg.startsWith("-")) {
          templateVars[key] = nextArg;
          remaining.splice(i, 2);
        } else {
          // Boolean flag without value
          templateVars[key] = "true";
          remaining.splice(i, 1);
        }
      }
    }

    // Inject positional CLI args as template variables (_1, _2, etc.)
    // First, separate flags from positional args in remaining
    const positionalCliArgs: string[] = [];
    const flagArgs: string[] = [];
    for (let i = 0; i < remaining.length; i++) {
      const arg = remaining[i];
      if (!arg) continue;
      if (arg.startsWith("-")) {
        // It's a flag - include it and its value if present
        flagArgs.push(arg);
        const nextArg = remaining[i + 1];
        if (i + 1 < remaining.length && nextArg && !nextArg.startsWith("-")) {
          flagArgs.push(nextArg);
          i++;
        }
      } else {
        // It's a positional arg
        positionalCliArgs.push(arg);
      }
    }
    // Inject positional args as _1, _2, etc. template variables
    // Uses underscore prefix to match other template var conventions
    for (let i = 0; i < positionalCliArgs.length; i++) {
      const posArg = positionalCliArgs[i];
      if (posArg) templateVars[`_${i + 1}`] = posArg;
    }
    // Inject _args as all positional args formatted as a numbered list
    if (positionalCliArgs.length > 0) {
      templateVars["_args"] = positionalCliArgs.map((arg, i) => `${i + 1}. ${arg}`).join("\n");
    }
    // Update remaining to only contain flag args (positionals consumed for templates)
    remaining = flagArgs;

    // 3-Phase Import Pipeline:
    // Phase 1: Expand content imports (file, glob, url, symbol) - leave commands untouched
    // Phase 2: LiquidJS template processing ({% capture %}, {{ var }}, etc.)
    // Phase 3: Expand command imports with resolved template vars

    const fileDir = dirname(resolve(localFilePath));
    const commandCwd = cwdFromCli ?? (frontmatter._cwd as string | undefined) ?? this.cwd;

    // Phase 1: Expand content imports only
    let phase1Body = rawBody;
    if (hasContentImports(rawBody)) {
      try {
        getImportLogger().debug({ fileDir, commandCwd }, "Phase 1: Expanding content imports");
        phase1Body = await expandContentImports(rawBody, fileDir, new Set(), false, {
          invocationCwd: commandCwd,
        });
        getImportLogger().debug({ originalLength: rawBody.length, expandedLength: phase1Body.length }, "Phase 1 complete");
      } catch (err) {
        getImportLogger().error({ error: (err as Error).message }, "Phase 1 import expansion failed");
        throw new ImportError(`Import error: ${(err as Error).message}`);
      }
    }

    // Handle form inputs if using the new object format
    if (isFormInputs(frontmatter._inputs)) {
      const formInputs = frontmatter._inputs as FormInputs;

      // Apply defaults from form input definitions
      const defaults = getFormInputDefaults(formInputs);
      for (const [key, value] of Object.entries(defaults)) {
        if (!(key in templateVars)) {
          templateVars[key] = value;
        }
      }

      // In interactive mode, collect missing form inputs via prompts
      if (this.isStdinTTY) {
        const collected = await collectFormInputs(formInputs, templateVars);
        Object.assign(templateVars, collected);
      } else {
        // In non-interactive mode, check for missing required inputs
        const missingRequired = getMissingRequiredInputs(formInputs, templateVars);
        if (missingRequired.length > 0) {
          throw new TemplateError(`Missing required form inputs: ${missingRequired.join(", ")}. Provide values via CLI flags (e.g., --${missingRequired[0]} value)`);
        }
      }
    }

    // Check for missing template vars (based on Phase 1 result)
    // This handles both legacy _inputs and template vars not defined in form inputs
    const requiredVars = extractTemplateVars(phase1Body);
    const missingVars = requiredVars.filter((v) => !(v in templateVars));
    if (missingVars.length > 0) {
      if (this.isStdinTTY) {
        this.writeStderr("Missing required variables. Please provide values:");
        for (const v of missingVars) templateVars[v] = await this.promptInput(`${v}:`);
      } else {
        throw new TemplateError(`Missing template variables: ${missingVars.join(", ")}. Use '_inputs:' in frontmatter to map CLI arguments to variables`);
      }
    }

    // Phase 2: LiquidJS template substitution
    getTemplateLogger().debug({ vars: Object.keys(templateVars) }, "Phase 2: Substituting template variables");
    const phase2Body = substituteTemplateVars(phase1Body, templateVars);
    getTemplateLogger().debug({ bodyLength: phase2Body.length }, "Phase 2 complete");

    // Phase 3: Expand command imports with resolved template vars
    let phase3Body = phase2Body;
    if (hasCommandImports(phase2Body)) {
      try {
        getImportLogger().debug({ commandCwd, templateVarCount: Object.keys(templateVars).length }, "Phase 3: Expanding command imports");
        phase3Body = await expandCommandImports(phase2Body, fileDir, false, {
          invocationCwd: commandCwd,
          templateVars,
        });
        getImportLogger().debug({ expandedLength: phase3Body.length }, "Phase 3 complete");
      } catch (err) {
        getImportLogger().error({ error: (err as Error).message }, "Phase 3 command expansion failed");
        throw new ImportError(`Command error: ${(err as Error).message}`);
      }
    }

    // Cat file if no frontmatter
    if (Object.keys(baseFrontmatter).length === 0 && !commandDefaults) {
      try { resolveCommand(localFilePath); }
      catch { this.writeStdout(await this.env.fs.readText(localFilePath)); throw new EarlyExitRequest(); }
    }

    let finalBody = phase3Body;

    const templateVarSet = new Set(Object.keys(templateVars));
    const args = [...buildArgs(frontmatter, templateVarSet), ...remaining];
    const positionalMappings = extractPositionalMappings(frontmatter);

    return { command, frontmatter, templateVars, finalBody, args, positionalMappings };
  }

  private async handleDryRun(
    command: string, frontmatter: Record<string, unknown>, args: string[],
    positionals: string[], positionalMappings: Map<number, string>,
    logger: ReturnType<typeof initLogger>, isRemote: boolean, localFilePath: string, logPath: string | null
  ): Promise<CliRunResult> {
    this.writeStdout("═══════════════════════════════════════════════════════════");
    this.writeStdout("DRY RUN - Command will NOT be executed");
    this.writeStdout("═══════════════════════════════════════════════════════════\n");

    let dryRunArgs = [...args];
    if (frontmatter._subcommand) {
      const subCmd = frontmatter._subcommand;
      const subs = Array.isArray(subCmd) ? subCmd.map(String) : [String(subCmd)];
      dryRunArgs = [...subs, ...dryRunArgs];
    }

    for (let i = 0; i < positionals.length; i++) {
      const pos = i + 1, value = positionals[i] ?? "";
      if (positionalMappings.has(pos)) {
        const flagName = positionalMappings.get(pos)!;
        dryRunArgs.push(flagName.length === 1 ? `-${flagName}` : `--${flagName}`, `"${value.replace(/"/g, '\\"')}"`);
      } else {
        dryRunArgs.push(`"${value.replace(/"/g, '\\"')}"`);
      }
    }

    this.writeStdout("Command:");
    this.writeStdout(`   ${command} ${dryRunArgs.join(" ")}\n`);
    this.writeStdout("Final Prompt:");
    this.writeStdout("───────────────────────────────────────────────────────────");
    this.writeStdout(positionals[0] ?? "");
    this.writeStdout("───────────────────────────────────────────────────────────\n");
    // Use async token counting to avoid loading tokenizer eagerly
    const tokenCount = await countTokensAsync(positionals[0] ?? "");
    this.writeStdout(`Estimated tokens: ~${tokenCount.toLocaleString()}`);

    if (isRemote) await cleanupRemote(localFilePath);
    logger.info({ dryRun: true }, "Dry run completed");
    throw new EarlyExitRequest();
  }

  private async handleTOFU(
    filePath: string, localFilePath: string, command: string,
    baseFrontmatter: Record<string, unknown>, rawBody: string
  ): Promise<void> {
    const domain = extractDomain(filePath);
    const trusted = await isDomainTrusted(filePath);

    if (!trusted) {
      if (!this.isStdinTTY) {
        await cleanupRemote(localFilePath);
        throw new SecurityError(`Untrusted remote domain: ${domain}. Use --_trust flag to bypass this check in non-interactive mode, or run interactively to add the domain to known_hosts.`);
      }

      const trustResult = await promptForTrust(filePath, command, baseFrontmatter as AgentFrontmatter, rawBody);
      if (!trustResult.approved) {
        await cleanupRemote(localFilePath);
        throw new UserCancelledError("Execution cancelled by user");
      }
      if (trustResult.rememberDomain) {
        await addTrustedDomain(filePath);
        this.writeStderr(`\nDomain ${domain} added to known_hosts.\n`);
      }
    } else {
      getCommandLogger().debug({ domain }, "Domain already trusted");
    }
  }
}

/**
 * Format a command preview for the spinner message
 * Shows command + subcommands + key flags in a concise format
 */
function formatCommandPreview(command: string, args: string[], maxLength = 60): string {
  // Build a representation: command subcommand flag1 flag2 ...
  const parts = [command];

  // First, add any leading non-flag args (subcommands like "exec")
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (!arg || arg.startsWith("-")) break;
    // Include subcommands (short non-flag args)
    if (arg.length <= 20) {
      parts.push(arg);
    }
    i++;
  }

  // Then add flags and their short values
  for (; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;

    if (arg.startsWith("-")) {
      // It's a flag - add it
      parts.push(arg);
      // Check if next arg is a short value (not another flag)
      const nextArg = args[i + 1];
      if (nextArg && !nextArg.startsWith("-") && nextArg.length <= 20) {
        parts.push(nextArg);
        i++;
      }
    }
  }

  let preview = parts.join(" ");

  // Truncate if too long
  if (preview.length > maxLength) {
    preview = preview.slice(0, maxLength - 3) + "...";
  }

  return preview;
}

/** Create a CliRunner with the given environment */
export function createCliRunner(env: SystemEnvironment, options?: Partial<Omit<CliRunnerOptions, "env">>): CliRunner {
  return new CliRunner({ env, ...options });
}
