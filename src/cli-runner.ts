/**
 * CliRunner - Testable entry point for mdflow CLI
 *
 * This class encapsulates all orchestration logic from main(), accepting
 * a SystemEnvironment for dependency injection. This enables testing
 * without spawning actual subprocesses or touching the real filesystem.
 */

import { parseFrontmatter, parseRawFrontmatter } from "./parse";
import { parseCliArgs, handleMaCommands } from "./cli";
import { subcommandHelpText, COMMAND_LIST_LINE } from "./command-help";
import type {
	AgentFrontmatter,
	CommandDefaults,
	FormInputs,
	InputDefinition,
	StructuredOutputConfig,
} from "./types";
import type { AdhocCommandResult } from "./adhoc-command";
import {
	isFormInputs,
	isLegacyInputs,
	collectFormInputs,
	getFormInputDefaults,
	getInputVariableNames,
	getMissingRequiredInputs,
} from "./form-inputs";
import {
	extractTemplateVars,
	extractRequiredTemplateVars,
	extractForeignTemplateGlobals,
} from "./template";
import {
	resolveEngine,
	type EngineSource,
	buildArgs,
	runCommand,
	extractPositionalMappings,
	extractEnvVars,
	killCurrentChildProcess,
	hasInteractiveMarker,
	levenshteinDistance,
} from "./command";
import type { ParsedWorkflow, WorkflowResult } from "./workflow";
import { getProcessManager } from "./process-manager";
import { isDocument } from "./flow-kind";
import { renderFlowPrompt } from "./prompt-render";
import {
	analyzeContext,
	printDashboard,
	shouldShowDashboard,
} from "./context-dashboard";
import { loadEnvFiles } from "./env";
import {
	loadFullConfig,
	applyDefaults,
	applyInteractiveMode,
	getDeclaredFlowDirectories,
	isInteractiveModeEnabled,
} from "./config";
import { getAdapter as getEngineAdapter } from "./adapters";
import { CODEX_ISOLATION_UNSET_ENV } from "./adapters/codex";
import {
	applyIsolationDefaults,
	applyIsolationEnvironment,
	resolveIsolationMode,
	resolveIsolationDefaults,
} from "./isolation";
import {
	extractSystemPromptSpec,
	applySystemPromptToFrontmatter,
} from "./system-prompt";
import {
	initLogger,
	getParseLogger,
	getCommandLogger,
	getCurrentLogPath,
	getLogger,
	resetLogger,
} from "./logger";
import {
	isDomainTrusted,
	promptForTrust,
	addTrustedDomain,
	extractDomain,
} from "./trust";
import { basename, dirname, resolve, join, delimiter, sep } from "path";
import { homedir } from "os";
import { existsSync } from "node:fs";
// Lazy-load heavy dependencies for cold start optimization
import { exceedsLimit, StdinSizeLimitError } from "./limits";
import { countTokensAsync, estimateTokens } from "./tokenizer";
import {
	MarkdownAgentError,
	EarlyExitRequest,
	UserCancelledError,
	FileNotFoundError,
	NetworkError,
	SecurityError,
	ConfigurationError,
	TemplateError,
	ImportError,
	CommandError,
} from "./errors";
import type { RunRecord } from "./telemetry";
import {
	compatNotice,
	stampCompatFile,
} from "./compat";
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
async function readFlowSource(path: string, fs: SystemEnvironment["fs"]): Promise<string> {
	if (!isRegistryPath(path)) return fs.readText(path);
	const { readVerifiedRegistryFlow } = await import("./registry");
	return readVerifiedRegistryFlow(path);
}

function workflowIdentity(path: string, isolated: boolean, body: string, { _compat, ...config }: AgentFrontmatter): string {
	return JSON.stringify([path, isolated, body, config]);
}

async function cleanupRemoteFile(localFilePath: string): Promise<void> {
	const { cleanupRemote } = await import("./remote");
	await cleanupRemote(localFilePath);
}

