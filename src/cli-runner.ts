/**
 * CliRunner - Testable entry point for mdflow CLI
 *
 * This class encapsulates all orchestration logic from main(), accepting
 * a SystemEnvironment for dependency injection. This enables testing
 * without spawning actual subprocesses or touching the real filesystem.
 */

import { parseFrontmatter } from "./parse";
import { parseCliArgs, handleMaCommands } from "./cli";
import { subcommandHelpText, COMMAND_LIST_LINE } from "./command-help";
import type {
  AgentFrontmatter,
  CommandDefaults,
  FormInputs,
  StructuredOutputConfig,
} from "./types";
import type { AdhocCommandResult } from "./adhoc-command";
import {
  isFormInputs,
  isLegacyInputs,
  collectFormInputs,
  getFormInputDefaults,
  getMissingRequiredInputs,
} from "./form-inputs";
import { substituteTemplateVars, extractTemplateVars } from "./template";
import {
  resolveEngine, type EngineSource, buildArgs, runCommand, extractPositionalMappings,
  extractEnvVars, killCurrentChildProcess, hasInteractiveMarker,
} from "./command";
import type { ParsedWorkflow, WorkflowResult } from "./workflow";
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
  loadFullConfig, applyDefaults, applyInteractiveMode, isInteractiveModeEnabled,
} from "./config";
import { getAdapter as getEngineAdapter } from "./adapters";
import {
  applyIsolationDefaults,
  resolveIsolationMode,
  resolveIsolationDefaults,
} from "./isolation";
import { extractSystemPromptSpec, applySystemPromptToFrontmatter } from "./system-prompt";
import {
  initLogger, getParseLogger, getTemplateLogger, getCommandLogger,
  getImportLogger, getCurrentLogPath, getLogger, resetLogger,
} from "./logger";
import { isDomainTrusted, promptForTrust, addTrustedDomain, extractDomain } from "./trust";
import { basename, dirname, resolve, join, delimiter, sep } from "path";
import { homedir } from "os";
import { existsSync } from "node:fs";
// Lazy-load heavy dependencies for cold start optimization
import { exceedsLimit, StdinSizeLimitError } from "./limits";
import { countTokensAsync, estimateTokens } from "./tokenizer";
import {
  MarkdownAgentError, EarlyExitRequest, UserCancelledError, FileNotFoundError,
  NetworkError, SecurityError, ConfigurationError, TemplateError, ImportError,
} from "./errors";
import type { RunRecord } from "./telemetry";
import { compatNotice, isCompatOnlyFrontmatter, stampCompatFile } from "./compat";
import type { SystemEnvironment } from "./system-environment";
import { maskArgsArray } from "./secrets";
import { isRegistryPath, resolveProjectRootWith } from "./project-root";

function isRemoteUrl(path: string): boolean {
  return path.startsWith("http://") || path.startsWith("https://");
}

/**
 * Registry-installed flows (`.mdflow/registry/` at project or user scope)
 * carry remote provenance even though they live on disk: `md install` only
 * ever downloads the flow markdown, so a sibling hooks program there was
 * never consented to. They share the remote flows' hooks trust boundary.
 * Realpath-aware (src/project-root.ts) — a symlink outside the registry
 * cannot launder a registry flow into local provenance.
 */
function isRegistryFlowPath(path: string): boolean {
  return isRegistryPath(path);
}

async function cleanupRemoteFile(localFilePath: string): Promise<void> {
  const { cleanupRemote } = await import("./remote");
  await cleanupRemote(localFilePath);
}

function isAdhocInvocationCandidate(argv: string[]): boolean {
  return [argv[1], argv[0]].some((value) => {
    if (!value) return false;
    const name = basename(value).replace(/\.(ts|js|mjs|cjs)$/, "");
    return /^md(?:\.i)?\.[a-z][a-z0-9-]*$/i.test(name);
  });
}

// Lazy-load the controlled input prompt so CLI startup does not pay for the
// interactive prompt stack and Tab can never leak into text answers.
let _input: typeof import("./workbench-input").tabSafeInput | null = null;
async function getInputPrompt() {
  if (!_input) {
    const mod = await import("./workbench-input");
    _input = mod.tabSafeInput;
  }
  return _input;
}

// Lazy-load history module (only needed for frecency tracking and variable persistence)
let _recordUsage: typeof import("./history").recordUsage | null = null;
let _getVariableHistory: typeof import("./history").getVariableHistory | null = null;
let _saveVariableValues: typeof import("./history").saveVariableValues | null = null;

async function getRecordUsage() {
  if (!_recordUsage) {
    const mod = await import("./history");
    _recordUsage = mod.recordUsage;
  }
  return _recordUsage;
}

async function getVariableHistoryFn() {
  if (!_getVariableHistory) {
    const mod = await import("./history");
    _getVariableHistory = mod.getVariableHistory;
  }
  return _getVariableHistory;
}

async function getSaveVariableValuesFn() {
  if (!_saveVariableValues) {
    const mod = await import("./history");
    _saveVariableValues = mod.saveVariableValues;
  }
  return _saveVariableValues;
}

type StructuredOutputFormat = NonNullable<StructuredOutputConfig["format"]>;

interface OutputModule {
  extractStructured: (stdout: string, format?: StructuredOutputFormat) => unknown;
  validateOutput?: (
    schemaRef: string,
    value: unknown,
    options?: { baseDir?: string }
  ) => Promise<unknown>;
  validate?: (
    schemaRef: string,
    value: unknown,
    options?: { baseDir?: string }
  ) => Promise<unknown>;
  sinkOutput?: (...args: unknown[]) => Promise<unknown> | unknown;
  sinkSave?: (
    targetPath: string,
    value: unknown,
    format: StructuredOutputFormat,
    options?: { cwd?: string }
  ) => Promise<string>;
  sinkApplyPatch?: (patchText: string, options?: { cwd?: string }) => void;
}

/** Result from CliRunner.run() */
export interface CliRunResult {
  exitCode: number;
  errorMessage?: string;
  logPath?: string | null;
}

interface JsonModePayload {
  exitCode: number;
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
}

interface JsonModeState {
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  hasCommandResult: boolean;
}

/**
 * Interactive engines treat any positional prompt as a submitted first turn.
 * A blank interactive body therefore means no positional argument at all.
 */
export function promptPositionals(prompt: string, interactive: boolean): string[] {
  return interactive && !prompt.trim() ? [] : [prompt];
}

/** Options for CliRunner */
export interface CliRunnerOptions {
  env: SystemEnvironment;
  processEnv?: Record<string, string | undefined>;
  cwd?: string;
  isStdinTTY?: boolean;
  isStdoutTTY?: boolean;
  stdinContent?: string;
  promptInput?: (message: string) => Promise<string>;
  /** Custom prompt with history function (for testing) */
  promptInputWithHistory?: (message: string, defaultValue?: string) => Promise<string>;
  /** Command executor override for deterministic orchestration tests. */
  runCommandFn?: typeof runCommand;
}

/** CliRunner - Main orchestrator for mdflow CLI */
export class CliRunner {
  private env: SystemEnvironment;
  private processEnv: Record<string, string | undefined>;
  private cwd: string;
  private isStdinTTY: boolean;
  private isStdoutTTY: boolean;
  private stdinContent: string | undefined;
  private promptInput: (message: string) => Promise<string>;
  private promptInputWithHistory: (message: string, defaultValue?: string) => Promise<string>;
  private runCommandFn: typeof runCommand;
  private jsonModeState: JsonModeState | null = null;

