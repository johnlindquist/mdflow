import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { relative, resolve } from "node:path";
import { getAdapter, getRegisteredAdapters } from "./adapters";
import { AGENT_CONTRACT_VERSION, type OperationEffect } from "./agent-contract";
import { compatNotice, mdflowVersion, recordedVersion } from "./compat";
import {
	applyDefaults,
	getCommandDefaultsFromConfig,
	listEffectiveConfigFiles,
	loadFullConfigStrict,
} from "./config";
import {
	inspectEvalStatus,
	type EvalStatus,
	type EvalVerdict,
} from "./eval-convention";
import { readEvalLedger, type EvalLedgerEntry } from "./evals";
import {
	canonicalFlowPath,
	capabilityManifest,
	resolveEvolutionPolicy,
} from "./evolution-core";
import {
	listHandledEventsStatic,
	resolveHooksFile,
	type CanonicalHookEvent,
} from "./hooks";
import { parseFrontmatter } from "./parse";
import { isRegistryPath, resolveProjectRoot } from "./project-root";
import {
	inspectAgentGuidance,
	type AgentGuidanceState,
} from "./agent-guidance";
import { inspectRosterReadme, type RosterReadmeState } from "./roster-readme";
import { collectRoster, type FlowSource, type RosterFlow } from "./roster";
import type { AgentFrontmatter, GlobalConfig } from "./types";

export const DOCTOR_PROTOCOL_VERSION = 1 as const;

export type DoctorSeverity = "warning" | "error";
export type DoctorDiagnosticCode =
	| "PROJECT_NOT_INITIALIZED"
	| "CONFIG_INVALID"
	| "FLOW_INVALID"
	| "FLOW_ID_DERIVED"
	| "ENGINE_NOT_INSTALLED"
	| "ISOLATION_UNSUPPORTED"
	| "EVAL_MISSING"
	| "EVAL_DRAFT"
	| "EVAL_UNINSPECTABLE"
	| "EVAL_UNVERIFIED"
	| "EVAL_STALE"
	| "EVAL_FLAKY"
	| "EVAL_FAILING"
	| "HOOKS_INVALID"
	| "HOOKS_UNSUPPORTED"
	| "REGISTRY_SIDECAR_UNTRUSTED"
	| "ROSTER_README_MISSING"
	| "ROSTER_README_STALE"
	| "ROSTER_MARKERS_INVALID"
	| "AGENT_GUIDANCE_STALE"
	| "AGENT_GUIDANCE_INVALID"
	| "COMPAT_OLDER_MAJOR"
	| "COMPAT_NEWER_MAJOR"
	| "LEDGER_INVALID";

export interface DoctorAction {
	/** Authoritative argv; callers must not parse or shell-evaluate command. */
	argv: string[];
	/** Shell-escaped display form only. */
	command: string;
	effect: OperationEffect;
	requiresConsent: boolean;
}

export interface DoctorDiagnostic {
	code: DoctorDiagnosticCode;
	severity: DoctorSeverity;
	path?: string;
	message: string;
	action?: DoctorAction;
}

export interface DoctorFlowReport {
	/** Embedded stable identity when present; filename-derived roster id otherwise. */
	id: string;
	rosterId: string;
	path: string;
	source: FlowSource;
	description: string | null;
	engine: { name: string; source: string; installed: boolean };
	isolation: { supported: boolean };
	capabilities: string[];
	hooks: {
		state:
			| "none"
			| "disabled"
			| "ready"
			| "invalid"
			| "unsupported"
			| "rejected";
		path?: string;
		events: CanonicalHookEvent[];
	};
	eval: Pick<
		EvalStatus,
		| "suitePath"
		| "exists"
		| "inspectable"
		| "draft"
		| "cases"
		| "plannedInvocations"
		| "verdict"
		| "reason"
		| "current"
	>;
	compatibility: {
		state: "unknown" | "same-major" | "older-major" | "newer-major";
		recorded?: string;
	};
}

export interface DoctorReport {
	type: "mdflow.doctor";
	protocolVersion: typeof DOCTOR_PROTOCOL_VERSION;
	contractVersion: typeof AGENT_CONTRACT_VERSION;
	mdflowVersion: string;
	effect: "FREE";
	project: {
		root: string;
		rootSource: string;
		configFiles: string[];
		defaultEngine: { name: string; installed: boolean };
		rosterReadme: { path: string; state: RosterReadmeState };
		agentGuidance: Array<{ file: string; state: AgentGuidanceState }>;
	};
	engines: { registered: string[]; installed: string[] };
	summary: {
		flows: number;
		structuralErrors: number;
		eval: Record<Lowercase<EvalVerdict>, number>;
	};
	flows: DoctorFlowReport[];
	diagnostics: DoctorDiagnostic[];
	nextActions: Array<DoctorAction & { id: string; reason: string }>;
	executionBoundary: string;
}