function isAdhocInvocationCandidate(
	argv: string[],
	invokedAs?: string,
): boolean {
	return [invokedAs, argv[1], argv[0]].some((value) => {
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
let _getVariableHistory: typeof import("./history").getVariableHistory | null =
	null;
let _saveVariableValues: typeof import("./history").saveVariableValues | null =
	null;

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
/**
 * md's own underscore CLI flags, for did-you-mean hints when an ad-hoc
 * `--_var` flag goes unused. `--_dry_run` is one edit away from
 * `--_dry-run` — silently treating the typo as a template variable made md
 * RUN a flow the user asked to preview.
 */
const MD_UNDERSCORE_FLAGS = [
	"_allow-nested",
	"_append-system-prompt",
	"_command",
	"_context",
	"_cwd",
	"_dry-run",
	"_edit",
	"_hooks",
	"_interactive",
	"_isolated",
	"_no-cache",
	"_no-evolve",
	"_no-history",
	"_no-menu",
	"_quiet",
	"_resume",
	"_system-prompt",
	"_trust",
] as const;

/**
 * Warnings for CLI-provided template variables the flow never references.
 * Pure (returns lines) so tests can pin the exact behavior.
 */
export function unusedCliVarWarnings(
	adHocVars: Iterable<string>,
	referencedVars: Iterable<string>,
	inputNames: Iterable<string>,
): string[] {
	const referenced = new Set(referencedVars);
	const declared = new Set(inputNames);
	const warnings: string[] = [];
	for (const key of adHocVars) {
		if (referenced.has(key) || declared.has(key)) continue;
		let best: { flag: string; distance: number } | undefined;
		for (const flag of MD_UNDERSCORE_FLAGS) {
			const distance = levenshteinDistance(key, flag);
			if (!best || distance < best.distance) best = { flag, distance };
		}
		const hint =
			best && best.distance <= 2 ? ` Did you mean --${best.flag}?` : "";
		warnings.push(
			`Warning [UNUSED_VARIABLE_FLAG]: --${key} was provided but this flow never uses {{ ${key} }} — it had no effect.${hint}`,
		);
	}
	return warnings;
}

/**
 * Actionable fail-fast error for missing template variables in a run that
 * cannot prompt anywhere: name the exact flags to pass, and explain _stdin
 * separately — it comes from piped input, not a flag.
 */
export function missingVariablesMessage(
	filePath: string,
	missingVars: string[],
): string {
	const fileLabel = basename(filePath);
	const flagVars = missingVars.filter((v) => v !== "_stdin");
	const lines = [`Missing template variables: ${missingVars.join(", ")}`];
	if (flagVars.length > 0) {
		const flags = flagVars.map((v) => `--${v} "<value>"`).join(" ");
		lines.push(`Provide values as flags: md ${fileLabel} ${flags}`);
	}
	if (missingVars.includes("_stdin")) {
		lines.push(
			`{{ _stdin }} comes from piped input: <command> | md ${fileLabel}`,
		);
	}
	lines.push(
		"(In a terminal, md prompts for these instead of failing.)",
	);
	return lines.join("\n");
}

export function promptPositionals(
	prompt: string,
	interactive: boolean,
): string[] {
	return interactive && !prompt.trim() ? [] : [prompt];
}

export interface WorkbenchChildInvocation {
	executable: string;
	args: string[];
}

/** Build an argv-safe relaunch of the currently running mdflow entrypoint. */
export function buildWorkbenchChildInvocation(
	currentArgv: readonly string[],
	selectedFile: string,
	passthroughArgs: readonly string[],
): WorkbenchChildInvocation {
	const executable = currentArgv[0];
	const entrypoint = currentArgv[1];
	if (!executable || !entrypoint) {
		throw new CommandError(
			"Cannot launch the selected Workbench flow: the current mdflow executable or entrypoint is unavailable.",
			{
				errorCode: "COMMAND_EXECUTION_FAILED",
				context: {
					argvPrefix: currentArgv.slice(0, 2),
					selectedFile,
				},
			},
		);
	}

	return {
		executable,
		args: [entrypoint, selectedFile, ...passthroughArgs],
	};
}

function definedEnvironment(
	environment: Record<string, string | undefined>,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(environment).filter(
			(entry): entry is [string, string] => entry[1] !== undefined,
		),
	);
}

function releaseTerminalForWorkbenchChild(): void {
	getProcessManager().restoreTerminal();
	if (process.stdin.isTTY) {
		try {
			process.stdin.setRawMode?.(false);
		} catch {
			// Best effort: the new process still gets a clean prompt lifecycle.
		}
		process.stdin.pause();
	}
	if (process.stdout.isTTY) process.stdout.write("\x1b[?25h");
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
	promptInputWithHistory?: (
		message: string,
		defaultValue?: string,
	) => Promise<string>;
	/** Command executor override for deterministic orchestration tests. */
	runCommandFn?: typeof runCommand;
	/** Workbench selection override for deterministic handoff tests. */
	handleMaCommandsFn?: typeof handleMaCommands;
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
	private promptInputWithHistory: (
		message: string,
		defaultValue?: string,
	) => Promise<string>;
	private runCommandFn: typeof runCommand;
	private handleMaCommandsFn: typeof handleMaCommands;
	private jsonModeState: JsonModeState | null = null;
	/**
	 * Whether a run with non-TTY stdin may still prompt on /dev/tty (see
	 * tty-prompt.ts). Enabled only for real invocations: any harness that
	 * stubs stdin behavior (tests, embedders) opts out implicitly, and eval
	 * children (MDFLOW_EVAL_RUN=1) and MDFLOW_NO_TTY_PROMPT=1 opt out at
	 * prompt time so hermetic runs can never block on a hidden terminal.
	 */
	private allowTtyPromptFallback: boolean;

	constructor(options: CliRunnerOptions) {
		this.env = options.env;
		this.processEnv = options.processEnv ?? process.env;
		this.cwd = options.cwd ?? process.cwd();
		this.isStdinTTY = options.isStdinTTY ?? Boolean(process.stdin.isTTY);
		this.isStdoutTTY = options.isStdoutTTY ?? Boolean(process.stdout.isTTY);
		this.stdinContent = options.stdinContent;
		// Lazy-load input prompt only when actually needed
		this.promptInput =
			options.promptInput ??
			(async (msg) => {
				const inputFn = await getInputPrompt();
				return inputFn({ message: msg });
			});
		// Prompt with history shows previous value as default
		// Format: "Variable name: (previous_value) _" - press Enter to accept
		this.promptInputWithHistory =
			options.promptInputWithHistory ??
			(async (msg, defaultValue) => {
				const inputFn = await getInputPrompt();
				return inputFn({ message: msg, default: defaultValue });
			});
		this.runCommandFn = options.runCommandFn ?? runCommand;
		this.handleMaCommandsFn = options.handleMaCommandsFn ?? handleMaCommands;
		this.allowTtyPromptFallback =
			options.isStdinTTY === undefined &&
			options.stdinContent === undefined &&
			options.promptInputWithHistory === undefined;
	}

	/**
	 * Open /dev/tty for prompting when stdin can't be used (piped, drained,
	 * or attached to a parent process). Null when prompting would be wrong:
	 * hermetic eval children, explicit opt-out, or no terminal anywhere —
	 * a human must plausibly be watching (stdout or stderr is a TTY).
	 */
	private async openTtyFallback(): Promise<
		import("./tty-prompt").TtyPromptChannel | null
	> {
		if (!this.allowTtyPromptFallback) return null;
		if (this.processEnv.MDFLOW_EVAL_RUN === "1") return null;
		if (this.processEnv.MDFLOW_NO_TTY_PROMPT) return null;
		if (!this.isStdoutTTY && !process.stderr.isTTY) return null;
		const { openTtyPromptChannel } = await import("./tty-prompt");
		return openTtyPromptChannel();
	}

	private async readStdin(): Promise<string> {
		if (this.stdinContent !== undefined) return this.stdinContent;
		if (this.isStdinTTY) return "";
		// A subprocess caller may supply a regular/anonymous file descriptor, not
		// just a shell pipe. Read both through Bun's native file/pipe reader.
		const reader = Bun.stdin.stream().getReader();
		const chunks: Uint8Array[] = [];
		let totalBytes = 0;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				totalBytes += value.byteLength;
				if (exceedsLimit(totalBytes)) {
					await reader.cancel();
					throw new StdinSizeLimitError(totalBytes);
				}
				chunks.push(value);
			}
		} finally { reader.releaseLock(); }
		return Buffer.concat(chunks, totalBytes).toString("utf-8").trim();
	}

	// Draining stdin blocks until EOF, and a headless caller (hook, cron job,
	// detached agent) can hand us a descriptor that never closes. Reading is
	// therefore deferred until the expanded template actually references
	// {{ _stdin }}, and memoized so it is drained at most once per process.
	private stdinReadOnce: Promise<string> | undefined;
	private readStdinOnce(): Promise<string> {
		return (this.stdinReadOnce ??= this.readStdin());
	}

	private writeStdout(data: string): void {
		console.log(data);
	}
	private writeStderr(data: string): void {
		console.error(data);
	}

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
	 *    3b. Project registry installs: ./.mdflow/registry/<filename>
	 * 4. User flows: ~/.mdflow/flows/<filename>
	 *    4b. User registry installs: ~/.mdflow/registry/<filename>
	 * 5. Config-declared roster directories (flows.directories)
	 * 6. Legacy user agents: ~/.mdflow/<filename>
	 * 7. PATH directories (for files without path separators)
	 *
	 * Simple flow names may omit the .md extension (`md review`).
	 */
	private async resolveFilePath(filePath: string): Promise<string> {
		const simpleName = !filePath.includes("/") && !filePath.includes(sep);
		const candidateNames =
			simpleName && !filePath.toLowerCase().endsWith(".md")
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
			const { projectRoot } = await resolveProjectRootWith(
				this.cwd,
				this.env.fs,
			);

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

			// 3b. Registry installs at the project scope. `md install` puts
			// flows here and `md list`/the roster surface them — chaos round 4
			// found them unreachable by name (the runner never looked).
			// Registry provenance (remote hooks trust) is enforced downstream
			// via isRegistryFlowPath, not by hiding the file.
			for (const candidate of candidateNames) {
				const projectRegistryPath = join(
					projectRoot,
					".mdflow",
					"registry",
					candidate,
				);
				if (await this.env.fs.exists(projectRegistryPath)) {
					return projectRegistryPath;
				}
			}

			// 4. Try the canonical user roster: ~/.mdflow/flows/
			for (const candidate of candidateNames) {
				const userFlowsPath = join(homedir(), ".mdflow", "flows", candidate);
				if (await this.env.fs.exists(userFlowsPath)) {
					return userFlowsPath;
				}
			}

			// 4b. Registry installs at the user scope.
			for (const candidate of candidateNames) {
				const userRegistryPath = join(
					homedir(),
					".mdflow",
					"registry",
					candidate,
				);
				if (await this.env.fs.exists(userRegistryPath)) {
					return userRegistryPath;
				}
			}

			// 5. Try config-declared roster directories
			try {
				const declared = await getDeclaredFlowDirectories({
					cwd: this.configCwd(),
				});
				for (const dir of [...declared.project, ...declared.global]) {
					for (const candidate of candidateNames) {
						const declaredPath = join(dir, candidate);
						if (await this.env.fs.exists(declaredPath)) {
							return declaredPath;
						}
					}
				}
			} catch {
				// Declared directories are best-effort for name resolution; a
				// broken config is reported by the main config load path.
			}

			// 6. Try the legacy user directory: ~/.mdflow/
			for (const candidate of candidateNames) {
				const userPath = join(homedir(), ".mdflow", candidate);
				if (await this.env.fs.exists(userPath)) {
					return userPath;
				}
			}

			// 7. Try $PATH directories
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

	private parseRegistryArgs(args: string[]): {
		scope?: "project" | "user";
		positional: string[];
	} {
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

	/**
	 * Reject unknown flags on registry subcommands (install/remove/list).
	 * Their only valid positionals are URLs and flow names, which never begin
	 * with "-", so a dash-prefixed positional is a typo'd/unknown flag — e.g.
	 * `md remove --gobal name` used to silently remove from the wrong scope
	 * (chaos round 6). Only `--json` is allowed alongside (handled elsewhere).
	 */
	private assertNoUnknownRegistryFlags(
		subcommand: string,
		positional: string[],
	): void {
		const unknown = positional.find(
			(arg) => arg.startsWith("-") && arg !== "--json",
		);
		if (unknown) {
			throw new ConfigurationError(
				`Unknown ${subcommand} option: ${unknown}. ` +
					`Valid flags: --global (-g) / --project (-p). Run 'md ${subcommand} --help'.`,
				1,
			);
		}
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
		return args
			.map((arg) => {
				if (typeof arg === "string") return arg;
				try {
					return JSON.stringify(arg);
				} catch {
					return String(arg);
				}
			})
			.join(" ");
	}

	private buildSpawnArgs(
		args: string[],
		positionals: string[],
		positionalMappings: Map<number, string>,
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
		capturedStderr: string[],
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

	/** Every CLI projection crosses this boundary with its final (possibly edited,
	 * retried, or workflow-generated) prompt. Rendering flags cannot lift a limit. */
	private async executeCommand(
		ctx: Parameters<typeof runCommand>[0],
		frontmatter: AgentFrontmatter,
		parsed: { jsonMode: boolean; allowNested: boolean },
	): Promise<Awaited<ReturnType<typeof runCommand>>> {
		getProcessManager().signal.throwIfAborted();
		const limit = frontmatter._max_prompt_tokens;
		if (limit !== undefined) {
			if (!Number.isSafeInteger(limit) || limit <= 0) throw new ConfigurationError("_max_prompt_tokens must be a positive integer", 1);
			const tokens = await countTokensAsync(ctx.positionals.join("\n"));
			if (tokens > limit) throw new MarkdownAgentError(
				`Prompt is ~${tokens.toLocaleString()} tokens, over the _max_prompt_tokens limit of ${limit.toLocaleString()}. Narrow the imports or raise the limit.`,
				{ errorCode: "PROMPT_TOKEN_LIMIT", exitCode: 1 },
			);
		}
		getProcessManager().signal.throwIfAborted();
		ctx = { ...ctx, allowNested: parsed.allowNested, timeoutMs: frontmatter._max_runtime_ms };
		if (!parsed.jsonMode || ctx.captureOutput === "stream") return this.runCommandFn(ctx);
		this.recordJsonCommand(ctx.command, this.buildSpawnArgs(ctx.args, ctx.positionals, ctx.positionalMappings));
		const result = await this.runCommandFn({ ...ctx, silentCapture: true });
		this.recordJsonResult(result.stdout, result.stderr);
		return result;
	}

	private async showContextOnly(path: string, body: string, dir: string): Promise<void> {
		if (shouldShowDashboard(body)) printDashboard(await analyzeContext(path, body, dir));
		else this.writeStderr("No imports found in this agent file.");
	}

	private calculateOutputBytes(stdout: string, stderr: string): number {
		return (
			Buffer.byteLength(stdout, "utf-8") + Buffer.byteLength(stderr, "utf-8")
		);
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
		currentState:
			| "adhoc_command_completed"
			| "workflow_completed"
			| "command_completed";
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
				"Run telemetry recorded",
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
				"Run telemetry recording failed",
			);
		}
	}

	/**
	 * After a successful run, record the running mdflow version in the flow's
	 * `_compat` frontmatter key. Skipped for remote flows (the local file is a
	 * throwaway copy) and eval runs (isolated workspaces; MDFLOW_EVAL_RUN=1).
	 * Best-effort: a failed stamp never affects the run's outcome.
	 */
	private stampCompatAfterSuccess(
		localFilePath: string,
		isRemote: boolean,
	): void {
		if (isRemote || isRegistryPath(localFilePath) || process.env.MDFLOW_EVAL_RUN === "1") return;
		try {
			if (stampCompatFile(resolve(localFilePath))) {
				getCommandLogger().debug(
					{ agentPath: localFilePath },
					"Stamped _compat version",
				);
			}
		} catch {
			// Never let version stamping interfere with a successful run.
		}
	}

	async run(argv: string[]): Promise<CliRunResult> {
		const jsonMode = argv.includes("--json");
		const subcommand = parseCliArgs(argv).filePath;
		const nativeJsonSubcommand =
			subcommand !== undefined &&
			[
				"doctor",
				"eval",
				"evolve",
				"feedback",
				"complain",
				"roster",
				"explain",
				"render",
				"catalog",
			].includes(subcommand);
		let logPath: string | null = null;
		// Structured lifecycle commands own their JSON schema. Letting the generic
		// flow wrapper capture them would double-encode their payload in `stdout`.
		if (!jsonMode || nativeJsonSubcommand || argv.includes("--events")) {
			try {
				return await this.runInternal(argv, (lp) => {
					logPath = lp;
				});
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
				result = await this.runInternal(argv, (lp) => {
					logPath = lp;
				});
			} catch (err) {
				result = this.handleError(err, logPath);
			}
		} finally {
			console.log = originalLog;
			console.error = originalError;
		}

		const payload = this.buildJsonModePayload(
			result,
			capturedStdout,
			capturedStderr,
		);
		process.stdout.write(`${JSON.stringify(payload)}\n`);
		this.jsonModeState = null;
		return result;
	}

	private handleError(err: unknown, logPath: string | null): CliRunResult {
		if (err instanceof EarlyExitRequest) return { exitCode: err.code, logPath };
		if (err instanceof UserCancelledError)
			return { exitCode: err.code, logPath };
		if (err instanceof MarkdownAgentError) {
			this.printErrorWithLogPath(`Agent failed: ${err.message}`, logPath);
			return { exitCode: err.code, errorMessage: err.message, logPath };
		}
		const errorMessage = (err as Error).message;
		this.printErrorWithLogPath(`Agent failed: ${errorMessage}`, logPath);
		return { exitCode: 1, errorMessage, logPath };
	}

	private async launchWorkbenchFlow(
		currentArgv: readonly string[],
		selectedFile: string,
		passthroughArgs: readonly string[],
	): Promise<CliRunResult> {
		const invocation = buildWorkbenchChildInvocation(
			currentArgv,
			selectedFile,
			passthroughArgs,
		);
		releaseTerminalForWorkbenchChild();

		let child: ReturnType<SystemEnvironment["shell"]["spawn"]>;
		try {
			child = this.env.shell.spawn(invocation.executable, invocation.args, {
				cwd: this.cwd,
				env: definedEnvironment(this.processEnv),
				stdin: "inherit",
				stdout: "inherit",
				stderr: "inherit",
			});
		} catch (cause) {
			throw new CommandError(
				`Failed to launch selected Workbench flow: ${selectedFile}`,
				{
					errorCode: "COMMAND_EXECUTION_FAILED",
					context: { selectedFile, cwd: this.cwd },
					cause,
				},
			);
		}

		const rawProcess = child._process as
			| ReturnType<typeof Bun.spawn>
			| undefined;
		if (rawProcess) {
			getProcessManager().register(
				rawProcess,
				`mdflow Workbench run: ${selectedFile}`,
			);
		}

		try {
			return { exitCode: await child.exited };
		} catch (cause) {
			throw new CommandError(
				`Selected Workbench flow terminated unexpectedly: ${selectedFile}`,
				{
					errorCode: "COMMAND_EXECUTION_FAILED",
					context: { selectedFile, cwd: this.cwd },
					cause,
				},
			);
		}
	}

	private async runInternal(
		argv: string[],
		setLogPath: (lp: string | null) => void,
	): Promise<CliRunResult> {
		// Check for ad-hoc command invocation (md.claude, md.gemini, etc.).
		// The node launcher erases the invoked name from argv; it forwards
		// the original executable basename via MDFLOW_INVOKED_AS.
		const invokedAs = this.processEnv.MDFLOW_INVOKED_AS;
		if (isAdhocInvocationCandidate(argv, invokedAs)) {
			const { detectAdhocCommand } = await import("./adhoc-command");
			const adhocResult = detectAdhocCommand(argv, invokedAs);
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
		if (subcommand === "capture") {
			// FREE: prints the conversation-capture guide for the agent session
			// this command was invoked from. No engine, no reads, no writes.
			const { buildCaptureGuide } = await import("./capture");
			this.writeStdout(buildCaptureGuide());
			return { exitCode: 0 };
		}
		if (subcommand === "setup") {
			// Setup is an interactive wizard end to end; without a TTY it would
			// emit inquirer control sequences into a pipe instead of prompting.
			if (!this.isStdinTTY || !this.isStdoutTTY) {
				this.writeStderr(
					"md setup requires an interactive terminal (TTY_REQUIRED).",
				);
				this.writeStderr(
					"It edits shell config files and always confirms first, so it cannot run in a pipe.",
				);
				this.writeStderr(
					"Run 'md setup' in a terminal, or see 'md setup --help'.",
				);
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
			this.assertNoUnknownRegistryFlags("install", registryArgs.positional);
			const { installAgent } = await import("./registry");
			const spec = registryArgs.positional[0];
			if (!spec) {
				throw new ConfigurationError(
					"Usage: md install <url|gh:org/repo/path/to/agent.md@ref>",
					1,
				);
			}

			const installed = await installAgent(spec, {
				scope: registryArgs.scope,
				cwd: this.cwd,
			});
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
			this.assertNoUnknownRegistryFlags("remove", registryArgs.positional);
			const { removeAgent } = await import("./registry");
			const name = registryArgs.positional[0];
			if (!name) {
				throw new ConfigurationError("Usage: md remove <agent-name>", 1);
			}

			const removed = await removeAgent(name, {
				scope: registryArgs.scope,
				cwd: this.cwd,
			});
			if (!removed.removed) {
				throw new ConfigurationError(`Registry agent not found: ${name}`, 1);
			}

			this.writeStdout(
				`Removed: ${removed.name} (${removed.removedFrom.join(", ")})`,
			);
			return { exitCode: 0 };
		}
		if (subcommand === "list") {
			this.assertNoUnknownRegistryFlags("list", registryArgs.positional);
			const { listAgents } = await import("./registry");
			const agents = await listAgents({
				scope: registryArgs.scope,
				cwd: this.cwd,
			});
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
		if (subcommand === "doctor") {
			const { runDoctor } = await import("./doctor");
			return {
				exitCode: await runDoctor(cliArgs.passthroughArgs, { cwd: this.cwd }),
			};
		}
		if (subcommand === "roster") {
			const { runRoster } = await import("./roster");
			return { exitCode: await runRoster(cliArgs.passthroughArgs, this.cwd) };
		}
		if (subcommand === "catalog") {
			const { runCatalog } = await import("./catalog");
			return { exitCode: await runCatalog(cliArgs.passthroughArgs, this.cwd) };
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
		if (
			!filePath &&
			(passthroughArgs.includes("--version") || passthroughArgs.includes("-v"))
		) {
			const { mdflowVersion } = await import("./compat");
			this.writeStdout(mdflowVersion());
			return { exitCode: 0 };
		}

		if (!filePath || subcommand === "help") {
			if (jsonModeRequested && !filePath && subcommand !== "help") {
				this.writeStderr("Usage: md <file.md> [flags for command]");
				this.writeStderr("       md <command> [options]");
				this.writeStderr(`\n${COMMAND_LIST_LINE}`);
				this.writeStderr(
					"Run 'md help' for more info, 'md roster --json' to list flows,",
				);
				this.writeStderr(
					"or 'md' with no arguments to open the Flow Workbench",
				);
				throw new ConfigurationError("No agent file specified", 1);
			}
			const result = await this.handleMaCommandsFn(cliArgs);
			if (result.selectedFile) {
				if (!result.dryRun) {
					return this.launchWorkbenchFlow(
						argv,
						result.selectedFile,
						passthroughArgs,
					);
				}
				filePath = result.selectedFile;
				// Shift+Enter keeps the free preview in the current process.
				passthroughArgs = ["--_dry-run", ...passthroughArgs];
			} else if (!result.handled) {
				this.writeStderr("Usage: md <file.md> [flags for command]");
				this.writeStderr("       md <command> [options]");
				this.writeStderr(`\n${COMMAND_LIST_LINE}`);
				this.writeStderr(
					"Run 'md help' for more info, 'md roster --json' to list flows,",
				);
				this.writeStderr(
					"or 'md' with no arguments to open the Flow Workbench",
				);
				throw new ConfigurationError("No agent file specified", 1);
			}
		}

		// NDJSON run event stream (Flow UX Protocol v1). stdout is protocol-pure;
		// the flag is consumed here and never reaches the engine.
		if (passthroughArgs.includes("--events")) {
			return this.runAgentEvents(
				filePath,
				passthroughArgs.filter((arg) => arg !== "--events"),
				setLogPath,
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
		setLogPath: (lp: string | null) => void,
	): Promise<CliRunResult> {
		const {
			command,
			body,
			passthroughArgs = [],
			interactive = false,
		} = adhocResult;

		if (!command) {
			throw new ConfigurationError(
				"No command detected in ad-hoc invocation",
				1,
			);
		}

		if (!body) {
			this.writeStderr(`Usage: md.${command} "your prompt here" [flags]`);
			this.writeStderr(
				`       md.i.${command} "prompt" # for interactive mode`,
			);
			this.writeStderr(`\nExamples:`);
			this.writeStderr(`  md.${command} "What is 2+2?"`);
			this.writeStderr(
				`  md.${command} "Explain this: @error.log" --model opus`,
			);
			throw new ConfigurationError("No prompt provided", 1);
		}

		// Create virtual agent content and filename
		const { createVirtualAgentContent, createVirtualFilename } = await import(
			"./adhoc-command"
		);
		const virtualContent = createVirtualAgentContent(
			command,
			body,
			interactive,
		);
		const virtualFilename = createVirtualFilename(command, interactive);

		// Add interactive flag to passthrough args if needed
		const finalPassthroughArgs =
			interactive && !passthroughArgs.includes("--_interactive")
				? ["--_interactive", ...passthroughArgs]
				: passthroughArgs;

		// Run through the normal agent flow using the virtual filename for command resolution
		// We need to create a temporary in-memory approach - but since runAgent needs a file path,
		// we'll use a special virtual file approach

		return this.runVirtualAgent(
			virtualFilename,
			virtualContent,
			finalPassthroughArgs,
			setLogPath,
		);
	}

	/**
	 * Run a virtual agent (content provided directly, not from a file)
	 */
	private async runVirtualAgent(
		virtualFilename: string,
		content: string,
		passthroughArgs: string[],
		setLogPath: (lp: string | null) => void,
	): Promise<CliRunResult> {
		// Initialize ProcessManager for centralized lifecycle management
		const pm = getProcessManager();
		pm.initialize();

		// Parse md-owned flags before creating a file logger so previews remain
		// side-effect free and never load Pino.
		if (passthroughArgs.includes("--events")) throw new ConfigurationError("--events requires a flow file, not an ad-hoc prompt", 1);
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

		const { frontmatter: baseFrontmatter, body: rawBody } =
			parseFrontmatter(content);
		getParseLogger().debug(
			{ frontmatter: baseFrontmatter, bodyLength: rawBody.length, adhoc: true },
			"Virtual frontmatter parsed",
		);
		if (parsed.contextOnly) {
			await this.showContextOnly(virtualFilename, rawBody, this.cwd);
			return { exitCode: 0 };
		}

		const {
			command,
			frontmatter,
			templateVars,
			finalBody,
			args,
			positionalMappings,
			interactiveMode,
			isolated,
			commandCwd,
			flowPath,
		} = await this.processAgent(
			virtualFilename,
			baseFrontmatter,
			rawBody,
			() => this.readStdinOnce(),
			parsed,
			parsed.dryRun ? undefined : startLogger,
		);

		// Dry run
		if (parsed.dryRun) {
			return this.handleDryRun(
				command,
				frontmatter,
				args,
				[finalBody],
				positionalMappings,
				false,
				virtualFilename,
			);
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
			getCommandLogger().debug(
				{ originalLength: finalBody.length, editedLength: promptToRun.length },
				"Prompt edited",
			);
		}

		// Execute
		let finalRunArgs = args;
		if (frontmatter._subcommand) {
			const subs = Array.isArray(frontmatter._subcommand)
				? frontmatter._subcommand.map(String)
				: [String(frontmatter._subcommand)];
			finalRunArgs = [...subs, ...args];
		}

		getCommandLogger().info(
			{
				command,
				argsCount: finalRunArgs.length,
				promptLength: promptToRun.length,
				adhoc: true,
			},
			"Executing ad-hoc command",
		);

		// Start spinner with command preview
		if (!parsed.jsonMode && !interactiveMode) {
			const preview = formatCommandPreview(command, finalRunArgs);
			const { startSpinner } = await import("./spinner");
			startSpinner(preview);
		}

		// Determine if we should capture output for post-run menu
		// Disable when piping (stdout not TTY) to support: foo.md | bar.md
		const shouldShowMenu =
			!interactiveMode &&
			this.isStdinTTY &&
			this.isStdoutTTY &&
			!parsed.noMenu &&
			!parsed.jsonMode;
		const structuredOutputConfig = this.getStructuredOutputConfig(frontmatter);
		const captureMode = interactiveMode
			? false
			: parsed.jsonMode
				? ("capture" as const)
				: shouldShowMenu
					? ("tee" as const)
					: structuredOutputConfig
						? ("capture" as const)
						: false;

		const commandStartedAt = Date.now();
		const runResult = await this.executeCommand(
			{
				command,
				args: finalRunArgs,
				positionals: [promptToRun],
				positionalMappings,
				captureOutput: captureMode,
				captureStderr: !interactiveMode && (parsed.jsonMode || shouldShowMenu),
				interactive: interactiveMode,
				env: extractEnvVars(frontmatter),
				rawOutput: parsed.rawOutput,
				isolated,
				flowPath,
				cwd: commandCwd,
			},
			frontmatter, parsed,
		);
		const commandDurationMs = Date.now() - commandStartedAt;

		await this.recordRunTelemetry({
			agentPath: virtualFilename,
			tool: command,
			durationMs: commandDurationMs,
			exitCode: runResult.exitCode,
			outputBytes: this.calculateOutputBytes(
				runResult.stdout,
				runResult.stderr,
			),
			currentState: "adhoc_command_completed",
		});

		getCommandLogger().info(
			{ exitCode: runResult.exitCode, adhoc: true },
			"Ad-hoc command completed",
		);

		if (runResult.exitCode !== 0) {
			this.printErrorWithLogPath(
				`Agent exited with code ${runResult.exitCode}`,
				logPath,
			);
		}

		if (runResult.exitCode === 0 && structuredOutputConfig) {
			const structuredOutputCwd =
				parsed.cwdFromCli ??
				(frontmatter._cwd as string | undefined) ??
				this.cwd;
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
				const { showPostRunMenu, executePostRunAction } = await import(
					"./post-run-menu"
				);
				const menuResult = await showPostRunMenu(runResult.stdout);
				if (menuResult && menuResult.action !== "exit") {
					await executePostRunAction(menuResult, runResult.stdout);
				}
			} catch {
				// Menu cancelled or failed, just continue
			}
		}

		getLogger().info(
			{ exitCode: runResult.exitCode, adhoc: true },
			"Ad-hoc session ended",
		);
		return { exitCode: runResult.exitCode, logPath };
	}

	private async runAgent(
		filePath: string,
		passthroughArgs: string[],
		setLogPath: (lp: string | null) => void,
	): Promise<CliRunResult> {
		let localFilePath = filePath;
		let isRemote = false;

		// Check for --_no-cache flag early (needed before fetchRemote call)
		let noCacheFlag = false;
		const noCacheIdx = passthroughArgs.indexOf("--_no-cache");
		if (noCacheIdx !== -1) {
			noCacheFlag = true;
			passthroughArgs = [
				...passthroughArgs.slice(0, noCacheIdx),
				...passthroughArgs.slice(noCacheIdx + 1),
			];
		}

		if (isRemoteUrl(filePath)) {
			const { fetchRemote } = await import("./remote");
			const remoteResult = await fetchRemote(filePath, {
				noCache: noCacheFlag,
			});
			if (!remoteResult.success) {
				throw new NetworkError(
					`Failed to fetch remote file: ${remoteResult.error}`,
				);
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
			throw new FileNotFoundError(
				this.fileNotFoundMessage(filePath, localFilePath),
			);
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
		if (!isRemote && !isRegistryPath(localFilePath)) await loadEnvFiles(fileDir);

		const content = await readFlowSource(localFilePath, this.env.fs);
		const { frontmatter: baseFrontmatter, body: rawBody } =
			parseFrontmatter(content);
		getParseLogger().debug(
			{ frontmatter: baseFrontmatter, bodyLength: rawBody.length },
			"Frontmatter parsed",
		);

		// Remote execution trust must be decided before any import expansion.
		// processAgent() materializes content and command inlines, so placing the
		// TOFU gate after it would allow an untrusted remote flow to perform host
		// work before the user has approved the source.
		if (isRemote && !parsed.trustFlag) {
			const fullConfig = await loadFullConfig(this.configCwd());
			const trustCommand =
				parsed.commandFromCli ??
				resolveEngine(localFilePath, baseFrontmatter as AgentFrontmatter, {
					configEngine: fullConfig.engine,
				}).engine;
			await this.handleTOFU(
				filePath,
				localFilePath,
				trustCommand,
				baseFrontmatter,
				rawBody,
				parsed.jsonMode,
			);
		}

		// Context-only mode: show dashboard and exit without executing
		if (parsed.contextOnly) {
			await this.showContextOnly(localFilePath, rawBody, fileDir);
			if (isRemote) await cleanupRemoteFile(localFilePath);
			throw new EarlyExitRequest();
		}

		const {
			command,
			frontmatter,
			templateVars,
			finalBody,
			args,
			positionalMappings,
			interactiveMode,
			isolated,
			commandCwd,
			flowPath,
		} = await this.processAgent(
			localFilePath,
			baseFrontmatter,
			rawBody,
			() => this.readStdinOnce(),
			parsed,
			parsed.dryRun ? undefined : startLogger,
			isRemote || isRegistryPath(localFilePath),
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
				Object.entries(templateVars).filter(([key]) => !key.startsWith("__")),
			);

			if (parsed.dryRun) {
				return this.handleWorkflowDryRun(
					command,
					workflowRunArgs,
					workflow,
					isRemote,
					localFilePath,
				);
			}

			const shouldShowMenu =
				this.isStdinTTY &&
				this.isStdoutTTY &&
				!parsed.noMenu &&
				!parsed.jsonMode;
			const captureMode = parsed.jsonMode
				? ("capture" as const)
				: this.isStdoutTTY
					? ("tee" as const)
					: ("capture" as const);
			const cacheBaseDir =
				parsed.cwdFromCli ??
				(frontmatter._cwd as string | undefined) ??
				this.cwd;
			if (parsed.jsonMode) {
				this.recordJsonCommand(command, workflowRunArgs);
			}

			const workflowStartedAt = Date.now();
			let workflowUsageSignal: {
				quickRerun: boolean;
				msSincePrevious: number | null;
			} | null = null;
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
				flowIdentity: workflowIdentity(flowPath, isolated, rawBody, frontmatter),
				runCommandFn: (ctx) =>
					this.executeCommand(
						{
							...ctx,
							isolated,
							flowPath,
							cwd: ctx.cwd ?? commandCwd,
						},
						frontmatter, parsed,
					),
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
				const usageSignal = await getRecordUsage()
					.then((recordUsage) => recordUsage(localFilePath))
					.catch(() => null);
				workflowUsageSignal = usageSignal;
				if (
					!parsed.noEvolve &&
					!parsed.jsonMode &&
					!isRemote &&
					existsSync(localFilePath)
				) {
					const { handleAutoEvolve } = await import("./evolve");
					await handleAutoEvolve(
						resolve(localFilePath),
						usageSignal ?? { quickRerun: false, msSincePrevious: null },
						(line) => this.writeStderr(line),
					);
				}

				const promptedVars = (templateVars as Record<string, unknown>)[
					"__promptedVars__"
				] as Record<string, string> | undefined;
				const noHistoryFlag = (templateVars as Record<string, unknown>)[
					"__noHistory__"
				] as boolean | undefined;
				const resolvedPath = (templateVars as Record<string, unknown>)[
					"__resolvedFilePath__"
				] as string | undefined;

				if (
					promptedVars &&
					Object.keys(promptedVars).length > 0 &&
					!noHistoryFlag &&
					resolvedPath
				) {
					getSaveVariableValuesFn()
						.then((saveVars) => saveVars(resolvedPath, promptedVars))
						.catch(() => {}); // Fire and forget
				}
			}

			if (isRemote) await cleanupRemoteFile(localFilePath);

			if (workflowResult.exitCode !== 0) {
				this.printErrorWithLogPath(
					`Agent exited with code ${workflowResult.exitCode}`,
					logPath,
				);
				if (shouldShowMenu && !isRemote) {
					try {
						const failedStep = [...workflowResult.stepOrder]
							.reverse()
							.map((id) => workflowResult.steps[id])
							.find((step) => step && !step.skipped && step.exitCode !== 0);
						const { confirm } = await import("@inquirer/prompts");
						if (
							await confirm({
								message: "Report this workflow failure as feedback?",
								default: false,
							})
						) {
							const message = await this.promptInput(
								"What should this workflow have done instead?",
							);
							if (message.trim()) {
								const { recordEvidence } = await import("./evolution-store");
								const feedback = recordEvidence({
									flowPath: localFilePath,
									type: "run_failure",
									confidence: "high",
									failureClass: "behavior",
									message: message.trim(),
									redactedOutputRef: logPath ?? undefined,
									inputHash: failedStep
										? Bun.hash(
												`${failedStep.id}:${failedStep.prompt}`,
											).toString(16)
										: undefined,
								});
								this.writeStderr(
									`Feedback ${feedback.id} saved. Plan: md evolve plan ${localFilePath}`,
								);
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
						const { showPostRunMenu, executePostRunAction } = await import(
							"./post-run-menu"
						);
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
									this.writeStderr(
										`Feedback ${feedback.id} saved. Plan: md evolve plan ${localFilePath}`,
									);
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

			getLogger().info(
				{
					exitCode: workflowResult.exitCode,
					workflowSteps: workflowResult.stepOrder.length,
					resume: parsed.resume,
				},
				"Workflow session ended",
			);
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
				localFilePath,
			);
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
			getCommandLogger().debug(
				{ originalLength: finalBody.length, editedLength: promptToRun.length },
				"Prompt edited",
			);
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
		const shouldShowMenu =
			!interactiveMode &&
			this.isStdinTTY &&
			this.isStdoutTTY &&
			!parsed.noMenu &&
			!parsed.jsonMode;
		const structuredOutputConfig = this.getStructuredOutputConfig(frontmatter);
		// Terminal UIs own stdio; one-shot commands may be captured for menus/output.
		const captureMode = interactiveMode
			? false
			: parsed.jsonMode
				? ("capture" as const)
				: shouldShowMenu
					? ("tee" as const)
					: structuredOutputConfig
						? ("capture" as const)
						: false;

		// Auto-heal retry loop
		let currentPrompt = promptToRun;
		let runResult: Awaited<ReturnType<typeof runCommand>>;
		let retryCount = 0;

		const commandStartedAt = Date.now();
		while (true) {
			getCommandLogger().info(
				{
					command,
					argsCount: finalRunArgs.length,
					promptLength: currentPrompt.length,
					retryCount,
				},
				"Executing command",
			);

			// Start spinner with command preview (will be stopped when first output arrives)
			if (!parsed.jsonMode && !interactiveMode) {
				const preview = formatCommandPreview(command, finalRunArgs);
				const { startSpinner } = await import("./spinner");
				startSpinner(preview);
			}

			runResult = await this.executeCommand(
				{
					command,
					args: finalRunArgs,
					// A positional argument seeds and immediately submits the first turn in
					// interactive agent CLIs. Leave it out when the rendered flow body is
					// blank so the configured TUI opens and waits for the user's prompt.
					positionals: promptPositionals(currentPrompt, interactiveMode),
					positionalMappings,
					captureOutput: captureMode,
					captureStderr:
						!interactiveMode && (shouldShowMenu || parsed.jsonMode), // TUI engines own terminal stderr
					interactive: interactiveMode,
					env: extractEnvVars(frontmatter),
					rawOutput: parsed.rawOutput,
					allowNested: parsed.allowNested,
					isolated,
					flowPath,
					cwd: commandCwd,
				},
				frontmatter, parsed,
			);

			getCommandLogger().info(
				{ exitCode: runResult.exitCode, retryCount },
				"Command completed",
			);

			// If command succeeded or we're not in interactive mode, break out of loop
			if (runResult.exitCode === 0 || !shouldShowMenu) {
				break;
			}

			// Command failed in interactive mode - show failure menu
			try {
				const { showFailureMenu, buildFixPrompt } = await import(
					"./failure-menu"
				);
				const menuResult = await showFailureMenu(
					runResult.exitCode,
					runResult.stderr,
					runResult.stdout,
				);

				if (menuResult.action === "quit") {
					// Exit with the original error code
					break;
				} else if (menuResult.action === "retry") {
					// Retry with the same prompt
					retryCount++;
					getCommandLogger().info({ retryCount }, "Retrying command");
				} else if (menuResult.action === "fix") {
					// Build a new prompt with error context
					currentPrompt = buildFixPrompt(
						promptToRun, // Use original prompt, not accumulated errors
						runResult.stderr,
						runResult.stdout,
						runResult.exitCode,
					);
					retryCount++;
					getCommandLogger().info(
						{ retryCount, fixMode: true },
						"Retrying with AI fix",
					);
				} else if (menuResult.action === "report") {
					const message = await this.promptInput(
						"What should this flow have done instead?",
					);
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
						this.writeStderr(
							`Feedback ${feedback.id} saved. Plan: md evolve plan ${localFilePath}`,
						);
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
			outputBytes: this.calculateOutputBytes(
				runResult.stdout,
				runResult.stderr,
			),
			currentState: "command_completed",
		});

		// Record usage for frecency tracking (skip for failed runs, lazy-load history)
		let usageSignal: {
			quickRerun: boolean;
			msSincePrevious: number | null;
		} | null = null;
		if (runResult.exitCode === 0) {
			if (structuredOutputConfig) {
				const structuredOutputCwd =
					parsed.cwdFromCli ??
					(frontmatter._cwd as string | undefined) ??
					this.cwd;
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
				.then((recordUsage) => recordUsage(localFilePath))
				.catch(() => null);

			// Proposal-first evolution policy. Quick reruns remain low-confidence
			// observations; paid proposal work requires actionable evidence and an
			// exact current receipt, prints its bound, and never auto-applies.
			if (
				!parsed.noEvolve &&
				!parsed.jsonMode &&
				!isRemote &&
				existsSync(localFilePath)
			) {
				const { handleAutoEvolve } = await import("./evolve");
				await handleAutoEvolve(
					resolve(localFilePath),
					usageSignal ?? { quickRerun: false, msSincePrevious: null },
					(line) => this.writeStderr(line),
				);
			}

			// Save prompted variable values to history for future runs (fire and forget)
			const promptedVars = (templateVars as Record<string, unknown>)[
				"__promptedVars__"
			] as Record<string, string> | undefined;
			const noHistoryFlag = (templateVars as Record<string, unknown>)[
				"__noHistory__"
			] as boolean | undefined;
			const resolvedPath = (templateVars as Record<string, unknown>)[
				"__resolvedFilePath__"
			] as string | undefined;

			if (
				promptedVars &&
				Object.keys(promptedVars).length > 0 &&
				!noHistoryFlag &&
				resolvedPath
			) {
				getSaveVariableValuesFn()
					.then((saveVars) => saveVars(resolvedPath, promptedVars))
					.catch(() => {}); // Fire and forget
			}
		}

		if (isRemote) await cleanupRemoteFile(localFilePath);

		if (runResult.exitCode !== 0) {
			this.printErrorWithLogPath(
				`Agent exited with code ${runResult.exitCode}`,
				logPath,
			);
		}

		// Show post-run action menu if enabled and we have output (only on success)
		if (shouldShowMenu && runResult.stdout && runResult.exitCode === 0) {
			try {
				const { showPostRunMenu, executePostRunAction } = await import(
					"./post-run-menu"
				);
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
							this.writeStderr(
								`Feedback ${feedback.id} saved. Plan: md evolve plan ${localFilePath}`,
							);
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

		getLogger().info(
			{ exitCode: runResult.exitCode, retryCount },
			"Session ended",
		);
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
		setLogPath: (lp: string | null) => void,
	): Promise<CliRunResult> {
		const [{ createRunEventEmitter }, { flowIdForPath }, { mdflowVersion }] =
			await Promise.all([
				import("./run-events"),
				import("./roster"),
				import("./compat"),
			]);

		const emitter = createRunEventEmitter();
		const startedAt = Date.now();
		const pm = getProcessManager();
		const cancelled = (): CliRunResult => {
			emitter.emit("run.cancelled", { signal: String(pm.signal.reason), durationMs: Date.now() - startedAt });
			return { exitCode: 0 };
		};

		// stdout purity: anything that would render for a human goes to stderr.
		const originalLog = console.log;
		console.log = (...args: unknown[]) => {
			console.error(...args);
		};

		const fail = (
			message: string,
			exitCode: number | null = null,
		): CliRunResult => {
			emitter.emit("run.error", {
				exitCode,
				message,
				durationMs: Date.now() - startedAt,
			});
			return { exitCode: exitCode ?? 1 };
		};

		emitter.emit("protocol", { mdflowVersion: mdflowVersion() });

		try {
			const parsed = this.parseFlags(passthroughArgs);
			if (parsed.dryRun || parsed.contextOnly || parsed.editFlag || parsed.jsonMode) {
				return fail("--events describes an execution; use dry-run, context, edit or --json separately", 1);
			}
			parsed.jsonMode = true; // never prompt in an event stream
			const localFilePath = await this.resolveFilePath(filePath);
			if (!(await this.env.fs.exists(localFilePath))) {
				return fail(this.fileNotFoundMessage(filePath, localFilePath));
			}

			pm.initialize();

			const fileDir = dirname(resolve(localFilePath));
			if (!isRegistryPath(localFilePath)) await loadEnvFiles(fileDir);

			const logger = initLogger(localFilePath);
			const logPath = getCurrentLogPath();
			setLogPath(logPath);
			logger.info(
				{ filePath: localFilePath, events: true },
				"Event-stream session started",
			);

			const content = await readFlowSource(localFilePath, this.env.fs);
			const { frontmatter: baseFrontmatter, body: rawBody } =
				parseFrontmatter(content);

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
			const resolvedEngine = resolveEngine(
				localFilePath,
				baseFrontmatter as AgentFrontmatter,
				{
					configEngine: fullConfig.engine,
				},
			);
			if (isDocument(localFilePath, baseFrontmatter, parsed.commandFromCli ? "cli" : resolvedEngine.source)) {
				return fail(
					`not a flow: ${localFilePath} is a document (no frontmatter or engine marker)`,
				);
			}

			const {
				command,
				frontmatter,
				templateVars,
				finalBody,
				args,
				positionalMappings,
				isolated,
				commandCwd,
				flowPath,
			} = await this.processAgent(
				localFilePath,
				baseFrontmatter,
				rawBody,
				() => this.readStdinOnce(),
				parsed,
				undefined,
				isRegistryPath(localFilePath),
			);

			const flowId = flowIdForPath(resolve(localFilePath), { cwd: this.cwd });
			const effectiveCwd = resolve(
				parsed.cwdFromCli ??
					(frontmatter._cwd as string | undefined) ??
					this.cwd,
			);

			let finalRunArgs = args;
			if (frontmatter._subcommand) {
				const subs = Array.isArray(frontmatter._subcommand)
					? frontmatter._subcommand.map(String)
					: [String(frontmatter._subcommand)];
				finalRunArgs = [...subs, ...args];
			}

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
					Object.entries(templateVars).filter(([key]) => !key.startsWith("__")),
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
					flowIdentity: workflowIdentity(flowPath, isolated, rawBody, frontmatter),
					onStepStart: (step) => {
						emitter.emit("step.started", {
							stepId: step.id,
							needs: step.needs ?? [],
						});
					},
					onStepComplete: (result) => {
						emitter.emit("step.completed", {
							stepId: result.id,
							exitCode: result.exitCode,
							cached: result.fromCache,
						});
					},
					runCommandFn: (ctx) =>
						this.executeCommand({
							...ctx,
							captureOutput: "stream",
							onOutput: emitDelta,
							isolated,
							flowPath,
							cwd: ctx.cwd ?? commandCwd,
						}, frontmatter, parsed),
				});

				if (pm.isAborted) return cancelled();
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
				logger.info(
					{ exitCode: workflowResult.exitCode, events: true },
					"Event-stream workflow ended",
				);
				return { exitCode: workflowResult.exitCode, logPath };
			}

			const positionals = promptPositionals(finalBody, false);
			const runResult = await this.executeCommand({
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
						args: this.buildSpawnArgs(
							finalRunArgs,
							positionals,
							positionalMappings,
						),
						cwd: effectiveCwd,
						pid,
					});
				},
				onOutput: emitDelta,
				isolated,
				flowPath,
				cwd: commandCwd,
			}, frontmatter, parsed);

			if (pm.isAborted) return cancelled();
			const output = this.getStructuredOutputConfig(frontmatter);
			if (runResult.exitCode === 0 && output) {
				await this.processStructuredOutput({ stdout: runResult.stdout, output, baseDir: fileDir, sinkCwd: effectiveCwd, source: localFilePath });
			}
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
			logger.info(
				{ exitCode: runResult.exitCode, events: true },
				"Event-stream session ended",
			);
			return { exitCode: runResult.exitCode, logPath };
		} catch (err) {
			if (pm.isAborted) return cancelled();
			if (err instanceof EarlyExitRequest) {
				return fail("run ended before the engine started", null);
			}
			const message = err instanceof Error ? err.message : String(err);
			return fail(message, err instanceof MarkdownAgentError ? err.code : null);
		} finally {
			console.log = originalLog;
		}
	}

	private getStructuredOutputConfig(
		frontmatter: AgentFrontmatter,
	): StructuredOutputConfig | undefined {
		if (!Object.hasOwn(frontmatter, "_output")) {
			return undefined;
		}

		const output = frontmatter._output;
		if (output === undefined || output === null) {
			return undefined;
		}

		if (typeof output !== "object" || Array.isArray(output)) {
			throw new ConfigurationError(
				"_output must be a mapping/object when provided",
				1,
			);
		}

		return output;
	}

	private async processStructuredOutput(params: {
		stdout: string; output: StructuredOutputConfig; baseDir: string; sinkCwd: string; source: string;
	}): Promise<void> {
		try {
			const { processStructuredOutput } = await import("./output");
			await processStructuredOutput({ ...params, cwd: params.sinkCwd, suppressDefaultStdoutSink: true });
		} catch (cause) {
			throw new ConfigurationError(`Structured output processing failed: ${cause instanceof Error ? cause.message : String(cause)}`, 1);
		}
	}

	private parseFlags(passthroughArgs: string[]) {
		let remainingArgs = [...passthroughArgs];
		let commandFromCli: string | undefined;
		let dryRun = false,
			trustFlag = false,
			interactiveFromCli = false,
			noCache = false,
			rawOutput = false,
			editFlag = false;
		let contextOnly = false,
			quiet = false,
			noMenu = false,
			allowNested = false,
			noHistory = false,
			noEvolve = false,
			resume = false;
		let jsonMode = false;
		let cwdFromCli: string | undefined;
		let isolatedFromCli: boolean | undefined;
		let systemPromptFromCli: string | undefined;
		let hooksFromCli: string | undefined;
		const appendSystemPromptFromCli: string[] = [];

		// Extract EVERY value-taking flag robustly (chaos round 6): support
		// both `--flag value` and `--flag=value`, remove ALL occurrences (a
		// duplicate used to leak the second into the engine's own argv), and
		// error on a missing/flag-like value instead of leaking the bare flag.
		// Returns the collected values in order (first-wins is the caller's job).
		const takeValueFlag = (
			aliases: string[],
			label: string,
			example: string,
		): string[] => {
			const values: string[] = [];
			for (let i = remainingArgs.length - 1; i >= 0; i--) {
				const arg = remainingArgs[i]!;
				const eqAlias = aliases.find((a) => arg.startsWith(`${a}=`));
				if (eqAlias) {
					values.unshift(arg.slice(eqAlias.length + 1));
					remainingArgs.splice(i, 1);
					continue;
				}
				if (aliases.includes(arg)) {
					const value = remainingArgs[i + 1];
					if (value === undefined || value.startsWith("-")) {
						throw new ConfigurationError(
							`${label} requires a value (e.g. ${example}). ` +
								`Got ${value === undefined ? "no value" : `"${value}"`}.`,
							1,
						);
					}
					values.unshift(value);
					remainingArgs.splice(i, 2);
				}
			}
			return values;
		};
		// --engine is the v3 flag; --_command/-_c and --tool are deprecated aliases.
		const engineValues = [
			...takeValueFlag(["--engine"], "--engine", "--engine claude"),
			...takeValueFlag(["--_command", "-_c"], "--_command", "--_command claude"),
			...takeValueFlag(["--tool"], "--tool", "--tool claude"),
		];
		if (engineValues.length > 0) commandFromCli = engineValues[0];
		dryRun = remainingArgs.some(
			(arg) => arg === "--_dry-run" || arg === "--dry-run",
		);
		if (dryRun) {
			remainingArgs = remainingArgs.filter(
				(arg) => arg !== "--_dry-run" && arg !== "--dry-run",
			);
		}
		const editIdx = remainingArgs.indexOf("--_edit");
		if (editIdx !== -1) {
			editFlag = true;
			remainingArgs.splice(editIdx, 1);
		}
		const trustIdx = remainingArgs.indexOf("--_trust");
		if (trustIdx !== -1) {
			trustFlag = true;
			remainingArgs.splice(trustIdx, 1);
		}
		const noCacheIdx = remainingArgs.indexOf("--_no-cache");
		if (noCacheIdx !== -1) {
			noCache = true;
			remainingArgs.splice(noCacheIdx, 1);
		}
		const noMenuIdx = remainingArgs.indexOf("--_no-menu");
		if (noMenuIdx !== -1) {
			noMenu = true;
			remainingArgs.splice(noMenuIdx, 1);
		}
		// Deliberate nested-run override. This is a CLI-only consent: flow
		// frontmatter (_env) must never be able to grant it, so it is consumed
		// here and never derived from the environment or the flow file.
		const allowNestedIdx = remainingArgs.indexOf("--_allow-nested");
		if (allowNestedIdx !== -1) {
			allowNested = true;
			remainingArgs.splice(allowNestedIdx, 1);
		}
		// Strip EVERY --json, not just the first: a duplicate used to leak the
		// second occurrence into the engine's argv (chaos round 6).
		if (remainingArgs.includes("--json")) {
			jsonMode = true;
			remainingArgs = remainingArgs.filter((a) => a !== "--json");
		}
		// --_no-history flag: skip loading/saving variable history
		const noHistoryIdx = remainingArgs.indexOf("--_no-history");
		if (noHistoryIdx !== -1) {
			noHistory = true;
			remainingArgs.splice(noHistoryIdx, 1);
		}
		const noEvolveIdx = remainingArgs.findIndex(
			(arg) => arg === "--no-evolve" || arg === "--_no-evolve",
		);
		if (noEvolveIdx !== -1) {
			noEvolve = true;
			remainingArgs.splice(noEvolveIdx, 1);
		}
		const resumeIdx = remainingArgs.indexOf("--_resume");
		if (resumeIdx !== -1) {
			resume = true;
			remainingArgs.splice(resumeIdx, 1);
		}
		const intIdx = remainingArgs.findIndex(
			(a) => a === "--_interactive" || a === "-_i",
		);
		if (intIdx !== -1) {
			interactiveFromCli = true;
			remainingArgs.splice(intIdx, 1);
		}
		const cwdValues = takeValueFlag(["--_cwd"], "--_cwd", "--_cwd ./src");
		if (cwdValues.length > 0) cwdFromCli = cwdValues[0];
		// --raw flag: output raw markdown without rendering (for piping)
		const rawIdx = remainingArgs.indexOf("--raw");
		if (rawIdx !== -1) {
			rawOutput = true;
			remainingArgs.splice(rawIdx, 1);
		}
		// Context dashboard flags
		const contextIdx = remainingArgs.indexOf("--_context");
		if (contextIdx !== -1) {
			contextOnly = true;
			remainingArgs.splice(contextIdx, 1);
		}
		const quietIdx = remainingArgs.indexOf("--_quiet");
		if (quietIdx !== -1) {
			quiet = true;
			remainingArgs.splice(quietIdx, 1);
		}
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
		const sysPromptValues = takeValueFlag(
			["--_system-prompt"],
			"--_system-prompt",
			'--_system-prompt "be brief"',
		);
		if (sysPromptValues.length > 0) systemPromptFromCli = sysPromptValues[0];
		// --_append-system-prompt is repeatable — keep every value, in order.
		appendSystemPromptFromCli.push(
			...takeValueFlag(
				["--_append-system-prompt"],
				"--_append-system-prompt",
				'--_append-system-prompt "cite sources"',
			),
		);
		// --_hooks <path|false> — override or disable the flow's hooks file.
		const hooksValues = takeValueFlag(
			["--_hooks"],
			"--_hooks",
			"--_hooks ./my.hooks.ts (or --_hooks false)",
		);
		if (hooksValues.length > 0) hooksFromCli = hooksValues[0];

		return {
			remainingArgs,
			commandFromCli,
			dryRun,
			editFlag,
			trustFlag,
			interactiveFromCli,
			cwdFromCli,
			noCache,
			rawOutput,
			contextOnly,
			quiet,
			noMenu,
			allowNested,
			noHistory,
			noEvolve,
			resume,
			jsonMode,
			isolatedFromCli,
			systemPromptFromCli,
			appendSystemPromptFromCli,
			hooksFromCli,
		};
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
		const {
			remainingArgs,
			commandFromCli,
			interactiveFromCli,
			cwdFromCli,
			noHistory,
			jsonMode,
		} = parsed;
		let remaining = [...remainingArgs];

		// Resolve the engine via the v3 ladder: CLI flag > env > filename >
		// frontmatter > config > built-in default.
		const fullConfig = await loadFullConfig(this.configCwd());
		let command: string;
		let engineSource: EngineSource = "cli";
		if (commandFromCli) {
			command = commandFromCli;
		} else {
			const resolved = resolveEngine(
				localFilePath,
				baseFrontmatter as AgentFrontmatter,
				{
					configEngine: fullConfig.engine,
					// Honor the injected environment (testable; production
					// passes the real process.env) so MDFLOW_ENGINE resolves
					// consistently with the document-rule check above.
					env: this.processEnv,
				},
			);
			command = resolved.engine;
			engineSource = resolved.source;
			if (resolved.deprecatedKey) {
				this.writeStderr(
					`Warning [ENGINE_KEY_DEPRECATED]: frontmatter "${resolved.deprecatedKey}:" is deprecated; use "engine: ${command}".`,
				);
			}
			if (resolved.skippedFilenameEngine) {
				this.writeStderr(
					`Warning [ENGINE_NOT_FOUND]: filename names engine "${resolved.skippedFilenameEngine}" but no such adapter or binary exists — using ${command} (${engineSource}). Rename the file or install the engine if that was intended.`,
				);
			}
		}

		const engineIsImplicit =
			engineSource === "env" ||
			engineSource === "config" ||
			engineSource === "default";

		// A markdown file with no frontmatter and no explicit engine is a
		// document, not a flow — print it instead of executing it. Frontmatter
		// (or a filename/flag engine, or the `.i.` interactive marker) is what
		// marks a file as executable.
		// Compat-only keys (_mdflow_version/_compat) are invisible metadata and
		// don't count: automatic version stamping must never flip a document
		// into an executable flow.
		if (isDocument(localFilePath, baseFrontmatter, engineSource)) {
			// Print the document WITHOUT its (empty or compat-only) frontmatter
			// fences — they are flow plumbing, not document content.
			const documentText = await this.env.fs.readText(localFilePath);
			const { body: documentBody } = parseRawFrontmatter(documentText);
			this.writeStdout(
				documentBody.trim() === "" ? documentText : documentBody,
			);
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
			this.writeStderr(
				`${dim[0]}${basename(localFilePath)} → ${command} (engine: ${engineSource})${dim[1]}`,
			);
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
			if (
				isolation.unsupportedWarning &&
				isolationMode.explicit &&
				!parsed.quiet &&
				!jsonMode
			) {
				const dim = process.stderr.isTTY ? ["\x1b[2m", "\x1b[0m"] : ["", ""];
				this.writeStderr(`${dim[0]}${isolation.unsupportedWarning}${dim[1]}`);
			}
			isolationDefaults = isolation.defaults;
		}

		let frontmatter = isolationMode.isolated
			? applyIsolationDefaults(
					baseFrontmatter as AgentFrontmatter,
					commandDefaults,
					isolationDefaults,
				)
			: applyDefaults(baseFrontmatter as AgentFrontmatter, commandDefaults);
		const interactiveFromFilename = hasInteractiveMarker(localFilePath);
		const interactiveMode =
			!jsonMode &&
			isInteractiveModeEnabled(
				frontmatter,
				interactiveFromFilename || interactiveFromCli,
			);
		frontmatter = applyInteractiveMode(
			frontmatter,
			command,
			interactiveFromFilename || interactiveFromCli,
		);
		const commandCwd = resolve(
			cwdFromCli ?? (frontmatter._cwd as string | undefined) ?? this.cwd,
		);
		if (frontmatter._output && frontmatter._steps !== undefined) throw new ConfigurationError("_output is not supported on a workflow; declare a single output-producing flow instead", 1);
		if (isRemoteFlow && frontmatter._output?.schema) throw new SecurityError("Remote/registry flows cannot load executable _output.schema sidecars. Review a local copy instead.", 1);
		let isolationOwnedHookArgs: string[] = [];

		// Some engines require an environment boundary in addition to CLI flags.
		// Codex is the important case: --ignore-user-config is exec-only and does
		// not suppress hooks.json anyway, so every isolated run (including a
		// hookless interactive flow) must use the prepared, ambient-hook-free home.
		if (
			parsed.dryRun &&
			isolationMode.isolated &&
			engineAdapter.prepareIsolationEnv
		) {
			frontmatter = applyIsolationEnvironment(
				frontmatter,
				engineAdapter,
				{ cwd: commandCwd, interactive: interactiveMode },
			);
		}

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
				engineAdapter,
				command,
				frontmatter,
				systemPromptSpec,
				parsed.dryRun ? () => "<generated system prompt file>" : undefined,
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
			const {
				resolveHooksFile,
				listHandledEvents,
				listHandledEventsStatic,
				applyHooksToFrontmatter,
				formatHooksStderrLine,
			} = await import("./hooks");
			const resolvedHooks = resolveHooksFile({
				flowPath: localFilePath,
				frontmatterValue: frontmatter._hooks,
				cliValue: parsed.hooksFromCli,
				isRemote: isRemoteFlow,
			});
			if (resolvedHooks.kind === "file") {
				if (resolvedHooks.rejected) {
					throw new ConfigurationError(
						`Hooks error: ${resolvedHooks.rejected}`,
						1,
					);
				}
				if (resolvedHooks.missing) {
					throw new ConfigurationError(
						`Hooks file not found: ${resolvedHooks.path} (from ${resolvedHooks.source}). ` +
							`Create it with \`md hooks add ${basename(localFilePath)}\` or remove the _hooks override.`,
						1,
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
				const appliedHooks = applyHooksToFrontmatter(
					engineAdapter,
					command,
					frontmatter,
					{
						hooksFile: resolve(resolvedHooks.path),
						events: listed.events,
						isolated: isolationMode.isolated,
						// Dry runs are passive: show the real env, prepare nothing.
						prepareEnvironment: !parsed.dryRun,
					},
				);
				frontmatter = appliedHooks.frontmatter;
				isolationOwnedHookArgs = appliedHooks.isolationOwnedArgs;
				if (!parsed.quiet && !jsonMode) {
					const dim = process.stderr.isTTY ? ["\x1b[2m", "\x1b[0m"] : ["", ""];
					this.writeStderr(
						`${dim[0]}${formatHooksStderrLine(resolvedHooks.path, listed.events)}${dim[1]}`,
					);
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

		const importEnv = { ...this.processEnv };
		const envVars = extractEnvVars(frontmatter);
		if (envVars)
			Object.entries(envVars).forEach(([k, v]) => {
				if (
					isolationMode.isolated &&
					command === "codex" &&
					(k === "CODEX_HOME" ||
						k === "HOME" ||
						CODEX_ISOLATION_UNSET_ENV.includes(
							k as (typeof CODEX_ISOLATION_UNSET_ENV)[number],
						))
				) {
					return;
				}
				importEnv[k] = v;
			});

		// Template vars - all use _prefix (e.g., _name in frontmatter → {{ _name }} in body)
		const templateVars: Record<string, string> = {};

		// Extract _varname fields from frontmatter and match with --_varname CLI flags
		// Variables starting with _ are template variables (except internal keys)
		const internalKeys = new Set([
			"_interactive",
			"_i",
			"_cwd",
			"_subcommand",
			"_steps",
			"_output",
			"_isolated",
			"_system-prompt",
			"_append-system-prompt",
			"_hooks",
		]);
		const namedVarFields = Object.keys(frontmatter).filter(
			(k) => k.startsWith("_") && !internalKeys.has(k),
		);
		for (const key of namedVarFields) {
			const defaultValue = frontmatter[key];
			// CLI flag matches the full key including underscore: --_name.
			// Support both `--_name value` and `--_name=value`.
			const flag = `--${key}`;
			const eqIdx = remaining.findIndex((a) => a.startsWith(`${flag}=`));
			if (eqIdx !== -1) {
				templateVars[key] = remaining[eqIdx]!.slice(flag.length + 1);
				remaining.splice(eqIdx, 1);
				continue;
			}
			const idx = remaining.findIndex((a) => a === flag);
			const next = idx !== -1 ? remaining[idx + 1] : undefined;
			// Only consume the following token as the value when it isn't
			// itself a flag — otherwise `--_name --engine claude` would eat
			// `--engine` as the name and silently drop engine selection
			// (chaos round 6). A flag-like value must use --_name=-x.
			const flagValue =
				next !== undefined && !next.startsWith("-") ? next : undefined;
			if (flagValue !== undefined) {
				templateVars[key] = flagValue;
				remaining.splice(idx, 2);
			} else {
				// This flag belongs to a DECLARED var: consume the bare token
				// (if present) so the ad-hoc loop below can't re-interpret it
				// as a boolean "true" and clobber the declared default.
				if (idx !== -1) remaining.splice(idx, 1);
				if (defaultValue != null && defaultValue !== "") {
					templateVars[key] = String(defaultValue);
				}
			}
		}

		// Also extract any --_varname CLI flags not declared in frontmatter
		// This allows optional template vars without frontmatter declaration
		// Supports both --_key value and --_key=value syntax
		// Tracked so a var the body never references can be warned about — a
		// typo like --_dry_run (for --_dry-run) otherwise silently RUNS the
		// flow the user asked to preview.
		const adHocCliVars = new Set<string>();
		for (let i = remaining.length - 1; i >= 0; i--) {
			const arg = remaining[i];
			if (!arg) continue;
			// Check for --_key=value syntax
			if (arg.startsWith("--_") && arg.includes("=")) {
				const eqIndex = arg.indexOf("=");
				const key = arg.slice(2, eqIndex); // Remove -- and get key before =
				if (!internalKeys.has(key)) {
					templateVars[key] = arg.slice(eqIndex + 1);
					adHocCliVars.add(key);
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
				adHocCliVars.add(key);
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
			templateVars["_args"] = positionalCliArgs
				.map((arg, i) => `${i + 1}. ${arg}`)
				.join("\n");
		}

		// Legacy `_inputs: [_message]` — named positional arguments consumed
		// from the CLI in declaration order. CLI flags (--_message) win over
		// the positional occupying the same slot.
		if (isLegacyInputs(frontmatter._inputs)) {
			const legacyNames = frontmatter._inputs;
			for (let i = 0; i < legacyNames.length; i++) {
				const name = legacyNames[i];
				if (!name || name in templateVars) continue;
				const value = positionalCliArgs[i];
				if (value !== undefined) templateVars[name] = value;
			}
		}
		// Update remaining to only contain flag args (positionals consumed for templates)
		remaining = flagArgs;

		const fileDir = dirname(resolve(localFilePath));

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
				const missingRequired = getMissingRequiredInputs(
					formInputs,
					templateVars,
				);
				if (missingRequired.length > 0) {
					// Same /dev/tty fallback as plain template variables: a piped
					// run with a human at the terminal gets asked, not failed.
					const tty = jsonMode ? null : await this.openTtyFallback();
					if (tty) {
						try {
							tty.note("Missing required inputs. Please provide values:");
							for (const name of missingRequired) {
								const definition = (
									formInputs as Record<string, InputDefinition | undefined>
								)[name];
								const message = definition?.description || `${name}:`;
								const fallbackDefault =
									definition?.default !== undefined
										? String(definition.default)
										: undefined;
								templateVars[name] = tty.prompt(message, fallbackDefault);
							}
						} finally {
							tty.close();
						}
					} else {
						throw new TemplateError(
							`Missing required form inputs: ${missingRequired.join(", ")}. Provide values via CLI flags (e.g., --${missingRequired[0]} value)`,
						);
					}
				}
			}
		}

		// Check for missing template vars (based on Phase 1 result)
		// This handles both legacy _inputs and template vars not defined in form inputs
		// referencedVars: every var the flow mentions anywhere (body outputs,
		// control flow, and frontmatter values like _env strings) — used to
		// suppress "unused flag" warnings. requiredVars: the subset that must
		// have a value ({{ _v | default: … }} occurrences are optional).
		const referencedVars = [
			...new Set([
				...extractTemplateVars(rawBody),
				...extractTemplateVars(JSON.stringify(frontmatter)),
			]),
		];
		// Workflow steps carry their own prompt templates in `run:` — a var
		// referenced only there must still be collected up front, or the step
		// renders it as empty with no prompt and no error.
		const stepTemplateText = Array.isArray(frontmatter._steps)
			? frontmatter._steps
					.map((step) =>
						step && typeof step === "object" && "run" in step
							? String((step as { run?: unknown }).run ?? "")
							: "",
					)
					.join("\n")
			: "";
		const requiredVars = [
			...new Set([
				...extractRequiredTemplateVars(rawBody),
				...extractRequiredTemplateVars(stepTemplateText),
			]),
		];

		// Surface ad-hoc --_var flags the flow never references — silently
		// accepting them turns flag typos into full (possibly paid) runs.
		if (!parsed.quiet && !jsonMode) {
			for (const warning of unusedCliVarWarnings(
				adHocCliVars,
				referencedVars,
				getInputVariableNames(frontmatter._inputs),
			)) {
				this.writeStderr(warning);
			}
			// Same for positionals: `md flow.md one two` where the flow never
			// reads {{ _1 }}/{{ _args }} silently discarded the arguments.
			if (
				positionalCliArgs.length > 0 &&
				!isLegacyInputs(frontmatter._inputs) &&
				!referencedVars.includes("_args") &&
				!positionalCliArgs.some((_, i) => referencedVars.includes(`_${i + 1}`))
			) {
				this.writeStderr(
					`Warning [UNUSED_POSITIONAL_ARGS]: ${positionalCliArgs.length} positional ` +
						`argument${positionalCliArgs.length === 1 ? "" : "s"} provided, but this flow ` +
						`never uses {{ _1 }} or {{ _args }} — they had no effect.`,
				);
			}
			// And for the body itself: {{ place }} (no underscore) is not an
			// mdflow variable — Liquid renders it as an EMPTY string with no
			// error, so "Hello {{place}}!" silently became "Hello !".
			for (const name of extractForeignTemplateGlobals(rawBody)) {
				this.writeStderr(
					`Warning [UNRESOLVED_TEMPLATE_VAR]: {{ ${name} }} has no value and renders ` +
						`as empty — mdflow variables use an underscore prefix ` +
						`({{ _${name} }}, provided via --_${name}).`,
				);
			}
		}

		// Inject stdin as _stdin only when the expanded template references it.
		// Draining an unreferenced stdin can block forever on a never-closing
		// descriptor (hooks, cron, detached agents). Non-empty input becomes
		// {{ _stdin }}; empty input falls through to the normal missing-variable
		// flow (TTY prompt or TemplateError), same as before.
		if (referencedVars.includes("_stdin") && !("_stdin" in templateVars)) {
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
					const value = await this.promptInputWithHistory(
						`${v}:`,
						previousValue,
					);
					templateVars[v] = value;
					promptedVars[v] = value;
				}
			} else {
				// stdin is piped or drained, but a human may still be at the
				// terminal (`md flow.md | tee`, wrappers that consumed stdin) —
				// ask on /dev/tty before giving up with an error.
				const tty = jsonMode ? null : await this.openTtyFallback();
				if (tty) {
					try {
						tty.note("Missing required variables. Please provide values:");
						for (const v of missingVars) {
							const value = tty.prompt(`${v}:`, variableHistory[v]);
							templateVars[v] = value;
							promptedVars[v] = value;
						}
					} finally {
						tty.close();
					}
				} else {
					throw new TemplateError(
						missingVariablesMessage(localFilePath, missingVars),
					);
				}
			}
		}

		// Store prompted vars for later saving (attached to templateVars for access after execution)
		// We use a symbol-like key to avoid conflicts
		(templateVars as Record<string, unknown>)["__promptedVars__"] =
			promptedVars;
		(templateVars as Record<string, unknown>)["__noHistory__"] = noHistory;
		(templateVars as Record<string, unknown>)["__resolvedFilePath__"] =
			resolvedFilePath;

		let finalBody: string;
		try {
			finalBody = await renderFlowPrompt(rawBody, fileDir, templateVars, { invocationCwd: commandCwd, env: importEnv, policyEnv: this.processEnv }, parsed.dryRun ? "dry-run" : "run");
		} catch (cause) {
			if (cause instanceof ImportError) throw new ImportError(`Import error: ${cause.message}`, { errorCode: cause.errorCode, cause });
			throw cause;
		}

		// An interactive engine UI cannot run without a terminal — spawning
		// it headless produces a confusing engine-side failure (or a hung
		// TUI) after the launch. Fail fast with the remedy instead.
		// MDFLOW_ASSUME_TTY=1 is the explicit override for wrappers (and
		// harness tests) that guarantee a terminal mdflow cannot detect.
		if (
			interactiveMode &&
			!parsed.dryRun &&
			!this.isStdinTTY &&
			this.processEnv.MDFLOW_ASSUME_TTY !== "1"
		) {
			throw new ConfigurationError(
				"Interactive flow requires a terminal (INTERACTIVE_NEEDS_TTY): stdin " +
					"is not a TTY, so the engine's UI cannot run here. Run from a " +
					"terminal, or drop _interactive / the .i. marker for a print-mode run.",
				1,
			);
		}

		// An empty resolved prompt in print mode still spawns the engine,
		// which then fails its own way (copilot: "No prompt provided") AFTER
		// the launch cost — or worse, produces a junk run. Interactive mode
		// legitimately opens the engine's UI without submitting anything, and
		// `_steps` workflows carry per-step prompts instead of a body.
		if (
			!interactiveMode &&
			!parsed.dryRun &&
			!frontmatter._steps &&
			finalBody.trim() === ""
		) {
			throw new ConfigurationError(
				"The resolved prompt is empty (EMPTY_PROMPT): the flow body is blank " +
					"after template and import expansion. Add body content, or run " +
					"interactively (--_interactive) to open the engine's UI instead.",
				1,
			);
		}

		const templateVarSet = new Set(Object.keys(templateVars));
		let args = [
			...buildArgs(frontmatter, templateVarSet, command),
			...remaining,
		];
		if (isolationMode.isolated && engineAdapter.finalizeIsolationArgs) {
			args = engineAdapter.finalizeIsolationArgs(args, {
				interactive: interactiveMode,
				ownedHookArgs: isolationOwnedHookArgs,
			});
		}
		const positionalMappings = extractPositionalMappings(frontmatter);

		return {
			command,
			frontmatter,
			templateVars,
			finalBody,
			args,
			positionalMappings,
			interactiveMode,
			isolated: isolationMode.isolated,
			// In-memory test environments may use virtual paths that cannot be
			// handed to the real OS spawn API. Real flow cwd values exist and
			// are propagated; virtual-only paths retain Bun.spawn's default.
			commandCwd: existsSync(commandCwd) ? commandCwd : undefined,
			// Lets the isolation layer tell a flow that belongs to this project
			// from one merely standing in it. Remote flows keep their own
			// provenance via the registry path check.
			flowPath: resolve(localFilePath),
		};
	}

	private async handleDryRun(
		command: string,
		frontmatter: Record<string, unknown>,
		args: string[],
		positionals: string[],
		positionalMappings: Map<number, string>,
		isRemote: boolean,
		localFilePath: string,
	): Promise<CliRunResult> {
		this.writeStdout(
			"═══════════════════════════════════════════════════════════",
		);
		this.writeStdout("DRY RUN - Command will NOT be executed");
		this.writeStdout(
			"═══════════════════════════════════════════════════════════\n",
		);

		let dryRunArgs = [...args];
		if (frontmatter._subcommand) {
			const subCmd = frontmatter._subcommand;
			const subs = Array.isArray(subCmd)
				? subCmd.map(String)
				: [String(subCmd)];
			dryRunArgs = [...subs, ...dryRunArgs];
		}

		for (let i = 0; i < positionals.length; i++) {
			const pos = i + 1,
				value = positionals[i] ?? "";
			if (positionalMappings.has(pos)) {
				const flagName = positionalMappings.get(pos)!;
				dryRunArgs.push(
					flagName.length === 1 ? `-${flagName}` : `--${flagName}`,
					`"${value.replace(/"/g, '\\"')}"`,
				);
			} else {
				dryRunArgs.push(`"${value.replace(/"/g, '\\"')}"`);
			}
		}

		this.writeStdout("Command:");
		// Mask sensitive argument values in console output
		this.writeStdout(`   ${command} ${maskArgsArray(dryRunArgs).join(" ")}\n`);
		this.writeStdout("Final Prompt:");
		this.writeStdout(
			"───────────────────────────────────────────────────────────",
		);
		this.writeStdout(positionals[0] ?? "");
		this.writeStdout(
			"───────────────────────────────────────────────────────────\n",
		);
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
		localFilePath: string,
	): Promise<CliRunResult> {
		this.writeStdout(
			"═══════════════════════════════════════════════════════════",
		);
		this.writeStdout("DRY RUN - Workflow will NOT be executed");
		this.writeStdout(
			"═══════════════════════════════════════════════════════════\n",
		);
		this.writeStdout("Default command:");
		this.writeStdout(`   ${command} ${maskArgsArray(args).join(" ")}\n`);
		this.writeStdout("Workflow steps:");

		for (const batch of workflow.batches) {
			for (const step of batch) {
				const tool = step.tool ?? command;
				const needs =
					step.needs && step.needs.length > 0
						? ` needs=[${step.needs.join(", ")}]`
						: "";
				this.writeStdout(`  - ${step.id} (tool=${tool}${needs})`);
				this.writeStdout(`    run: ${step.run}`);
			}
		}

		if (isRemote) await cleanupRemoteFile(localFilePath);
		throw new EarlyExitRequest();
	}

	private async handleTOFU(
		filePath: string,
		localFilePath: string,
		command: string,
		baseFrontmatter: Record<string, unknown>,
		rawBody: string,
		jsonMode: boolean,
	): Promise<void> {
		const domain = extractDomain(filePath);
		const trusted = await isDomainTrusted(filePath);

		if (!trusted) {
			if (!this.isStdinTTY || jsonMode) {
				await cleanupRemoteFile(localFilePath);
				throw new SecurityError(
					`Untrusted remote domain: ${domain}. Use --_trust flag to bypass this check in non-interactive mode, or run interactively to add the domain to known_hosts.`,
				);
			}

			const trustResult = await promptForTrust(
				filePath,
				command,
				baseFrontmatter as AgentFrontmatter,
				rawBody,
			);
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
function formatCommandPreview(
	command: string,
	args: string[],
	maxLength = 60,
): string {
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
export function createCliRunner(
	env: SystemEnvironment,
	options?: Partial<Omit<CliRunnerOptions, "env">>,
): CliRunner {
	return new CliRunner({ env, ...options });
}