  constructor(options: CliRunnerOptions) {
    this.env = options.env;
    this.processEnv = options.processEnv ?? process.env;
    this.cwd = options.cwd ?? process.cwd();
    this.isStdinTTY = options.isStdinTTY ?? Boolean(process.stdin.isTTY);
    this.isStdoutTTY = options.isStdoutTTY ?? Boolean(process.stdout.isTTY);
    this.stdinContent = options.stdinContent;
    // Lazy-load input prompt only when actually needed
    this.promptInput = options.promptInput ?? (async (msg) => {
      const inputFn = await getInputPrompt();
      return inputFn({ message: msg });
    });
    // Prompt with history shows previous value as default
    // Format: "Variable name: (previous_value) _" - press Enter to accept
    this.promptInputWithHistory = options.promptInputWithHistory ?? (async (msg, defaultValue) => {
      const inputFn = await getInputPrompt();
      return inputFn({ message: msg, default: defaultValue });
    });
    this.runCommandFn = options.runCommandFn ?? runCommand;
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

  // Draining stdin blocks until EOF, and a headless caller (hook, cron job,
  // detached agent) can hand us a descriptor that never closes. Reading is
  // therefore deferred until the expanded template actually references
  // {{ _stdin }}, and memoized so it is drained at most once per process.
  private stdinReadOnce: Promise<string> | undefined;
  private readStdinOnce(): Promise<string> {
    return (this.stdinReadOnce ??= this.readStdin());
  }

  private writeStdout(data: string): void { console.log(data); }
  private writeStderr(data: string): void { console.error(data); }

  /**
   * Directory whose project config governs this run. Eval children execute
   * inside sandbox cwds; MDFLOW_CONFIG_CWD (set by the eval runner) points
   * back at the flow's own project so config resolution — and therefore the
   * behavior a receipt fingerprints — matches a normal run of the flow.
   */
  private configCwd(): string {
    const override = this.processEnv.MDFLOW_CONFIG_CWD?.trim();
    return override ? override : this.cwd;
  }

  private printErrorWithLogPath(message: string, logPath: string | null): void {
    this.writeStderr(`\n${message}`);
    if (logPath) this.writeStderr(`   Detailed logs: ${logPath}`);
  }

  // A bare token like `md reviw` is more likely a mistyped command or flow
  // name than a file path, so the error should point at both namespaces.
  private fileNotFoundMessage(requested: string, resolved: string): string {
    const looksLikeName =
      !requested.includes("/") &&
      !requested.includes("\\") &&
      !/\.md$/i.test(requested);
    if (looksLikeName) {
      return `No command or flow named "${requested}". Run 'md help' for commands, or 'md roster --json' to list flows.`;
    }
    return `File not found: ${resolved}`;
  }

  /**
   * Resolve file path by checking multiple locations in order:
   * 1. As-is (absolute path or relative to cwd)
   * 2. Project flow roster: ./flows/<filename>
   * 3. Legacy project agents: ./.mdflow/<filename>
   * 4. User agents: ~/.mdflow/<filename>
   * 5. PATH directories (for files without path separators)
   *
   * Simple flow names may omit the .md extension (`md review`).
   */
  private async resolveFilePath(filePath: string): Promise<string> {
    const simpleName = !filePath.includes("/") && !filePath.includes(sep);
    const candidateNames = simpleName && !filePath.toLowerCase().endsWith(".md")
      ? [filePath, `${filePath}.md`]
      : [filePath];

    // 1. Try as-is (could be absolute or relative from cwd)
    for (const candidate of candidateNames) {
      if (await this.env.fs.exists(candidate)) {
        return candidate;
      }
    }

    // Only search directories for simple filenames (no path separators)
    // Check for both forward slash and platform-specific separator for cross-platform support
    if (simpleName) {
      const { projectRoot } = await resolveProjectRootWith(this.cwd, this.env.fs);

      // 2. Try the canonical roster at the nearest project root.
      for (const candidate of candidateNames) {
        const rosterPath = join(projectRoot, "flows", candidate);
        if (await this.env.fs.exists(rosterPath)) {
          return rosterPath;
        }
      }

      // 3. Try the legacy project directory at the same project root.
      for (const candidate of candidateNames) {
        const projectPath = join(projectRoot, ".mdflow", candidate);
        if (await this.env.fs.exists(projectPath)) {
          return projectPath;
        }
      }

      // 4. Try ~/.mdflow/
      for (const candidate of candidateNames) {
        const userPath = join(homedir(), ".mdflow", candidate);
        if (await this.env.fs.exists(userPath)) {
          return userPath;
        }
      }

      // 5. Try $PATH directories
      // Use path.delimiter for cross-platform support (: on Unix, ; on Windows)
      const pathDirs = (this.processEnv.PATH || "").split(delimiter);
      for (const dir of pathDirs) {
        if (!dir) continue;
        for (const candidate of candidateNames) {
          const pathFilePath = join(dir, candidate);
          if (await this.env.fs.exists(pathFilePath)) {
            return pathFilePath;
          }
        }
      }
    }

    // Not found anywhere - return original for error message
    return filePath;
  }

  private parseRegistryArgs(args: string[]): { scope?: "project" | "user"; positional: string[] } {
    let scope: "project" | "user" | undefined;
    const positional: string[] = [];

    for (const arg of args) {
      if (arg === "--project" || arg === "-p") {
        scope = "project";
        continue;
      }
      if (arg === "--global" || arg === "-g" || arg === "--user") {
        scope = "user";
        continue;
      }
      positional.push(arg);
    }

    return { scope, positional };
  }

  private resetJsonModeState(): void {
    this.jsonModeState = {
      command: "",
      args: [],
      stdout: "",
      stderr: "",
      hasCommandResult: false,
    };
  }

  private formatConsoleArgs(args: unknown[]): string {
    return args.map((arg) => {
      if (typeof arg === "string") return arg;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    }).join(" ");
  }

  private buildSpawnArgs(
    args: string[],
    positionals: string[],
    positionalMappings: Map<number, string>
  ): string[] {
    const finalArgs = [...args];
    for (let i = 0; i < positionals.length; i++) {
      const pos = i + 1;
      const value = positionals[i];
      if (value === undefined) continue;
      if (positionalMappings.has(pos)) {
        const flag = positionalMappings.get(pos)!;
        finalArgs.push(flag.length === 1 ? `-${flag}` : `--${flag}`, value);
      } else {
        finalArgs.push(value);
      }
    }
    return finalArgs;
  }

  private recordJsonCommand(command: string, args: string[]): void {
    if (!this.jsonModeState) return;
    this.jsonModeState.command = command;
    this.jsonModeState.args = [...args];
  }

  private recordJsonResult(stdout: string, stderr: string): void {
    if (!this.jsonModeState) return;
    this.jsonModeState.stdout = stdout;
    this.jsonModeState.stderr = stderr;
    this.jsonModeState.hasCommandResult = true;
  }

  private buildJsonModePayload(
    result: CliRunResult,
    capturedStdout: string[],
    capturedStderr: string[]
  ): JsonModePayload {
    const state = this.jsonModeState;
    const joinedStdout = capturedStdout.join("\n");
    const joinedStderr = capturedStderr.join("\n");
    const hasCommandResult = state?.hasCommandResult ?? false;

    const stdout = hasCommandResult ? (state?.stdout ?? "") : joinedStdout;

    let stderr = hasCommandResult ? (state?.stderr ?? "") : joinedStderr;
    if (hasCommandResult && joinedStderr.trim().length > 0) {
      stderr = [stderr, joinedStderr].filter(Boolean).join("\n");
    }
    if (!stderr && result.errorMessage) stderr = result.errorMessage;

    return {
      exitCode: result.exitCode,
      command: state?.command ?? "",
      args: state?.args ?? [],
      stdout,
      stderr,
    };
  }

  private async executeCommand(
    ctx: Parameters<typeof runCommand>[0],
    jsonMode: boolean
  ): Promise<Awaited<ReturnType<typeof runCommand>>> {
    if (!jsonMode) return this.runCommandFn(ctx);

    const spawnArgs = this.buildSpawnArgs(ctx.args, ctx.positionals, ctx.positionalMappings);
    this.recordJsonCommand(ctx.command, spawnArgs);

    const originalLog = console.log;
    const originalError = console.error;
    console.log = () => {};
    console.error = () => {};

    try {
      const result = await this.runCommandFn(ctx);
      this.recordJsonResult(result.stdout, result.stderr);
      return result;
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
  }

  private calculateOutputBytes(stdout: string, stderr: string): number {
    return Buffer.byteLength(stdout, "utf-8") + Buffer.byteLength(stderr, "utf-8");
  }

  private calculateWorkflowOutputBytes(workflowResult: WorkflowResult): number {
    let totalOutputBytes = 0;
    for (const stepId of workflowResult.stepOrder) {
      const step = workflowResult.steps[stepId];
      if (!step) continue;
      totalOutputBytes += this.calculateOutputBytes(step.stdout, step.stderr);
    }
    return totalOutputBytes;
  }

  private async recordRunTelemetry(params: {
    agentPath: string;
    tool: string;
    durationMs: number;
    exitCode: number;
    outputBytes: number;
    currentState: "adhoc_command_completed" | "workflow_completed" | "command_completed";
  }): Promise<void> {
    const runRecord: RunRecord = {
      agentPath: params.agentPath,
      tool: params.tool,
      durationMs: params.durationMs,
      exitCode: params.exitCode,
      outputBytes: params.outputBytes,
      timestamp: new Date().toISOString(),
    };

    try {
      const { recordRun } = await import("./telemetry");
      await recordRun(runRecord);
      getCommandLogger().debug(
        {
          currentState: params.currentState,
          agentPath: runRecord.agentPath,
          tool: runRecord.tool,
          durationMs: runRecord.durationMs,
          exitCode: runRecord.exitCode,
          outputBytes: runRecord.outputBytes,
        },
        "Run telemetry recorded"
      );
    } catch (err) {
      const failureMessage = err instanceof Error ? err.message : String(err);
      getCommandLogger().error(
        {
          attempted: "recordRun",
          failed: failureMessage,
          currentState: params.currentState,
          runRecord,
        },
        "Run telemetry recording failed"
      );
    }
  }

  /**
   * After a successful run, record the running mdflow version in the flow's
   * `_compat` frontmatter key. Skipped for remote flows (the local file is a
   * throwaway copy) and eval runs (isolated workspaces; MDFLOW_EVAL_RUN=1).
   * Best-effort: a failed stamp never affects the run's outcome.
   */
  private stampCompatAfterSuccess(localFilePath: string, isRemote: boolean): void {
    if (isRemote || process.env.MDFLOW_EVAL_RUN === "1") return;
    try {
      if (stampCompatFile(resolve(localFilePath))) {
        getCommandLogger().debug({ agentPath: localFilePath }, "Stamped _compat version");
      }
    } catch {
      // Never let version stamping interfere with a successful run.
    }
  }

  async run(argv: string[]): Promise<CliRunResult> {
    const jsonMode = argv.includes("--json");
    const subcommand = parseCliArgs(argv).filePath;
    const nativeJsonSubcommand = subcommand !== undefined
      && ["eval", "evolve", "feedback", "complain", "roster", "explain", "render"].includes(subcommand);
    let logPath: string | null = null;
    // Structured lifecycle commands own their JSON schema. Letting the generic
    // flow wrapper capture them would double-encode their payload in `stdout`.
    if (!jsonMode || nativeJsonSubcommand) {
      try {
        return await this.runInternal(argv, (lp) => { logPath = lp; });
      } catch (err) {
        return this.handleError(err, logPath);
      }
    }

    this.resetJsonModeState();

    const capturedStdout: string[] = [];
    const capturedStderr: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;

    console.log = (...args: unknown[]) => {
      capturedStdout.push(this.formatConsoleArgs(args));
    };
    console.error = (...args: unknown[]) => {
      capturedStderr.push(this.formatConsoleArgs(args));
    };

    let result: CliRunResult = { exitCode: 1 };
    try {
      try {
        result = await this.runInternal(argv, (lp) => { logPath = lp; });
      } catch (err) {
        result = this.handleError(err, logPath);
      }
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }

    const payload = this.buildJsonModePayload(result, capturedStdout, capturedStderr);
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    this.jsonModeState = null;
    return result;
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
    // Check for ad-hoc command invocation (md.claude, md.gemini, etc.)
    if (isAdhocInvocationCandidate(argv)) {
      const { detectAdhocCommand } = await import("./adhoc-command");
      const adhocResult = detectAdhocCommand(argv);
      if (adhocResult.isAdhoc) {
        return this.runAdhocCommand(adhocResult, setLogPath);
      }
    }

    const cliArgs = parseCliArgs(argv);
    const subcommand = cliArgs.filePath;
    const jsonModeRequested = cliArgs.passthroughArgs.includes("--json");
    const registryArgs = this.parseRegistryArgs(cliArgs.passthroughArgs);

    // Central --help gate: management commands must print usage and exit 0
    // before any filesystem, network, registry, or prompt work. Commands with
    // their own safe help renderers (create, init, eval, evolve, feedback,
    // complain) return undefined here and handle --help themselves.
    if (
      cliArgs.passthroughArgs.includes("--help") ||
      cliArgs.passthroughArgs.includes("-h")
    ) {
      const helpText = subcommandHelpText(subcommand);
      if (helpText) {
        this.writeStdout(helpText);
        return { exitCode: 0 };
      }
    }

    // Handle subcommands
    if (subcommand === "init") {
      const { runInit } = await import("./init");
      return { exitCode: await runInit(cliArgs.passthroughArgs) };
    }
    if (subcommand === "create") {
      const { runCreate } = await import("./create");
      const createResult = await runCreate(cliArgs.passthroughArgs, {
        isStdinTTY: this.isStdinTTY,
        cwd: this.cwd,
      });
      return { exitCode: createResult.status === "conflict" ? 1 : 0 };
    }
    if (subcommand === "setup") {
      // Setup is an interactive wizard end to end; without a TTY it would
      // emit inquirer control sequences into a pipe instead of prompting.
      if (!this.isStdinTTY || !this.isStdoutTTY) {
        this.writeStderr("md setup requires an interactive terminal (TTY_REQUIRED).");
        this.writeStderr("It edits shell config files and always confirms first, so it cannot run in a pipe.");
        this.writeStderr("Run 'md setup' in a terminal, or see 'md setup --help'.");
        return { exitCode: 1 };
      }
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
    if (subcommand === "install") {
      const { installAgent } = await import("./registry");
      const spec = registryArgs.positional[0];
      if (!spec) {
        throw new ConfigurationError("Usage: md install <url|gh:org/repo/path/to/agent.md@ref>", 1);
      }

      const installed = await installAgent(spec, { scope: registryArgs.scope, cwd: this.cwd });
      this.writeStdout(`Installed: ${installed.name}`);
      this.writeStdout(`  Source: ${installed.source}`);
      if (installed.resolvedRef) {
        this.writeStdout(`  Resolved ref: ${installed.resolvedRef}`);
      }
      this.writeStdout(`  Scope: ${installed.scope}`);
      this.writeStdout(`  Path: ${installed.installedPath}`);
      this.writeStdout(`  SHA-256: ${installed.sha256}`);
      return { exitCode: 0 };
    }
    if (subcommand === "remove") {
      const { removeAgent } = await import("./registry");
      const name = registryArgs.positional[0];
      if (!name) {
        throw new ConfigurationError("Usage: md remove <agent-name>", 1);
      }

      const removed = await removeAgent(name, { scope: registryArgs.scope, cwd: this.cwd });
      if (!removed.removed) {
        throw new ConfigurationError(`Registry agent not found: ${name}`, 1);
      }

      this.writeStdout(`Removed: ${removed.name} (${removed.removedFrom.join(", ")})`);
      return { exitCode: 0 };
    }
    if (subcommand === "list") {
      const { listAgents } = await import("./registry");
      const agents = await listAgents({ scope: registryArgs.scope, cwd: this.cwd });
      if (agents.length === 0) {
        this.writeStdout("No registry agents installed.");
        return { exitCode: 0 };
      }

      this.writeStdout("Registry agents:");
      for (const agent of agents) {
        this.writeStdout(`  ${agent.name} [${agent.scope}]`);
        this.writeStdout(`    source: ${agent.source}`);
        if (agent.resolvedRef) {
          this.writeStdout(`    resolvedRef: ${agent.resolvedRef}`);
        }
        this.writeStdout(`    sha256: ${agent.sha256}`);
        this.writeStdout(`    path: ${agent.installedPath}`);
        this.writeStdout(`    installedAt: ${agent.installedAt}`);
      }
      return { exitCode: 0 };
    }
    if (subcommand === "explain") {
      const { runExplain } = await import("./explain");
      await runExplain(cliArgs.passthroughArgs);
      return { exitCode: 0 };
    }
    if (subcommand === "render") {
      const { runRender } = await import("./render");
      return { exitCode: await runRender(cliArgs.passthroughArgs, this.cwd) };
    }
    if (subcommand === "hooks") {
      const { runHooksCli } = await import("./hooks-cli");
      return {
        exitCode: await runHooksCli(cliArgs.passthroughArgs, {
          cwd: this.cwd,
          isTTY: this.isStdinTTY && this.isStdoutTTY,
        }),
      };
    }
    if (subcommand === "roster") {
      const { runRoster } = await import("./roster");
      return { exitCode: await runRoster(cliArgs.passthroughArgs, this.cwd) };
    }
    if (subcommand === "eval") {
      const { runEvalCommand } = await import("./evals-cli");
      return {
        exitCode: await runEvalCommand(cliArgs.passthroughArgs, {
          cwd: this.cwd,
          isTTY: this.isStdinTTY && this.isStdoutTTY,
        }),
      };
    }
    if (subcommand === "evolve") {
      const { runEvolveCli } = await import("./evolve");
      return { exitCode: await runEvolveCli(cliArgs.passthroughArgs) };
    }
    if (subcommand === "complain") {
      const { runComplainCli } = await import("./evolve");
      return { exitCode: runComplainCli(cliArgs.passthroughArgs) };
    }
    if (subcommand === "feedback") {
      const { runFeedbackCli } = await import("./evolve");
      return { exitCode: runFeedbackCli(cliArgs.passthroughArgs) };
    }
    if (subcommand === "help") cliArgs.help = true;

    let filePath = cliArgs.filePath;
    let passthroughArgs = cliArgs.passthroughArgs;

    // `md --version`: capability handshake for machine callers (Flow UX
    // Protocol). Prints the bare version string and exits 0.
    if (!filePath && (passthroughArgs.includes("--version") || passthroughArgs.includes("-v"))) {
      const { mdflowVersion } = await import("./compat");
      this.writeStdout(mdflowVersion());
      return { exitCode: 0 };
    }

    if (!filePath || subcommand === "help") {
      if (jsonModeRequested && !filePath && subcommand !== "help") {
        this.writeStderr("Usage: md <file.md> [flags for command]");
        this.writeStderr("       md <command> [options]");
        this.writeStderr(`\n${COMMAND_LIST_LINE}`);
        this.writeStderr("Run 'md help' for more info, 'md roster --json' to list flows,");
        this.writeStderr("or 'md' with no arguments to open the Flow Workbench");
        throw new ConfigurationError("No agent file specified", 1);
      }
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
        this.writeStderr(`\n${COMMAND_LIST_LINE}`);
        this.writeStderr("Run 'md help' for more info, 'md roster --json' to list flows,");
        this.writeStderr("or 'md' with no arguments to open the Flow Workbench");
        throw new ConfigurationError("No agent file specified", 1);
      }
    }

    // NDJSON run event stream (Flow UX Protocol v1). stdout is protocol-pure;
    // the flag is consumed here and never reaches the engine.
    if (passthroughArgs.includes("--events")) {
      return this.runAgentEvents(
        filePath,
        passthroughArgs.filter((arg) => arg !== "--events"),
        setLogPath
      );
    }

    return this.runAgent(filePath, passthroughArgs, setLogPath);
  }

  /**
   * Handle ad-hoc command execution (md.claude, md.gemini, etc.)
   *
   * Creates a virtual agent from the raw prompt and runs it through the normal flow.
   */
  private async runAdhocCommand(
    adhocResult: AdhocCommandResult,
    setLogPath: (lp: string | null) => void
  ): Promise<CliRunResult> {
    const { command, body, passthroughArgs = [], interactive = false } = adhocResult;

    if (!command) {
      throw new ConfigurationError("No command detected in ad-hoc invocation", 1);
    }

    if (!body) {
      this.writeStderr(`Usage: md.${command} "your prompt here" [flags]`);
      this.writeStderr(`       md.i.${command} "prompt" # for interactive mode`);
      this.writeStderr(`\nExamples:`);
      this.writeStderr(`  md.${command} "What is 2+2?"`);
      this.writeStderr(`  md.${command} "Explain this: @error.log" --model opus`);
      throw new ConfigurationError("No prompt provided", 1);
    }

    // Create virtual agent content and filename
    const { createVirtualAgentContent, createVirtualFilename } = await import("./adhoc-command");
    const virtualContent = createVirtualAgentContent(command, body, interactive);
    const virtualFilename = createVirtualFilename(command, interactive);

    // Add interactive flag to passthrough args if needed
    const finalPassthroughArgs = interactive && !passthroughArgs.includes("--_interactive")
      ? ["--_interactive", ...passthroughArgs]
      : passthroughArgs;

    // Run through the normal agent flow using the virtual filename for command resolution
    // We need to create a temporary in-memory approach - but since runAgent needs a file path,
    // we'll use a special virtual file approach

    return this.runVirtualAgent(virtualFilename, virtualContent, finalPassthroughArgs, setLogPath);
  }

  /**
   * Run a virtual agent (content provided directly, not from a file)
   */
  private async runVirtualAgent(
    virtualFilename: string,
    content: string,
    passthroughArgs: string[],
    setLogPath: (lp: string | null) => void
  ): Promise<CliRunResult> {
    // Initialize ProcessManager for centralized lifecycle management
    const pm = getProcessManager();
    pm.initialize();

    // Parse md-owned flags before creating a file logger so previews remain
    // side-effect free and never load Pino.
    const parsed = this.parseFlags(passthroughArgs);
    resetLogger();
    let logPath: string | null = null;
    setLogPath(null);
    const startLogger = (): void => {
      const logger = initLogger(virtualFilename);
      logPath = getCurrentLogPath();
      setLogPath(logPath);
      logger.info({ virtualFilename, adhoc: true }, "Ad-hoc session started");
    };

    const { frontmatter: baseFrontmatter, body: rawBody } = parseFrontmatter(content);
    getParseLogger().debug({ frontmatter: baseFrontmatter, bodyLength: rawBody.length, adhoc: true }, "Virtual frontmatter parsed");

    const { command, frontmatter, templateVars, finalBody, args, positionalMappings, interactiveMode } =
      await this.processAgent(
        virtualFilename,
        baseFrontmatter,
        rawBody,
        () => this.readStdinOnce(),
        parsed,
        parsed.dryRun ? undefined : startLogger,
      );

    // Dry run
    if (parsed.dryRun) {
      return this.handleDryRun(command, frontmatter, args, [finalBody], positionalMappings, false, virtualFilename);
    }

    // Edit before execute
    // Hard prompt budget: _max_prompt_tokens blocks execution BEFORE any
    // paid flow invocation starts when the fully resolved prompt exceeds the limit.
    const maxPromptTokens = frontmatter._max_prompt_tokens;
    if (typeof maxPromptTokens === "number" && maxPromptTokens > 0) {
      const promptTokens = await countTokensAsync(finalBody);
      if (promptTokens > maxPromptTokens) {
        throw new MarkdownAgentError(
          `Prompt is ~${promptTokens.toLocaleString()} tokens, over the _max_prompt_tokens limit of ${maxPromptTokens.toLocaleString()}. ` +
            `Narrow the imports, raise the limit, or inspect with --_context.`,
          { errorCode: "PROMPT_TOKEN_LIMIT", exitCode: 1 }
        );
      }
    }

    let promptToRun = finalBody;
    if (parsed.editFlag && !parsed.jsonMode) {
      const { editPrompt } = await import("./edit-prompt");
      const editResult = await editPrompt(finalBody);
      if (!editResult.confirmed || editResult.prompt === null) {
        getLogger().info({ editCancelled: true }, "Edit cancelled by user");
        throw new UserCancelledError("Edit cancelled by user");
      }
      promptToRun = editResult.prompt;
      getCommandLogger().debug({ originalLength: finalBody.length, editedLength: promptToRun.length }, "Prompt edited");
    }

    // Execute
    let finalRunArgs = args;
    if (frontmatter._subcommand) {
      const subs = Array.isArray(frontmatter._subcommand)
        ? frontmatter._subcommand.map(String)
        : [String(frontmatter._subcommand)];
      finalRunArgs = [...subs, ...args];
    }

    getCommandLogger().info({ command, argsCount: finalRunArgs.length, promptLength: promptToRun.length, adhoc: true }, "Executing ad-hoc command");

    // Start spinner with command preview
    if (!parsed.jsonMode && !interactiveMode) {
      const preview = formatCommandPreview(command, finalRunArgs);
      const { startSpinner } = await import("./spinner");
      startSpinner(preview);
    }

    // Determine if we should capture output for post-run menu
    // Disable when piping (stdout not TTY) to support: foo.md | bar.md
    const shouldShowMenu = !interactiveMode && this.isStdinTTY && this.isStdoutTTY && !parsed.noMenu && !parsed.jsonMode;
    const structuredOutputConfig = this.getStructuredOutputConfig(frontmatter);
    const captureMode = interactiveMode
      ? false
      : parsed.jsonMode
      ? "capture" as const
      : shouldShowMenu
        ? "tee" as const
        : (structuredOutputConfig ? "capture" as const : false);

    const commandStartedAt = Date.now();
    const runResult = await this.executeCommand({
      command,
      args: finalRunArgs,
      positionals: [promptToRun],
      positionalMappings,
      captureOutput: captureMode,
      captureStderr: !interactiveMode && (parsed.jsonMode || shouldShowMenu),
      interactive: interactiveMode,
      env: extractEnvVars(frontmatter),
      rawOutput: parsed.rawOutput,
    }, parsed.jsonMode);
    const commandDurationMs = Date.now() - commandStartedAt;

    await this.recordRunTelemetry({
      agentPath: virtualFilename,
      tool: command,
      durationMs: commandDurationMs,
      exitCode: runResult.exitCode,
      outputBytes: this.calculateOutputBytes(runResult.stdout, runResult.stderr),
      currentState: "adhoc_command_completed",
    });

    getCommandLogger().info({ exitCode: runResult.exitCode, adhoc: true }, "Ad-hoc command completed");

    if (runResult.exitCode !== 0) {
      this.printErrorWithLogPath(`Agent exited with code ${runResult.exitCode}`, logPath);
    }

    if (runResult.exitCode === 0 && structuredOutputConfig) {
      const structuredOutputCwd = parsed.cwdFromCli ?? (frontmatter._cwd as string | undefined) ?? this.cwd;
      await this.processStructuredOutput({
        stdout: runResult.stdout,
        output: structuredOutputConfig,
        baseDir: this.cwd,
        sinkCwd: structuredOutputCwd,
        source: virtualFilename,
      });
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

    getLogger().info({ exitCode: runResult.exitCode, adhoc: true }, "Ad-hoc session ended");
    return { exitCode: runResult.exitCode, logPath };
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
      const { fetchRemote } = await import("./remote");
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
      pm.onCleanup(() => cleanupRemoteFile(localFilePath));
    }

    if (!(await this.env.fs.exists(localFilePath))) {
      throw new FileNotFoundError(this.fileNotFoundMessage(filePath, localFilePath));
    }

    // Parse md-owned flags before creating a file logger so help-like paths,
    // context inspection, and dry-run remain side-effect free.
    const parsed = this.parseFlags(passthroughArgs);
    resetLogger();
    let logPath: string | null = null;
    setLogPath(null);
    const startLogger = (): void => {
      const logger = initLogger(localFilePath);
      logPath = getCurrentLogPath();
      setLogPath(logPath);
      logger.info({ filePath: localFilePath }, "Session started");
    };

    const fileDir = dirname(resolve(localFilePath));
    await loadEnvFiles(fileDir);

    const content = await this.env.fs.readText(localFilePath);
    const { frontmatter: baseFrontmatter, body: rawBody } = parseFrontmatter(content);
    getParseLogger().debug({ frontmatter: baseFrontmatter, bodyLength: rawBody.length }, "Frontmatter parsed");

    // Remote execution trust must be decided before any import expansion.
    // processAgent() materializes content and command inlines, so placing the
    // TOFU gate after it would allow an untrusted remote flow to perform host
    // work before the user has approved the source.
    if (isRemote && !parsed.trustFlag) {
      const fullConfig = await loadFullConfig(this.configCwd());
      const trustCommand = parsed.commandFromCli ?? resolveEngine(
        localFilePath,
        baseFrontmatter as AgentFrontmatter,
        { configEngine: fullConfig.engine }
      ).engine;
      await this.handleTOFU(
        filePath,
        localFilePath,
        trustCommand,
        baseFrontmatter,
        rawBody,
        parsed.jsonMode
      );
    }

    // Context-only mode: show dashboard and exit without executing
    if (parsed.contextOnly) {
      if (shouldShowDashboard(rawBody)) {
        const analysis = await analyzeContext(localFilePath, rawBody, fileDir);
        printDashboard(analysis);
      } else {
        this.writeStderr("No imports found in this agent file.");
      }
      if (isRemote) await cleanupRemoteFile(localFilePath);
      throw new EarlyExitRequest();
    }

    const { command, frontmatter, templateVars, finalBody, args, positionalMappings, interactiveMode } =
      await this.processAgent(
        localFilePath,
        baseFrontmatter,
        rawBody,
        () => this.readStdinOnce(),
        parsed,
        parsed.dryRun ? undefined : startLogger,
        isRemote || isRegistryFlowPath(localFilePath),
      );

    // Show context dashboard before execution (unless --_quiet)
    if (!parsed.quiet && shouldShowDashboard(rawBody)) {
      const analysis = await analyzeContext(localFilePath, rawBody, fileDir);
      printDashboard(analysis);
    }

    const workflowSteps = frontmatter._steps;
    if (workflowSteps !== undefined) {
      const { parseWorkflow, executeWorkflow } = await import("./workflow");
      const workflow = parseWorkflow(workflowSteps);

      let workflowRunArgs = args;
      if (frontmatter._subcommand) {
        const subcommands = Array.isArray(frontmatter._subcommand)
          ? frontmatter._subcommand.map(String)
          : [String(frontmatter._subcommand)];
        workflowRunArgs = [...subcommands, ...args];
      }

      const workflowTemplateVars = Object.fromEntries(
        Object.entries(templateVars).filter(([key]) => !key.startsWith("__"))
      );

      if (parsed.dryRun) {
        return this.handleWorkflowDryRun(
          command,
          workflowRunArgs,
          workflow,
          isRemote,
          localFilePath
        );
      }

      const shouldShowMenu = this.isStdinTTY && this.isStdoutTTY && !parsed.noMenu && !parsed.jsonMode;
      const captureMode = parsed.jsonMode
        ? "capture" as const
        : this.isStdoutTTY
          ? "tee" as const
          : "capture" as const;
      const cacheBaseDir = parsed.cwdFromCli ?? (frontmatter._cwd as string | undefined) ?? this.cwd;
      if (parsed.jsonMode) {
        this.recordJsonCommand(command, workflowRunArgs);
      }

      const workflowStartedAt = Date.now();
      let workflowUsageSignal: { quickRerun: boolean; msSincePrevious: number | null } | null = null;
      const workflowResult = await executeWorkflow({
        workflow,
        defaultTool: command,
        args: workflowRunArgs,
        positionalMappings,
        templateVars: workflowTemplateVars,
        env: extractEnvVars(frontmatter),
        rawOutput: parsed.rawOutput,
        captureOutput: captureMode,
        resume: parsed.resume,
        cacheDir: join(cacheBaseDir, ".mdflow", ".cache"),
        runCommandFn: (ctx) => this.executeCommand(ctx, parsed.jsonMode),
      });
      const workflowDurationMs = Date.now() - workflowStartedAt;

      await this.recordRunTelemetry({
        agentPath: localFilePath,
        tool: command,
        durationMs: workflowDurationMs,
        exitCode: workflowResult.exitCode,
        outputBytes: this.calculateWorkflowOutputBytes(workflowResult),
        currentState: "workflow_completed",
      });

      if (workflowResult.exitCode === 0) {
        this.stampCompatAfterSuccess(localFilePath, isRemote);
        const usageSignal = await getRecordUsage().then(recordUsage => recordUsage(localFilePath)).catch(() => null);
        workflowUsageSignal = usageSignal;
        if (!parsed.noEvolve && !parsed.jsonMode && !isRemote && existsSync(localFilePath)) {
          const { handleAutoEvolve } = await import("./evolve");
          await handleAutoEvolve(
            resolve(localFilePath),
            usageSignal ?? { quickRerun: false, msSincePrevious: null },
            (line) => this.writeStderr(line)
          );
        }

        const promptedVars = (templateVars as Record<string, unknown>)["__promptedVars__"] as Record<string, string> | undefined;
        const noHistoryFlag = (templateVars as Record<string, unknown>)["__noHistory__"] as boolean | undefined;
        const resolvedPath = (templateVars as Record<string, unknown>)["__resolvedFilePath__"] as string | undefined;

        if (promptedVars && Object.keys(promptedVars).length > 0 && !noHistoryFlag && resolvedPath) {
          getSaveVariableValuesFn()
            .then(saveVars => saveVars(resolvedPath, promptedVars))
            .catch(() => {}); // Fire and forget
        }
      }

      if (isRemote) await cleanupRemoteFile(localFilePath);

      if (workflowResult.exitCode !== 0) {
        this.printErrorWithLogPath(`Agent exited with code ${workflowResult.exitCode}`, logPath);
        if (shouldShowMenu && !isRemote) {
          try {
            const failedStep = [...workflowResult.stepOrder]
              .reverse()
              .map((id) => workflowResult.steps[id])
              .find((step) => step && !step.skipped && step.exitCode !== 0);
            const { confirm } = await import("@inquirer/prompts");
            if (await confirm({ message: "Report this workflow failure as feedback?", default: false })) {
              const message = await this.promptInput("What should this workflow have done instead?");
              if (message.trim()) {
                const { recordEvidence } = await import("./evolution-store");
                const feedback = recordEvidence({
                  flowPath: localFilePath,
                  type: "run_failure",
                  confidence: "high",
                  failureClass: "behavior",
                  message: message.trim(),
                  redactedOutputRef: logPath ?? undefined,
                  inputHash: failedStep ? Bun.hash(`${failedStep.id}:${failedStep.prompt}`).toString(16) : undefined,
                });
                this.writeStderr(`Feedback ${feedback.id} saved. Plan: md evolve plan ${localFilePath}`);
              }
            }
          } catch {
            // Feedback capture is optional; preserve the workflow exit.
          }
        }
      }

      if (shouldShowMenu && workflowResult.exitCode === 0) {
        const lastWorkflowOutput = getLastWorkflowOutput(workflowResult);
        if (lastWorkflowOutput) {
          try {
            const { showPostRunMenu, executePostRunAction } = await import("./post-run-menu");
            const menuResult = await showPostRunMenu(lastWorkflowOutput);
            if (menuResult && menuResult.action !== "exit") {
              if (menuResult.action === "feedback" && !isRemote) {
                const message = await this.promptInput("What went wrong?");
                if (message.trim()) {
                  const { recordEvidence } = await import("./evolution-store");
                  const feedback = recordEvidence({
                    flowPath: localFilePath,
                    type: "explicit_feedback",
                    confidence: "high",
                    message: message.trim(),
                    redactedOutputRef: logPath ?? undefined,
                  });
                  this.writeStderr(`Feedback ${feedback.id} saved. Plan: md evolve plan ${localFilePath}`);
                }
              } else {
                await executePostRunAction(menuResult, lastWorkflowOutput);
              }
            }
          } catch {
            // Menu cancelled or failed, just continue
          }
        }
      }

      if (
        shouldShowMenu &&
        workflowResult.exitCode === 0 &&
        !isRemote &&
        workflowUsageSignal?.msSincePrevious === null
      ) {
        const { contextualFlowTip } = await import("./tips");
        const suitePath = localFilePath.replace(/\.md$/i, ".eval.ts");
        const tip = contextualFlowTip({
          cwd: this.cwd,
          flowPath: localFilePath,
          firstSuccessfulRun: true,
          hasEval: existsSync(suitePath),
        });
        if (tip) this.writeStderr(`\nTip: ${tip}`);
      }

      getLogger().info({
        exitCode: workflowResult.exitCode,
        workflowSteps: workflowResult.stepOrder.length,
        resume: parsed.resume,
      }, "Workflow session ended");
      return { exitCode: workflowResult.exitCode, logPath };
    }

    // Dry run
    if (parsed.dryRun) {
      return this.handleDryRun(
        command,
        frontmatter,
        args,
        promptPositionals(finalBody, interactiveMode),
        positionalMappings,
        isRemote,
        localFilePath
      );
    }

    // Edit before execute
    // Hard prompt budget: _max_prompt_tokens blocks execution BEFORE any
    // paid flow invocation starts when the fully resolved prompt exceeds the limit.
    const maxPromptTokens = frontmatter._max_prompt_tokens;
    if (typeof maxPromptTokens === "number" && maxPromptTokens > 0) {
      const promptTokens = await countTokensAsync(finalBody);
      if (promptTokens > maxPromptTokens) {
        throw new MarkdownAgentError(
          `Prompt is ~${promptTokens.toLocaleString()} tokens, over the _max_prompt_tokens limit of ${maxPromptTokens.toLocaleString()}. ` +
            `Narrow the imports, raise the limit, or inspect with --_context.`,
          { errorCode: "PROMPT_TOKEN_LIMIT", exitCode: 1 }
        );
      }
    }

    let promptToRun = finalBody;
    if (parsed.editFlag && !parsed.jsonMode) {
      const { editPrompt } = await import("./edit-prompt");
      const editResult = await editPrompt(finalBody);
      if (!editResult.confirmed || editResult.prompt === null) {
        if (isRemote) await cleanupRemoteFile(localFilePath);
        getLogger().info({ editCancelled: true }, "Edit cancelled by user");
        throw new UserCancelledError("Edit cancelled by user");
      }
      promptToRun = editResult.prompt;
      getCommandLogger().debug({ originalLength: finalBody.length, editedLength: promptToRun.length }, "Prompt edited");
    }

    // Execute
    let finalRunArgs = args;
    if (frontmatter._subcommand) {
      const subs = Array.isArray(frontmatter._subcommand)
        ? frontmatter._subcommand.map(String)
        : [String(frontmatter._subcommand)];
      finalRunArgs = [...subs, ...args];
    }

    // Determine if we should capture output for post-run menu
    // Only capture when: TTY (stdin+stdout), not piped, menu not disabled
    // Checking stdout.isTTY enables piping: foo.md | bar.md
    const shouldShowMenu = !interactiveMode && this.isStdinTTY && this.isStdoutTTY && !parsed.noMenu && !parsed.jsonMode;
    const structuredOutputConfig = this.getStructuredOutputConfig(frontmatter);
    // Terminal UIs own stdio; one-shot commands may be captured for menus/output.
    const captureMode = interactiveMode
      ? false
      : parsed.jsonMode
      ? "capture" as const
      : shouldShowMenu
        ? "tee" as const
        : (structuredOutputConfig ? "capture" as const : false);

    // Auto-heal retry loop
    let currentPrompt = promptToRun;
    let runResult: Awaited<ReturnType<typeof runCommand>>;
    let retryCount = 0;

    const commandStartedAt = Date.now();
    while (true) {
      getCommandLogger().info({ command, argsCount: finalRunArgs.length, promptLength: currentPrompt.length, retryCount }, "Executing command");

      // Start spinner with command preview (will be stopped when first output arrives)
      if (!parsed.jsonMode && !interactiveMode) {
        const preview = formatCommandPreview(command, finalRunArgs);
        const { startSpinner } = await import("./spinner");
        startSpinner(preview);
      }

      runResult = await this.executeCommand({
        command,
        args: finalRunArgs,
        // A positional argument seeds and immediately submits the first turn in
        // interactive agent CLIs. Leave it out when the rendered flow body is
        // blank so the configured TUI opens and waits for the user's prompt.
        positionals: promptPositionals(currentPrompt, interactiveMode),
        positionalMappings,
        captureOutput: captureMode,
        captureStderr: !interactiveMode && (shouldShowMenu || parsed.jsonMode), // TUI engines own terminal stderr
        interactive: interactiveMode,
        env: extractEnvVars(frontmatter),
        rawOutput: parsed.rawOutput,
      }, parsed.jsonMode);

      getCommandLogger().info({ exitCode: runResult.exitCode, retryCount }, "Command completed");

      // If command succeeded or we're not in interactive mode, break out of loop
      if (runResult.exitCode === 0 || !shouldShowMenu) {
        break;
      }

      // Command failed in interactive mode - show failure menu
      try {
        const { showFailureMenu, buildFixPrompt } = await import("./failure-menu");
        const menuResult = await showFailureMenu(
          runResult.exitCode,
          runResult.stderr,
          runResult.stdout
        );

        if (menuResult.action === "quit") {
          // Exit with the original error code
          break;
        } else if (menuResult.action === "retry") {
          // Retry with the same prompt
          retryCount++;
          getCommandLogger().info({ retryCount }, "Retrying command");
          continue;
        } else if (menuResult.action === "fix") {
          // Build a new prompt with error context
          currentPrompt = buildFixPrompt(
            promptToRun, // Use original prompt, not accumulated errors
            runResult.stderr,
            runResult.stdout,
            runResult.exitCode
          );
          retryCount++;
          getCommandLogger().info({ retryCount, fixMode: true }, "Retrying with AI fix");
          continue;
        } else if (menuResult.action === "report") {
          const message = await this.promptInput("What should this flow have done instead?");
          if (message.trim() && !isRemote) {
            const { recordEvidence } = await import("./evolution-store");
            const feedback = recordEvidence({
              flowPath: localFilePath,
              type: "run_failure",
              confidence: "high",
              failureClass: "behavior",
              message: message.trim(),
              redactedOutputRef: logPath ?? undefined,
            });
            this.writeStderr(`Feedback ${feedback.id} saved. Plan: md evolve plan ${localFilePath}`);
          }
          break;
        }
      } catch {
        // Menu cancelled or failed, exit loop
        break;
      }
    }
    const commandDurationMs = Date.now() - commandStartedAt;

    await this.recordRunTelemetry({
      agentPath: localFilePath,
      tool: command,
      durationMs: commandDurationMs,
      exitCode: runResult.exitCode,
      outputBytes: this.calculateOutputBytes(runResult.stdout, runResult.stderr),
      currentState: "command_completed",
    });

    // Record usage for frecency tracking (skip for failed runs, lazy-load history)
    let usageSignal: { quickRerun: boolean; msSincePrevious: number | null } | null = null;
    if (runResult.exitCode === 0) {
      if (structuredOutputConfig) {
        const structuredOutputCwd = parsed.cwdFromCli ?? (frontmatter._cwd as string | undefined) ?? this.cwd;
        await this.processStructuredOutput({
          stdout: runResult.stdout,
          output: structuredOutputConfig,
          baseDir: dirname(resolve(localFilePath)),
          sinkCwd: structuredOutputCwd,
          source: localFilePath,
        });
      }

      // Stamp before proposal handling so receipts bind the updated `_compat`.
      this.stampCompatAfterSuccess(localFilePath, isRemote);

      usageSignal = await getRecordUsage()
        .then(recordUsage => recordUsage(localFilePath))
        .catch(() => null);

      // Proposal-first evolution policy. Quick reruns remain low-confidence
      // observations; paid proposal work requires actionable evidence and an
      // exact current receipt, prints its bound, and never auto-applies.
      if (!parsed.noEvolve && !parsed.jsonMode && !isRemote && existsSync(localFilePath)) {
        const { handleAutoEvolve } = await import("./evolve");
        await handleAutoEvolve(
          resolve(localFilePath),
          usageSignal ?? { quickRerun: false, msSincePrevious: null },
          (line) => this.writeStderr(line)
        );
      }

      // Save prompted variable values to history for future runs (fire and forget)
      const promptedVars = (templateVars as Record<string, unknown>)["__promptedVars__"] as Record<string, string> | undefined;
      const noHistoryFlag = (templateVars as Record<string, unknown>)["__noHistory__"] as boolean | undefined;
      const resolvedPath = (templateVars as Record<string, unknown>)["__resolvedFilePath__"] as string | undefined;

      if (promptedVars && Object.keys(promptedVars).length > 0 && !noHistoryFlag && resolvedPath) {
        getSaveVariableValuesFn()
          .then(saveVars => saveVars(resolvedPath, promptedVars))
          .catch(() => {}); // Fire and forget
      }
    }

    if (isRemote) await cleanupRemoteFile(localFilePath);

    if (runResult.exitCode !== 0) {
      this.printErrorWithLogPath(`Agent exited with code ${runResult.exitCode}`, logPath);
    }

    // Show post-run action menu if enabled and we have output (only on success)
    if (shouldShowMenu && runResult.stdout && runResult.exitCode === 0) {
      try {
        const { showPostRunMenu, executePostRunAction } = await import("./post-run-menu");
        const menuResult = await showPostRunMenu(runResult.stdout);
        if (menuResult && menuResult.action !== "exit") {
          if (menuResult.action === "feedback" && !isRemote) {
            const message = await this.promptInput("What went wrong?");
            if (message.trim()) {
              const { recordEvidence } = await import("./evolution-store");
              const feedback = recordEvidence({
                flowPath: localFilePath,
                type: "explicit_feedback",
                confidence: "high",
                message: message.trim(),
                redactedOutputRef: logPath ?? undefined,
              });
              this.writeStderr(`Feedback ${feedback.id} saved. Plan: md evolve plan ${localFilePath}`);
            }
          } else {
            await executePostRunAction(menuResult, runResult.stdout);
          }
        }
      } catch {
        // Menu cancelled or failed, just continue
      }
    }

    if (
      shouldShowMenu &&
      runResult.exitCode === 0 &&
      !isRemote &&
      usageSignal?.msSincePrevious === null
    ) {
      const { contextualFlowTip } = await import("./tips");
      const suitePath = localFilePath.replace(/\.md$/i, ".eval.ts");
      const tip = contextualFlowTip({
        cwd: this.cwd,
        flowPath: localFilePath,
        firstSuccessfulRun: true,
        hasEval: existsSync(suitePath),
      });
      if (tip) this.writeStderr(`\nTip: ${tip}`);
    }

    getLogger().info({ exitCode: runResult.exitCode, retryCount }, "Session ended");
    return { exitCode: runResult.exitCode, logPath };
  }

  /**
   * `md <flow> --events` — NDJSON run event stream (Flow UX Protocol v1).
   *
   * stdout carries only JSON event lines; human rendering is suppressed and
   * stray console.log output is rerouted to stderr. Engine output is carried
   * inside `output.delta` events. `--events` implies non-interactive: a
   * TTY-only interactive flow yields a `run.error` terminal event. SIGTERM
   * is forwarded to the engine child and surfaces as `run.cancelled`.
   */
  private async runAgentEvents(
    filePath: string,
    passthroughArgs: string[],
    setLogPath: (lp: string | null) => void
  ): Promise<CliRunResult> {
    const [{ createRunEventEmitter }, { flowIdForPath }, { mdflowVersion }] = await Promise.all([
      import("./run-events"),
      import("./roster"),
      import("./compat"),
    ]);

    const emitter = createRunEventEmitter();
    const startedAt = Date.now();

    // stdout purity: anything that would render for a human goes to stderr.
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      console.error(...args);
    };

    const fail = (message: string, exitCode: number | null = null): CliRunResult => {
      emitter.emit("run.error", {
        exitCode,
        message,
        durationMs: Date.now() - startedAt,
      });
      return { exitCode: exitCode ?? 1 };
    };

    emitter.emit("protocol", { mdflowVersion: mdflowVersion() });

    try {
      const localFilePath = await this.resolveFilePath(filePath);
      if (!(await this.env.fs.exists(localFilePath))) {
        return fail(this.fileNotFoundMessage(filePath, localFilePath));
      }

      const pm = getProcessManager();
      pm.initialize();

      const fileDir = dirname(resolve(localFilePath));
      await loadEnvFiles(fileDir);

      const logger = initLogger(localFilePath);
      const logPath = getCurrentLogPath();
      setLogPath(logPath);
      logger.info({ filePath: localFilePath, events: true }, "Event-stream session started");

      const content = await this.env.fs.readText(localFilePath);
      const { frontmatter: baseFrontmatter, body: rawBody } = parseFrontmatter(content);

      const parsed = this.parseFlags(passthroughArgs);
      // Event streams never prompt, never render, never show menus — reuse
      // the non-interactive guarantees of --json mode inside processAgent.
      parsed.jsonMode = true;

      // --events implies non-interactive. A flow that requires a terminal
      // cannot be hosted here; the caller should open a real terminal.
      if (
        hasInteractiveMarker(localFilePath) ||
        parsed.interactiveFromCli ||
        isInteractiveModeEnabled(baseFrontmatter as AgentFrontmatter)
      ) {
        return fail("interactive flow requires a terminal");
      }

      // Document rule: a file with no meaningful frontmatter and no explicit
      // engine is a document, not a flow — there is nothing to run.
      const fullConfig = await loadFullConfig(this.configCwd());
      const resolvedEngine = resolveEngine(localFilePath, baseFrontmatter as AgentFrontmatter, {
        configEngine: fullConfig.engine,
      });
      const engineIsImplicit = !parsed.commandFromCli
        && (resolvedEngine.source === "env" || resolvedEngine.source === "config" || resolvedEngine.source === "default");
      if (engineIsImplicit && isCompatOnlyFrontmatter(baseFrontmatter as Record<string, unknown>)) {
        return fail(`not a flow: ${localFilePath} is a document (no frontmatter or engine marker)`);
      }

      const { command, frontmatter, templateVars, finalBody, args, positionalMappings } =
        await this.processAgent(
          localFilePath,
          baseFrontmatter,
          rawBody,
          () => this.readStdinOnce(),
          parsed,
          undefined,
          isRegistryFlowPath(localFilePath),
        );

      const flowId = flowIdForPath(resolve(localFilePath), { cwd: this.cwd });
      const effectiveCwd = resolve(
        parsed.cwdFromCli ?? (frontmatter._cwd as string | undefined) ?? this.cwd
      );

      let finalRunArgs = args;
      if (frontmatter._subcommand) {
        const subs = Array.isArray(frontmatter._subcommand)
          ? frontmatter._subcommand.map(String)
          : [String(frontmatter._subcommand)];
        finalRunArgs = [...subs, ...args];
      }

      // Cancellation: replace the process-wide kill-and-exit handlers so a
      // SIGTERM forwards to the engine child, emits `run.cancelled`, and
      // exits cleanly with the terminal event already flushed (the emitter
      // writes synchronously to fd 1).
      const onCancelSignal = (signal: NodeJS.Signals): void => {
        try {
          pm.killAll();
        } catch {
          // Best-effort: the child may already be gone.
        }
        emitter.emit("run.cancelled", {
          signal,
          durationMs: Date.now() - startedAt,
        });
        try {
          pm.restoreTerminal();
        } catch {
          // Best-effort cleanup.
        }
        process.exit(0);
      };
      process.removeAllListeners("SIGTERM");
      process.removeAllListeners("SIGINT");
      process.once("SIGTERM", () => onCancelSignal("SIGTERM"));
      process.once("SIGINT", () => onCancelSignal("SIGINT"));

      // Chunk delta text: a single writeSync of a line larger than the pipe
      // buffer (~64KiB) can partially write and corrupt the NDJSON stream
      // (observed on Bun/macOS). 8KiB raw text stays far under the buffer
      // even at worst-case JSON escaping (6 bytes per char).
      const DELTA_CHUNK_CHARS = 8192;
      const emitDelta = (channel: "stdout" | "stderr", text: string): void => {
        for (let start = 0; start < text.length; start += DELTA_CHUNK_CHARS) {
          emitter.emit("output.delta", {
            channel,
            text: text.slice(start, start + DELTA_CHUNK_CHARS),
          });
        }
      };

      const workflowSteps = frontmatter._steps;
      if (workflowSteps !== undefined) {
        const { parseWorkflow, executeWorkflow } = await import("./workflow");
        const workflow = parseWorkflow(workflowSteps);
        const workflowTemplateVars = Object.fromEntries(
          Object.entries(templateVars).filter(([key]) => !key.startsWith("__"))
        );

        // Workflows spawn one engine child per step; `pid` reports the
        // mdflow orchestrator that owns the process group.
        emitter.emit("run.started", {
          flowId,
          path: resolve(localFilePath),
          engine: command,
          command,
          args: finalRunArgs,
          cwd: effectiveCwd,
          pid: process.pid,
        });

        const workflowResult = await executeWorkflow({
          workflow,
          defaultTool: command,
          args: finalRunArgs,
          positionalMappings,
          templateVars: workflowTemplateVars,
          env: extractEnvVars(frontmatter),
          captureOutput: "stream",
          resume: parsed.resume,
          cacheDir: join(effectiveCwd, ".mdflow", ".cache"),
          onStepStart: (step) => {
            emitter.emit("step.started", { stepId: step.id, needs: step.needs ?? [] });
          },
          onStepComplete: (result) => {
            emitter.emit("step.completed", {
              stepId: result.id,
              exitCode: result.exitCode,
              cached: result.fromCache,
            });
          },
          runCommandFn: (ctx) =>
            this.runCommandFn({ ...ctx, captureOutput: "stream", onOutput: emitDelta }),
        });

        const durationMs = Date.now() - startedAt;
        if (workflowResult.exitCode === 0) {
          emitter.emit("run.completed", { exitCode: 0, durationMs });
        } else {
          emitter.emit("run.error", {
            exitCode: workflowResult.exitCode,
            message: `workflow exited with code ${workflowResult.exitCode}`,
            durationMs,
          });
        }
        logger.info({ exitCode: workflowResult.exitCode, events: true }, "Event-stream workflow ended");
        return { exitCode: workflowResult.exitCode, logPath };
      }

      const positionals = promptPositionals(finalBody, false);
      const runResult = await this.runCommandFn({
        command,
        args: finalRunArgs,
        positionals,
        positionalMappings,
        captureOutput: "stream",
        captureStderr: true,
        env: extractEnvVars(frontmatter),
        onSpawn: (pid) => {
          emitter.emit("run.started", {
            flowId,
            path: resolve(localFilePath),
            engine: command,
            command,
            args: this.buildSpawnArgs(finalRunArgs, positionals, positionalMappings),
            cwd: effectiveCwd,
            pid,
          });
        },
        onOutput: emitDelta,
      });

      const durationMs = Date.now() - startedAt;
      if (runResult.exitCode === 0) {
        emitter.emit("run.completed", { exitCode: 0, durationMs });
      } else {
        emitter.emit("run.error", {
          exitCode: runResult.exitCode,
          message: `engine exited with code ${runResult.exitCode}`,
          durationMs,
        });
      }
      logger.info({ exitCode: runResult.exitCode, events: true }, "Event-stream session ended");
      return { exitCode: runResult.exitCode, logPath };
    } catch (err) {
      if (err instanceof EarlyExitRequest) {
        return fail("run ended before the engine started", null);
      }
      const message = err instanceof Error ? err.message : String(err);
      return fail(message, err instanceof MarkdownAgentError ? err.code : null);
    } finally {
      console.log = originalLog;
    }
  }

  private getStructuredOutputConfig(frontmatter: AgentFrontmatter): StructuredOutputConfig | undefined {
    if (!Object.prototype.hasOwnProperty.call(frontmatter, "_output")) {
      return undefined;
    }

    const output = frontmatter._output;
    if (output === undefined || output === null) {
      return undefined;
    }

    if (typeof output !== "object" || Array.isArray(output)) {
      throw new ConfigurationError("_output must be a mapping/object when provided", 1);
    }

    return output;
  }

  private resolveStructuredOutputFormat(output: StructuredOutputConfig): StructuredOutputFormat {
    return output.format ?? (output.apply ? "patch" : "text");
  }

  private unwrapValidationResult(result: unknown): unknown {
    if (!result || typeof result !== "object" || !("success" in result)) {
      return result;
    }

    const validationResult = result as {
      success?: unknown;
      data?: unknown;
      error?: unknown;
    };

    if (validationResult.success === true) {
      return validationResult.data;
    }

    if (validationResult.success === false) {
      const message = typeof validationResult.error === "string"
        ? validationResult.error
        : "Schema validation failed.";
      throw new Error(message);
    }

    return result;
  }

  private serializeStructuredForSink(value: unknown, format: StructuredOutputFormat): string {
    if (typeof value === "string") {
      return value;
    }

    if (format === "json") {
      return `${JSON.stringify(value, null, 2)}\n`;
    }

    return JSON.stringify(value);
  }

  private async processStructuredOutput(params: {
    stdout: string;
    output: StructuredOutputConfig;
    baseDir: string;
    sinkCwd: string;
    source: string;
  }): Promise<void> {
    const { stdout, output, baseDir, sinkCwd, source } = params;
    const format = this.resolveStructuredOutputFormat(output);

    try {
      getCommandLogger().info(
        {
          source,
          format,
          hasSchema: Boolean(output.schema),
          save: output.save ?? null,
          apply: Boolean(output.apply),
          sinkCwd,
        },
        "Processing structured output"
      );

      const outputModule = await import("./output") as OutputModule;
      let structured = outputModule.extractStructured(stdout, format);

      if (output.schema) {
        if (outputModule.validateOutput) {
          const validationResult = await outputModule.validateOutput(output.schema, structured, { baseDir });
          structured = this.unwrapValidationResult(validationResult);
        } else if (outputModule.validate) {
          structured = await outputModule.validate(output.schema, structured, { baseDir });
        } else {
          throw new Error("validateOutput() is unavailable in src/output.ts");
        }
      }

      if (output.save || output.apply) {
        if (outputModule.sinkOutput) {
          if (outputModule.sinkOutput.length >= 3) {
            await outputModule.sinkOutput(structured, output, { cwd: sinkCwd, format });
          } else {
            const sinkContent = this.serializeStructuredForSink(structured, format);
            await outputModule.sinkOutput(
              { save: output.save, apply: output.apply, cwd: sinkCwd },
              sinkContent
            );
          }
        } else {
          if (output.save) {
            if (!outputModule.sinkSave) {
              throw new Error("sinkOutput() and sinkSave() are unavailable in src/output.ts");
            }
            await outputModule.sinkSave(output.save, structured, format, { cwd: sinkCwd });
          }

          if (output.apply) {
            if (format !== "patch") {
              throw new Error("Output apply=true requires format=patch.");
            }
            if (typeof structured !== "string") {
              throw new Error("Patch output must be string data.");
            }
            if (!outputModule.sinkApplyPatch) {
              throw new Error("sinkOutput() and sinkApplyPatch() are unavailable in src/output.ts");
            }
            outputModule.sinkApplyPatch(structured, { cwd: sinkCwd });
          }
        }
      }

      getCommandLogger().info({ source, format }, "Structured output processed");
    } catch (err) {
      const details = err instanceof Error ? err.message : String(err);
      getCommandLogger().error(
        { source, format, error: details, outputConfig: output },
        "Structured output processing failed"
      );
      throw new ConfigurationError(`Structured output processing failed: ${details}`, 1);
    }
  }

  private parseFlags(passthroughArgs: string[]) {
    let remainingArgs = [...passthroughArgs];
    let commandFromCli: string | undefined;
    let dryRun = false, trustFlag = false, interactiveFromCli = false, noCache = false, rawOutput = false, editFlag = false;
    let contextOnly = false, quiet = false, noMenu = false, noHistory = false, noEvolve = false, resume = false;
    let jsonMode = false;
    let cwdFromCli: string | undefined;
    let isolatedFromCli: boolean | undefined;
    let systemPromptFromCli: string | undefined;
    let hooksFromCli: string | undefined;
    const appendSystemPromptFromCli: string[] = [];

    // --engine is the v3 flag; --_command/-_c and --tool are deprecated aliases.
    const engineIdx = remainingArgs.findIndex((a) => a === "--engine");
    if (engineIdx !== -1 && engineIdx + 1 < remainingArgs.length) {
      commandFromCli = remainingArgs[engineIdx + 1];
      remainingArgs.splice(engineIdx, 2);
    }
    const cmdIdx = remainingArgs.findIndex((a) => a === "--_command" || a === "-_c");
    if (cmdIdx !== -1 && cmdIdx + 1 < remainingArgs.length) {
      if (!commandFromCli) commandFromCli = remainingArgs[cmdIdx + 1];
      remainingArgs.splice(cmdIdx, 2);
    }
    const toolIdx = remainingArgs.findIndex((a) => a === "--tool");
    if (toolIdx !== -1 && toolIdx + 1 < remainingArgs.length) {
      if (!commandFromCli) commandFromCli = remainingArgs[toolIdx + 1];
      remainingArgs.splice(toolIdx, 2);
    }
    dryRun = remainingArgs.some(
      (arg) => arg === "--_dry-run" || arg === "--dry-run",
    );
    if (dryRun) {
      remainingArgs = remainingArgs.filter(
        (arg) => arg !== "--_dry-run" && arg !== "--dry-run",
      );
    }
    const editIdx = remainingArgs.indexOf("--_edit");
    if (editIdx !== -1) { editFlag = true; remainingArgs.splice(editIdx, 1); }
    const trustIdx = remainingArgs.indexOf("--_trust");
    if (trustIdx !== -1) { trustFlag = true; remainingArgs.splice(trustIdx, 1); }
    const noCacheIdx = remainingArgs.indexOf("--_no-cache");
    if (noCacheIdx !== -1) { noCache = true; remainingArgs.splice(noCacheIdx, 1); }
    const noMenuIdx = remainingArgs.indexOf("--_no-menu");
    if (noMenuIdx !== -1) { noMenu = true; remainingArgs.splice(noMenuIdx, 1); }
    const jsonIdx = remainingArgs.indexOf("--json");
    if (jsonIdx !== -1) { jsonMode = true; remainingArgs.splice(jsonIdx, 1); }
    // --_no-history flag: skip loading/saving variable history
    const noHistoryIdx = remainingArgs.indexOf("--_no-history");
    if (noHistoryIdx !== -1) { noHistory = true; remainingArgs.splice(noHistoryIdx, 1); }
    const noEvolveIdx = remainingArgs.findIndex((arg) => arg === "--no-evolve" || arg === "--_no-evolve");
    if (noEvolveIdx !== -1) { noEvolve = true; remainingArgs.splice(noEvolveIdx, 1); }
    const resumeIdx = remainingArgs.indexOf("--_resume");
    if (resumeIdx !== -1) { resume = true; remainingArgs.splice(resumeIdx, 1); }
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
    // Isolation + system prompt overrides
    // --_isolated [true|false] — bare flag means true; isolation is the
    // default, so the false form is the interesting one (opt back into
    // ambient context).
    const isolatedIdx = remainingArgs.indexOf("--_isolated");
    if (isolatedIdx !== -1) {
      const next = remainingArgs[isolatedIdx + 1];
      if (next === "false" || next === "true") {
        isolatedFromCli = next === "true";
        remainingArgs.splice(isolatedIdx, 2);
      } else {
        isolatedFromCli = true;
        remainingArgs.splice(isolatedIdx, 1);
      }
    }
    const sysPromptIdx = remainingArgs.indexOf("--_system-prompt");
    if (sysPromptIdx !== -1 && sysPromptIdx + 1 < remainingArgs.length) {
      systemPromptFromCli = remainingArgs[sysPromptIdx + 1];
      remainingArgs.splice(sysPromptIdx, 2);
    }
    // --_append-system-prompt is repeatable
    let appendIdx: number;
    while ((appendIdx = remainingArgs.indexOf("--_append-system-prompt")) !== -1 && appendIdx + 1 < remainingArgs.length) {
      appendSystemPromptFromCli.push(remainingArgs[appendIdx + 1]!);
      remainingArgs.splice(appendIdx, 2);
    }
    // --_hooks <path|false> — override or disable the flow's hooks file.
    const hooksIdx = remainingArgs.indexOf("--_hooks");
    if (hooksIdx !== -1 && hooksIdx + 1 < remainingArgs.length) {
      hooksFromCli = remainingArgs[hooksIdx + 1];
      remainingArgs.splice(hooksIdx, 2);
    }

    return { remainingArgs, commandFromCli, dryRun, editFlag, trustFlag, interactiveFromCli, cwdFromCli, noCache, rawOutput, contextOnly, quiet, noMenu, noHistory, noEvolve, resume, jsonMode, isolatedFromCli, systemPromptFromCli, appendSystemPromptFromCli, hooksFromCli };
  }

  private async processAgent(
    localFilePath: string,
    baseFrontmatter: Record<string, unknown>,
    rawBody: string,
    readStdin: () => Promise<string>,
    parsed: ReturnType<typeof this.parseFlags>,
    startLogger?: () => void,
    isRemoteFlow = false,
  ) {
    const { remainingArgs, commandFromCli, interactiveFromCli, cwdFromCli, noHistory, jsonMode } = parsed;
    let remaining = [...remainingArgs];

    // Resolve the engine via the v3 ladder: CLI flag > env > filename >
    // frontmatter > config > built-in default.
    const fullConfig = await loadFullConfig(this.configCwd());
    let command: string;
    let engineSource: EngineSource = "cli";
    if (commandFromCli) {
      command = commandFromCli;
    } else {
      const resolved = resolveEngine(localFilePath, baseFrontmatter as AgentFrontmatter, {
        configEngine: fullConfig.engine,
      });
      command = resolved.engine;
      engineSource = resolved.source;
      if (resolved.deprecatedKey) {
        this.writeStderr(
          `Warning [ENGINE_KEY_DEPRECATED]: frontmatter "${resolved.deprecatedKey}:" is deprecated; use "engine: ${command}".`
        );
      }
      if (resolved.skippedFilenameEngine) {
        this.writeStderr(
          `Warning [ENGINE_NOT_FOUND]: filename names engine "${resolved.skippedFilenameEngine}" but no such adapter or binary exists — using ${command} (${engineSource}). Rename the file or install the engine if that was intended.`
        );
      }
    }

    const engineIsImplicit =
      engineSource === "env" || engineSource === "config" || engineSource === "default";

    // A markdown file with no frontmatter and no explicit engine is a
    // document, not a flow — print it instead of executing it. Frontmatter
    // (or a filename/flag engine) is what marks a file as executable.
    // Compat-only keys (_mdflow_version/_compat) are invisible metadata and
    // don't count: automatic version stamping must never flip a document
    // into an executable flow.
    if (engineIsImplicit && isCompatOnlyFrontmatter(baseFrontmatter as Record<string, unknown>)) {
      this.writeStdout(await this.env.fs.readText(localFilePath));
      throw new EarlyExitRequest();
    }

    // Logging is a real-run concern. Defer it until the document rule has
    // established that this invocation will execute a flow.
    startLogger?.();
    getCommandLogger().debug(
      { command, source: engineSource },
      commandFromCli ? "Engine from --engine flag" : "Engine resolved",
    );

    // Implicit resolution is allowed but never silent: say which engine won
    // and which rung of the ladder chose it.
    if (engineIsImplicit && !parsed.quiet && !jsonMode) {
      const dim = process.stderr.isTTY ? ["\x1b[2m", "\x1b[0m"] : ["", ""];
      this.writeStderr(`${dim[0]}${basename(localFilePath)} → ${command} (engine: ${engineSource})${dim[1]}`);
    }

    // Version skew is surfaced but never blocks: a flow verified with a
    // different mdflow major gets a dim one-liner, and a clean run below
    // re-stamps `_compat` automatically.
    if (!parsed.quiet && !jsonMode) {
      const notice = compatNotice(baseFrontmatter as Record<string, unknown>);
      if (notice) {
        const dim = process.stderr.isTTY ? ["\x1b[2m", "\x1b[0m"] : ["", ""];
        this.writeStderr(`${dim[0]}${notice}${dim[1]}`);
      }
    }

    const commandDefaults = fullConfig.commands?.[command];

    // Engine context isolation is on by default where supported. This strips
    // ambient agent configuration; it does not sandbox host capabilities.
    // The adapter's verified context-stripping flags layer between config
    // defaults and frontmatter, so an isolated flow can still re-enable one
    // layer (e.g. `safe-mode: false`); `_isolated: false` opts back into
    // ambient context entirely.
    const engineAdapter = getEngineAdapter(command);
    const isolationMode = resolveIsolationMode({
      frontmatter: baseFrontmatter as AgentFrontmatter,
      cliValue: parsed.isolatedFromCli,
      commandDefaults,
    });
    let isolationDefaults: CommandDefaults = {};
    if (isolationMode.isolated) {
      const isolation = resolveIsolationDefaults(engineAdapter, command);
      // Engines with no isolation controls run ambient; only an EXPLICIT
      // `_isolated: true` warns — the default would otherwise warn every run.
      if (isolation.unsupportedWarning && isolationMode.explicit && !parsed.quiet && !jsonMode) {
        const dim = process.stderr.isTTY ? ["\x1b[2m", "\x1b[0m"] : ["", ""];
        this.writeStderr(`${dim[0]}${isolation.unsupportedWarning}${dim[1]}`);
      }
      isolationDefaults = isolation.defaults;
    }

    let frontmatter = isolationMode.isolated
      ? applyIsolationDefaults(
          baseFrontmatter as AgentFrontmatter,
          commandDefaults,
          isolationDefaults
        )
      : applyDefaults(baseFrontmatter as AgentFrontmatter, commandDefaults);
    const interactiveFromFilename = hasInteractiveMarker(localFilePath);
    const interactiveMode = !jsonMode && isInteractiveModeEnabled(
      frontmatter,
      interactiveFromFilename || interactiveFromCli
    );
    frontmatter = applyInteractiveMode(frontmatter, command, interactiveFromFilename || interactiveFromCli);

    // System prompt override (v3): translate _system-prompt /
    // _append-system-prompt into engine-native flags/env. Runs BEFORE
    // extractEnvVars so a translation that sets env (gemini GEMINI_SYSTEM_MD)
    // lands in _env. Unsupported engines fail loudly — a flow that declares
    // its system prompt and runs without it is a different flow.
    const systemPromptSpec = extractSystemPromptSpec(frontmatter, {
      replace: parsed.systemPromptFromCli,
      append: parsed.appendSystemPromptFromCli,
    });
    if (systemPromptSpec) {
      const applied = applySystemPromptToFrontmatter(
        engineAdapter, command, frontmatter, systemPromptSpec
      );
      frontmatter = applied.frontmatter;
      getProcessManager().onCleanup(applied.cleanup);
    }

    // Lifecycle hooks (v3): a sibling `<flow>.hooks.ts` (or explicit
    // `_hooks:` path) is discovered, its handled events read, and the
    // adapter translates them into engine-native hook config. Discovery is
    // convention-first and free when no file exists; a hooks file that
    // exists but cannot run (missing, rejected path, invalid, or
    // unsupported engine) fails the run loudly — silently dropped hooks
    // would be a different flow.
    //
    // CONSENT BOUNDARY: event discovery is STATIC (text parse) so that
    // browsing/explaining/dry-running a flow never executes hook code.
    // Executing the file (`--mdflow-list-events`) is a fallback allowed
    // only when the flow itself is about to execute — same consent.
    {
      const { resolveHooksFile, listHandledEvents, listHandledEventsStatic, applyHooksToFrontmatter, formatHooksStderrLine } =
        await import("./hooks");
      const resolvedHooks = resolveHooksFile({
        flowPath: localFilePath,
        frontmatterValue: frontmatter._hooks,
        cliValue: parsed.hooksFromCli,
        isRemote: isRemoteFlow,
      });
      if (resolvedHooks.kind === "file") {
        if (resolvedHooks.rejected) {
          throw new ConfigurationError(`Hooks error: ${resolvedHooks.rejected}`, 1);
        }
        if (resolvedHooks.missing) {
          throw new ConfigurationError(
            `Hooks file not found: ${resolvedHooks.path} (from ${resolvedHooks.source}). ` +
              `Create it with \`md hooks add ${basename(localFilePath)}\` or remove the _hooks override.`,
            1
          );
        }
        let listed = listHandledEventsStatic(resolvedHooks.path);
        if (!listed.ok && !parsed.dryRun) {
          // The flow is about to execute, so interrogating its hook program
          // adds no privilege; a dry run stays execution-free and errors
          // instead.
          listed = await listHandledEvents(resolvedHooks.path);
        }
        if (!listed.ok) {
          throw new ConfigurationError(`Hooks error: ${listed.error}`, 1);
        }
        const appliedHooks = applyHooksToFrontmatter(engineAdapter, command, frontmatter, {
          hooksFile: resolve(resolvedHooks.path),
          events: listed.events,
          isolated: isolationMode.isolated,
          // Dry runs are passive: show the real env, prepare nothing.
          prepareEnvironment: !parsed.dryRun,
        });
        frontmatter = appliedHooks.frontmatter;
        if (!parsed.quiet && !jsonMode) {
          const dim = process.stderr.isTTY ? ["\x1b[2m", "\x1b[0m"] : ["", ""];
          this.writeStderr(`${dim[0]}${formatHooksStderrLine(resolvedHooks.path, listed.events)}${dim[1]}`);
          for (const warning of appliedHooks.warnings) {
            this.writeStderr(`${dim[0]}${warning}${dim[1]}`);
          }
        }
      } else if (frontmatter._hooks !== undefined) {
        // `_hooks: false` resolved to disabled — consume the key so it never
        // reaches template-var extraction or the engine CLI.
        frontmatter = { ...frontmatter };
        delete frontmatter._hooks;
      }
    }

    const envVars = extractEnvVars(frontmatter);
    if (envVars) Object.entries(envVars).forEach(([k, v]) => { this.processEnv[k] = v; });

    // Template vars - all use _prefix (e.g., _name in frontmatter → {{ _name }} in body)
    let templateVars: Record<string, string> = {};

    // Extract _varname fields from frontmatter and match with --_varname CLI flags
    // Variables starting with _ are template variables (except internal keys)
    const internalKeys = new Set([
      "_interactive", "_i", "_cwd", "_subcommand", "_steps", "_output",
      "_isolated", "_system-prompt", "_append-system-prompt", "_hooks",
    ]);
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
          dryRun: parsed.dryRun,
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
      if (this.isStdinTTY && !jsonMode) {
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

    // Inject stdin as _stdin only when the expanded template references it.
    // Draining an unreferenced stdin can block forever on a never-closing
    // descriptor (hooks, cron, detached agents). Non-empty input becomes
    // {{ _stdin }}; empty input falls through to the normal missing-variable
    // flow (TTY prompt or TemplateError), same as before.
    if (requiredVars.includes("_stdin") && !("_stdin" in templateVars)) {
      const stdinContent = await readStdin();
      if (stdinContent) {
        templateVars["_stdin"] = stdinContent;
      }
    }

    const missingVars = requiredVars.filter((v) => !(v in templateVars));

    // Load variable history for this agent (unless --_no-history)
    const resolvedFilePath = resolve(localFilePath);
    let variableHistory: Record<string, string> = {};
    if (!noHistory && missingVars.length > 0) {
      const getVarHistory = await getVariableHistoryFn();
      variableHistory = await getVarHistory(resolvedFilePath);
    }

    // Track which variables were prompted (for saving to history later)
    const promptedVars: Record<string, string> = {};

    if (missingVars.length > 0) {
      if (this.isStdinTTY && !jsonMode) {
        this.writeStderr("Missing required variables. Please provide values:");
        for (const v of missingVars) {
          const previousValue = variableHistory[v];
          const value = await this.promptInputWithHistory(`${v}:`, previousValue);
          templateVars[v] = value;
          promptedVars[v] = value;
        }
      } else {
        throw new TemplateError(`Missing template variables: ${missingVars.join(", ")}. Use '_inputs:' in frontmatter to map CLI arguments to variables`);
      }
    }

    // Store prompted vars for later saving (attached to templateVars for access after execution)
    // We use a symbol-like key to avoid conflicts
    (templateVars as Record<string, unknown>)["__promptedVars__"] = promptedVars;
    (templateVars as Record<string, unknown>)["__noHistory__"] = noHistory;
    (templateVars as Record<string, unknown>)["__resolvedFilePath__"] = resolvedFilePath;

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
          dryRun: parsed.dryRun,
        });
        getImportLogger().debug({ expandedLength: phase3Body.length }, "Phase 3 complete");
      } catch (err) {
        getImportLogger().error({ error: (err as Error).message }, "Phase 3 command expansion failed");
        throw new ImportError(`Command error: ${(err as Error).message}`);
      }
    }

    let finalBody = phase3Body;

    const templateVarSet = new Set(Object.keys(templateVars));
    const args = [...buildArgs(frontmatter, templateVarSet, command), ...remaining];
    const positionalMappings = extractPositionalMappings(frontmatter);

    return { command, frontmatter, templateVars, finalBody, args, positionalMappings, interactiveMode };
  }

  private async handleDryRun(
    command: string, frontmatter: Record<string, unknown>, args: string[],
    positionals: string[], positionalMappings: Map<number, string>,
    isRemote: boolean, localFilePath: string
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
    // Mask sensitive argument values in console output
    this.writeStdout(`   ${command} ${maskArgsArray(dryRunArgs).join(" ")}\n`);
    this.writeStdout("Final Prompt:");
    this.writeStdout("───────────────────────────────────────────────────────────");
    this.writeStdout(positionals[0] ?? "");
    this.writeStdout("───────────────────────────────────────────────────────────\n");
    // The UI labels this as an estimate, so keep the dry-run path on the
    // dependency-free char/4 heuristic instead of loading gpt-tokenizer.
    const tokenCount = estimateTokens(positionals[0] ?? "");
    this.writeStdout(`Estimated tokens: ~${tokenCount.toLocaleString()}`);

    if (isRemote) await cleanupRemoteFile(localFilePath);
    throw new EarlyExitRequest();
  }

  private async handleWorkflowDryRun(
    command: string,
    args: string[],
    workflow: ParsedWorkflow,
    isRemote: boolean,
    localFilePath: string
  ): Promise<CliRunResult> {
    this.writeStdout("═══════════════════════════════════════════════════════════");
    this.writeStdout("DRY RUN - Workflow will NOT be executed");
    this.writeStdout("═══════════════════════════════════════════════════════════\n");
    this.writeStdout("Default command:");
    this.writeStdout(`   ${command} ${maskArgsArray(args).join(" ")}\n`);
    this.writeStdout("Workflow steps:");

    for (const batch of workflow.batches) {
      for (const step of batch) {
        const tool = step.tool ?? command;
        const needs = step.needs && step.needs.length > 0 ? ` needs=[${step.needs.join(", ")}]` : "";
        this.writeStdout(`  - ${step.id} (tool=${tool}${needs})`);
        this.writeStdout(`    run: ${step.run}`);
      }
    }

    if (isRemote) await cleanupRemoteFile(localFilePath);
    throw new EarlyExitRequest();
  }

  private async handleTOFU(
    filePath: string, localFilePath: string, command: string,
    baseFrontmatter: Record<string, unknown>, rawBody: string, jsonMode: boolean
  ): Promise<void> {
    const domain = extractDomain(filePath);
    const trusted = await isDomainTrusted(filePath);

    if (!trusted) {
      if (!this.isStdinTTY || jsonMode) {
        await cleanupRemoteFile(localFilePath);
        throw new SecurityError(`Untrusted remote domain: ${domain}. Use --_trust flag to bypass this check in non-interactive mode, or run interactively to add the domain to known_hosts.`);
      }

      const trustResult = await promptForTrust(filePath, command, baseFrontmatter as AgentFrontmatter, rawBody);
      if (!trustResult.approved) {
        await cleanupRemoteFile(localFilePath);
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

function getLastWorkflowOutput(result: WorkflowResult): string | undefined {
  for (let i = result.stepOrder.length - 1; i >= 0; i--) {
    const stepId = result.stepOrder[i];
    if (!stepId) continue;
    const step = result.steps[stepId];
    if (!step || step.skipped || step.exitCode !== 0) continue;
    if (step.stdout) return step.stdout;
  }
  return undefined;
}

/**
 * Format a command preview for the spinner message
 * Shows command + subcommands + key flags in a concise format
 * Sensitive values are masked to prevent accidental exposure
 */
function formatCommandPreview(command: string, args: string[], maxLength = 60): string {
  // Mask sensitive values before building the preview
  const maskedArgs = maskArgsArray(args);

  // Build a representation: command subcommand flag1 flag2 ...
  const parts = [command];

  // First, add any leading non-flag args (subcommands like "exec")
  let i = 0;
  while (i < maskedArgs.length) {
    const arg = maskedArgs[i];
    if (!arg || arg.startsWith("-")) break;
    // Include subcommands (short non-flag args)
    if (arg.length <= 20) {
      parts.push(arg);
    }
    i++;
  }

  // Then add flags and their short values
  for (; i < maskedArgs.length; i++) {
    const arg = maskedArgs[i];
    if (!arg) continue;

    if (arg.startsWith("-")) {
      // It's a flag - add it
      parts.push(arg);
      // Check if next arg is a short value (not another flag)
      const nextArg = maskedArgs[i + 1];
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