export interface DoctorOptions {
	cwd?: string;
	homeDir?: string;
	which?: (engine: string) => string | null;
}

function posixRelative(root: string, path: string): string {
	const value = relative(root, path).replaceAll("\\", "/");
	return value || ".";
}

function shellDisplay(argv: readonly string[]): string {
	return argv
		.map((value) =>
			/^[A-Za-z0-9_./:@=-]+$/.test(value)
				? value
				: `'${value.replaceAll("'", `'"'"'`)}'`,
		)
		.join(" ");
}

function action(
	argv: string[],
	effect: OperationEffect = "FREE",
): DoctorAction {
	return {
		argv,
		command: shellDisplay(argv),
		effect,
		requiresConsent: effect !== "FREE",
	};
}

function evalCode(status: EvalStatus): DoctorDiagnosticCode | null {
	if (!status.exists) return "EVAL_MISSING";
	if (!status.inspectable) return "EVAL_UNINSPECTABLE";
	if (status.draft) return "EVAL_DRAFT";
	if (status.verdict === "Unverified") return "EVAL_UNVERIFIED";
	if (status.verdict === "Stale") return "EVAL_STALE";
	if (status.verdict === "Flaky") return "EVAL_FLAKY";
	if (status.verdict === "Failing") return "EVAL_FAILING";
	return null;
}

function compatibility(
	frontmatter: Record<string, unknown>,
	current: string,
): DoctorFlowReport["compatibility"] {
	const notice = compatNotice(frontmatter, current);
	const version = recordedVersion(frontmatter);
	const recorded = version
		? `${version.major}.${version.minor}.${version.patch}`
		: undefined;
	if (!notice)
		return {
			state: recorded ? "same-major" : "unknown",
			...(recorded ? { recorded } : {}),
		};
	return {
		state: notice.includes("expects mdflow") ? "newer-major" : "older-major",
		...(recorded ? { recorded } : {}),
	};
}

function staticLedgerEntry(
	suitePath: string,
	frontmatter: AgentFrontmatter,
	ledger: Record<string, EvalLedgerEntry>,
): EvalLedgerEntry | null {
	const embeddedId =
		typeof frontmatter._flow_id === "string" ? frontmatter._flow_id : undefined;
	if (embeddedId && ledger[`flow:${embeddedId}`])
		return ledger[`flow:${embeddedId}`] ?? null;
	const canonical = canonicalFlowPath(suitePath);
	return ledger[canonical] ?? ledger[resolve(suitePath)] ?? null;
}

interface InspectFlowOptions {
	flow: RosterFlow;
	root: string;
	installed: Set<string>;
	diagnostics: DoctorDiagnostic[];
	currentVersion: string;
	config: GlobalConfig;
	ledger: Record<string, EvalLedgerEntry>;
}

async function inspectFlow(
	options: InspectFlowOptions,
): Promise<DoctorFlowReport> {
	const { flow, root, installed, diagnostics, currentVersion, config, ledger } =
		options;
	const source = readFileSync(flow.path, "utf8");
	const frontmatter = parseFrontmatter(source).frontmatter as AgentFrontmatter;
	const displayPath = posixRelative(root, flow.path);
	if (!frontmatter._flow_id) {
		diagnostics.push({
			code: "FLOW_ID_DERIVED",
			severity: "warning",
			path: displayPath,
			message:
				"Flow has no embedded stable identity; diagnostics derived its filename identity.",
		});
	}
	if (!installed.has(flow.engine)) {
		diagnostics.push({
			code: "ENGINE_NOT_INSTALLED",
			severity: "error",
			path: displayPath,
			message: `Resolved engine ${flow.engine} is not installed on PATH.`,
			action: action(["md", "explain", displayPath, "--json"]),
		});
	}
	const adapter = getAdapter(flow.engine);
	if (!adapter.getIsolationDefaults) {
		diagnostics.push({
			code: "ISOLATION_UNSUPPORTED",
			severity: "warning",
			path: displayPath,
			message: `${flow.engine} has no verified ambient-context isolation controls.`,
		});
	}

	const policyRepetitions = resolveEvolutionPolicy(
		frontmatter.evolve ?? config.evolve,
	).repetitions;
	const suitePath = flow.path.replace(/\.md$/i, ".eval.ts");
	const evalStatus = await inspectEvalStatus(flow.path, {
		ledger,
		entry: staticLedgerEntry(suitePath, frontmatter, ledger),
		policyRepetitions,
	});
	const code = evalCode(evalStatus);
	if (code) {
		const evalAction =
			code === "EVAL_MISSING"
				? action(["md", "eval", "add", displayPath], "LOCAL_WRITE")
				: action(["md", "eval", displayPath, "--plan"]);
		diagnostics.push({
			code,
			severity: "warning",
			path: displayPath,
			message: evalStatus.reason,
			action: evalAction,
		});
	}

	const effectiveFrontmatter = applyDefaults(
		frontmatter,
		getCommandDefaultsFromConfig(config, flow.engine),
	);
	const hooksResolution = resolveHooksFile({
		flowPath: flow.path,
		frontmatterValue: effectiveFrontmatter._hooks,
		isRemote: flow.source === "registry" || isRegistryPath(flow.path),
	});
	let hooks: DoctorFlowReport["hooks"] = {
		state: hooksResolution.kind === "disabled" ? "disabled" : "none",
		events: [],
	};
	if (hooksResolution.kind === "file") {
		hooks = {
			state: "invalid",
			path: posixRelative(root, hooksResolution.path),
			events: [],
		};
		if (hooksResolution.rejected) {
			hooks.state = "rejected";
			diagnostics.push({
				code: "REGISTRY_SIDECAR_UNTRUSTED",
				severity: "error",
				path: displayPath,
				message: hooksResolution.rejected,
			});
		} else if (hooksResolution.missing) {
			diagnostics.push({
				code: "HOOKS_INVALID",
				severity: "error",
				path: displayPath,
				message: `Configured hooks file is missing: ${hooks.path}`,
			});
		} else {
			const handled = listHandledEventsStatic(hooksResolution.path);
			if (!handled.ok) {
				diagnostics.push({
					code: "HOOKS_INVALID",
					severity: "error",
					path: displayPath,
					message: handled.error,
				});
			} else if (!adapter.applyHooks) {
				hooks = { ...hooks, state: "unsupported", events: handled.events };
				diagnostics.push({
					code: "HOOKS_UNSUPPORTED",
					severity: "error",
					path: displayPath,
					message: `${flow.engine} has no verified lifecycle-hook integration.`,
				});
			} else {
				hooks = { ...hooks, state: "ready", events: handled.events };
			}
		}
	}

	const frontmatterRecord = frontmatter as Record<string, unknown>;
	const compat = compatibility(frontmatterRecord, currentVersion);
	const notice = compatNotice(frontmatterRecord, currentVersion);
	if (
		(compat.state === "older-major" || compat.state === "newer-major") &&
		notice
	) {
		diagnostics.push({
			code:
				compat.state === "older-major"
					? "COMPAT_OLDER_MAJOR"
					: "COMPAT_NEWER_MAJOR",
			severity: "warning",
			path: displayPath,
			message: notice,
		});
	}

	return {
		id:
			typeof frontmatter._flow_id === "string" ? frontmatter._flow_id : flow.id,
		rosterId: flow.id,
		path: displayPath,
		source: flow.source,
		description: flow.description,
		engine: {
			name: flow.engine,
			source: flow.engineSource,
			installed: installed.has(flow.engine),
		},
		isolation: { supported: Boolean(adapter.getIsolationDefaults) },
		capabilities: capabilityManifest(source).entries,
		hooks,
		eval: {
			suitePath: posixRelative(root, evalStatus.suitePath),
			exists: evalStatus.exists,
			inspectable: evalStatus.inspectable,
			draft: evalStatus.draft,
			cases: evalStatus.cases,
			plannedInvocations: evalStatus.plannedInvocations,
			verdict: evalStatus.verdict,
			reason: evalStatus.reason,
			current: evalStatus.current,
		},
		compatibility: compat,
	};
}

export async function collectDoctorReport(
	options: DoctorOptions = {},
): Promise<DoctorReport> {
	const cwd = resolve(options.cwd ?? process.cwd());
	const homeDir = options.homeDir ?? homedir();
	const which = options.which ?? ((engine: string) => Bun.which(engine));
	const rootResolution = resolveProjectRoot(cwd);
	const root = rootResolution.projectRoot;
	const diagnostics: DoctorDiagnostic[] = [];
	const registered = [...getRegisteredAdapters()].sort((a, b) =>
		a.localeCompare(b),
	);
	const installed = new Set(
		registered.filter((engine) => Boolean(which(engine))),
	);
	let configEngine = "pi";
	let config = {} as GlobalConfig;
	const effectiveConfigFiles = listEffectiveConfigFiles(root);
	const configFiles = effectiveConfigFiles.map((file) =>
		posixRelative(root, file.path),
	);
	try {
		config = await loadFullConfigStrict(root);
		if (typeof config.engine === "string") configEngine = config.engine;
	} catch (error) {
		diagnostics.push({
			code: "CONFIG_INVALID",
			severity: "error",
			message: error instanceof Error ? error.message : String(error),
		});
	}

	let ledger: Record<string, EvalLedgerEntry> = {};
	try {
		ledger = readEvalLedger();
	} catch (error) {
		diagnostics.push({
			code: "LEDGER_INVALID",
			severity: "error",
			message: error instanceof Error ? error.message : String(error),
		});
	}

	const roster = await collectRoster({
		cwd: root,
		homeDir,
		sources: ["project"],
		configEngine,
	});
	for (const engine of [
		configEngine,
		...roster.flows.map((flow) => flow.engine),
	]) {
		if (which(engine)) installed.add(engine);
	}
	for (const warning of roster.warnings) {
		diagnostics.push({
			code: "FLOW_INVALID",
			severity: "error",
			message: warning,
		});
	}
	const projectFlows = roster.flows.filter((flow) => flow.source === "project");
	if (projectFlows.length === 0) {
		diagnostics.push({
			code: "PROJECT_NOT_INITIALIZED",
			severity: "warning",
			message: "No project flows were found.",
			action: action(["md", "init", "--yes"], "LOCAL_WRITE"),
		});
	}

	const readme = inspectRosterReadme(root);
	if (projectFlows.length > 0 && readme.state === "missing")
		diagnostics.push({
			code: "ROSTER_README_MISSING",
			severity: "warning",
			path: posixRelative(root, readme.path),
			message: "Managed flow operator card is missing.",
			action: action(["md", "roster", "sync"], "LOCAL_WRITE"),
		});
	if (projectFlows.length > 0 && readme.state === "stale")
		diagnostics.push({
			code: "ROSTER_README_STALE",
			severity: "warning",
			path: posixRelative(root, readme.path),
			message: "Managed flow operator card is stale.",
			action: action(["md", "roster", "sync"], "LOCAL_WRITE"),
		});
	if (readme.state === "invalid")
		diagnostics.push({
			code: "ROSTER_MARKERS_INVALID",
			severity: "error",
			path: posixRelative(root, readme.path),
			message: readme.error ?? "Managed roster markers are invalid.",
		});

	// Agent guidance is opt-in: missing / not-opted-in files are the normal
	// quiet state, so only opted-in files that drifted are diagnosed.
	const agentGuidance = inspectAgentGuidance(root);
	for (const guidance of agentGuidance) {
		if (guidance.state === "stale")
			diagnostics.push({
				code: "AGENT_GUIDANCE_STALE",
				severity: "warning",
				path: posixRelative(root, guidance.path),
				message: `Managed agent guidance block in ${guidance.file} is stale.`,
				action: action(["md", "roster", "sync"], "LOCAL_WRITE"),
			});
		if (guidance.state === "invalid")
			diagnostics.push({
				code: "AGENT_GUIDANCE_INVALID",
				severity: "error",
				path: posixRelative(root, guidance.path),
				message:
					guidance.error ??
					`Managed agent guidance markers in ${guidance.file} are invalid.`,
			});
	}

	const currentVersion = mdflowVersion();
	const flows: DoctorFlowReport[] = [];
	for (const flow of projectFlows) {
		try {
			flows.push(
				await inspectFlow({
					flow,
					root,
					installed,
					diagnostics,
					currentVersion,
					config,
					ledger,
				}),
			);
		} catch (error) {
			diagnostics.push({
				code: "FLOW_INVALID",
				severity: "error",
				path: posixRelative(root, flow.path),
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}
	const evalSummary: Record<Lowercase<EvalVerdict>, number> = {
		verified: 0,
		stale: 0,
		flaky: 0,
		failing: 0,
		unverified: 0,
	};
	for (const flow of flows)
		evalSummary[flow.eval.verdict.toLowerCase() as Lowercase<EvalVerdict>]++;
	const defaultInstalled = installed.has(configEngine);
	const defaultIsUsed = flows.some(
		(flow) =>
			(flow.engine.source === "config" || flow.engine.source === "default") &&
			flow.engine.name === configEngine,
	);
	if (!defaultInstalled && defaultIsUsed) {
		diagnostics.push({
			code: "ENGINE_NOT_INSTALLED",
			severity: "error",
			message: `Project default engine ${configEngine} is not installed on PATH.`,
		});
	}
	diagnostics.sort((a, b) =>
		`${a.path ?? ""}:${a.code}`.localeCompare(`${b.path ?? ""}:${b.code}`),
	);

	const nextActions = diagnostics.flatMap((diagnostic, index) =>
		diagnostic.action
			? [
					{
						id: `diagnostic.${index + 1}`,
						reason: diagnostic.message,
						...diagnostic.action,
					},
				]
			: [],
	);
	const firstFlow = flows[0];
	if (firstFlow && nextActions.length === 0) {
		nextActions.push({
			id: "flow.inspect",
			reason: "Inspect a resolved invocation before a real run.",
			...action(["md", "explain", firstFlow.path, "--json"]),
		});
	}

	return {
		type: "mdflow.doctor",
		protocolVersion: DOCTOR_PROTOCOL_VERSION,
		contractVersion: AGENT_CONTRACT_VERSION,
		mdflowVersion: currentVersion,
		effect: "FREE",
		project: {
			root,
			rootSource: rootResolution.source,
			configFiles,
			defaultEngine: { name: configEngine, installed: defaultInstalled },
			rosterReadme: {
				path: posixRelative(root, readme.path),
				state: readme.state,
			},
			agentGuidance: agentGuidance.map((guidance) => ({
				file: guidance.file,
				state: guidance.state,
			})),
		},
		engines: {
			registered,
			installed: [...installed].sort((a, b) => a.localeCompare(b)),
		},
		summary: {
			flows: flows.length,
			structuralErrors: diagnostics.filter((item) => item.severity === "error")
				.length,
			eval: evalSummary,
		},
		flows,
		diagnostics,
		nextActions,
		executionBoundary:
			"No engines, eval suites, hook programs, inline commands, executable fences, URLs, or context providers were executed; no files were written.",
	};
}

export function renderDoctorText(report: DoctorReport): string {
	const proof =
		Object.entries(report.summary.eval)
			.filter(([, count]) => count > 0)
			.map(([name, count]) => `${count} ${name}`)
			.join(" · ") || "no project flows";
	const lines = [
		`mdflow doctor ${report.mdflowVersion} · contract ${report.contractVersion} · FREE`,
		`Project: ${report.project.root} (root via ${report.project.rootSource})`,
		`Engine: ${report.project.defaultEngine.name} (${report.project.defaultEngine.installed ? "installed" : "missing"})`,
		`Roster: ${report.summary.flows} flows · ${report.project.rosterReadme.path} ${report.project.rosterReadme.state}`,
		`Proof: ${proof}`,
	];
	for (const diagnostic of report.diagnostics) {
		lines.push(
			`${diagnostic.severity === "error" ? "ERROR" : "WARN"} ${diagnostic.code}${diagnostic.path ? ` ${diagnostic.path}` : ""} ${diagnostic.message}`,
		);
		if (diagnostic.action)
			lines.push(
				`  Next [${diagnostic.action.effect}]: ${diagnostic.action.command}`,
			);
	}
	lines.push(report.executionBoundary);
	return `${lines.join("\n")}\n`;
}

export async function runDoctor(
	args: string[],
	options: DoctorOptions = {},
): Promise<number> {
	const json = args.includes("--json");
	const unknown = args.filter((arg) => arg !== "--json");
	if (unknown.length > 0) {
		const message = `Unknown doctor option: ${unknown[0]}`;
		if (json)
			process.stdout.write(
				`${JSON.stringify({ type: "mdflow.doctor", protocolVersion: 1, error: message })}\n`,
			);
		else process.stderr.write(`${message}\n`);
		return 1;
	}
	try {
		const report = await collectDoctorReport(options);
		process.stdout.write(
			json ? `${JSON.stringify(report)}\n` : renderDoctorText(report),
		);
		return report.summary.structuralErrors > 0 ? 1 : 0;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (json) {
			process.stdout.write(
				`${JSON.stringify({
					type: "mdflow.doctor",
					protocolVersion: DOCTOR_PROTOCOL_VERSION,
					contractVersion: AGENT_CONTRACT_VERSION,
					effect: "FREE",
					diagnostics: [{ code: "FLOW_INVALID", severity: "error", message }],
					error: message,
				})}\n`,
			);
		} else {
			process.stderr.write(`Doctor failed: ${message}\n`);
		}
		return 1;
	}
}
