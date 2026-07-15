/**
 * `md roster --json` — machine-facing flow enumeration (Flow UX Protocol v1).
 *
 * Prints a single JSON object describing every runnable flow visible from the
 * invocation cwd: project flows (`<projectRoot>/flows/*.md`), global flows
 * (`~/.mdflow/*.md`), and registry flows (`.mdflow/registry/` at project and
 * user scope). Documents — markdown files with no frontmatter and no engine
 * marker — are excluded, mirroring the runtime document-vs-flow decision in
 * cli-runner. The enumeration itself always exits 0 (unreadable directories
 * become `warnings`); `roster sync` exits 1 when the managed surfaces are
 * stale or invalid.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { parseFrontmatter } from "./parse";
import { resolveEngine, hasInteractiveMarker } from "./command";
import { loadFullConfig, isInteractiveModeEnabled } from "./config";
import { isCompatOnlyFrontmatter } from "./compat";
import { resolveProjectRoot } from "./project-root";
import { inspectAgentGuidance, syncAgentGuidance } from "./agent-guidance";
import { syncRosterReadme } from "./roster-readme";
import type { AgentFrontmatter, FormInputs, InputDefinition } from "./types";

/** Flow UX Protocol version. Bump only with a fallback path on the app side. */
export const FLOW_UX_PROTOCOL_VERSION = 1;

export type FlowSource = "project" | "global" | "registry";

export interface ProtocolInput {
	name: string;
	type: "text" | "select" | "number" | "confirm" | "password";
	message: string | null;
	options?: string[];
	default: string | number | boolean | null;
}

export interface RosterFlow {
	id: string;
	path: string;
	source: FlowSource;
	name: string;
	description: string | null;
	engine: string;
	engineSource: string;
	inputs: ProtocolInput[];
	isWorkflow: boolean;
	interactive: boolean;
	mtimeMs: number;
}

export interface Roster {
	protocolVersion: number;
	cwd: string;
	projectRoot: string | null;
	flows: RosterFlow[];
	warnings: string[];
}

export interface RosterOptions {
	cwd?: string;
	homeDir?: string;
	/** Restrict discovery without letting unrelated user/global state fail a project query. */
	sources?: readonly FlowSource[];
	/** Pre-resolved by strict machine callers to avoid a second noisy config load. */
	configEngine?: string;
}

/**
 * Map a flow's `_inputs` frontmatter (legacy string[] or typed object) to the
 * protocol input shape shared by `md roster --json` and `md explain --json`.
 */
export function mapInputsToProtocol(
	inputs: string[] | FormInputs | undefined | unknown,
): ProtocolInput[] {
	if (!inputs) return [];

	if (Array.isArray(inputs)) {
		return inputs
			.filter((name): name is string => typeof name === "string")
			.map((name) => ({
				name,
				type: "text" as const,
				message: null,
				default: null,
			}));
	}

	if (typeof inputs !== "object") return [];

	return Object.entries(inputs as FormInputs).map(([name, definition]) => {
		const def = (definition ?? {}) as InputDefinition;
		const type = def.type ?? "text";
		const entry: ProtocolInput = {
			name,
			type,
			message: def.description ?? null,
			default: def.default !== undefined ? def.default : null,
		};
		if (type === "select") {
			entry.options = Array.isArray((def as { options?: string[] }).options)
				? (def as { options: string[] }).options
				: [];
		}
		return entry;
	});
}

/**
 * Classify a flow path into its roster source. Used by `md explain --json`
 * to build the stable `<source>:<slug>` flow id for an arbitrary path.
 */
export function classifyFlowPath(
	absolutePath: string,
	opts: { projectRoot: string | null; homeDir?: string },
): FlowSource {
	const homeDir = opts.homeDir ?? homedir();
	const within = (dir: string) => absolutePath.startsWith(dir + sep);

	if (opts.projectRoot && within(join(opts.projectRoot, ".mdflow", "registry")))
		return "registry";
	if (within(join(homeDir, ".mdflow", "registry"))) return "registry";
	if (within(join(homeDir, ".mdflow"))) return "global";
	return "project";
}

/** Stable flow id for a path: `<source>:<filename stem>`. */
export function flowIdForPath(
	absolutePath: string,
	opts: { cwd?: string; homeDir?: string } = {},
): string {
	const cwd = opts.cwd ?? process.cwd();
	let projectRoot: string | null = null;
	try {
		projectRoot = resolveProjectRoot(cwd).projectRoot;
	} catch {
		projectRoot = null;
	}
	const source = classifyFlowPath(absolutePath, {
		projectRoot,
		homeDir: opts.homeDir,
	});
	const stem = absolutePath.split(sep).pop()!.replace(/\.md$/i, "");
	return `${source}:${stem}`;
}

/** True when the engine resolution rung is implicit (env/config/default). */
function isImplicitEngineSource(source: string): boolean {
	return source === "env" || source === "config" || source === "default";
}

/** Collect the roster. Never throws for missing/unreadable directories. */
export async function collectRoster(
	options: RosterOptions = {},
): Promise<Roster> {
	const cwd = options.cwd ?? process.cwd();
	const homeDir = options.homeDir ?? homedir();
	const warnings: string[] = [];

	let projectRoot: string | null = null;
	try {
		projectRoot = resolveProjectRoot(cwd).projectRoot;
	} catch (err) {
		warnings.push(`Project root resolution failed: ${(err as Error).message}`);
	}

	let configEngine = options.configEngine;
	if (configEngine === undefined) {
		try {
			configEngine = (await loadFullConfig(cwd)).engine;
		} catch (err) {
			warnings.push(`Config load failed: ${(err as Error).message}`);
		}
	}

	const flows: RosterFlow[] = [];
	const seenIds = new Set<string>();

	const scanDir = (dir: string, source: FlowSource): void => {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") {
				warnings.push(`Cannot read ${dir}: ${(err as Error).message}`);
			}
			return;
		}

		const fileNames = entries
			.filter((name) => name.toLowerCase().endsWith(".md"))
			// flows/README.md documents the roster; it is not itself executable.
			.filter((name) => name.toLowerCase() !== "readme.md")
			.sort((a, b) => a.localeCompare(b));

		for (const fileName of fileNames) {
			const path = resolve(join(dir, fileName));

			let mtimeMs: number;
			try {
				const stats = statSync(path);
				if (!stats.isFile()) continue;
				mtimeMs = Math.floor(stats.mtimeMs);
			} catch {
				continue;
			}

			let frontmatter: AgentFrontmatter;
			try {
				frontmatter = parseFrontmatter(readFileSync(path, "utf-8")).frontmatter;
			} catch (err) {
				warnings.push(`Skipping ${path}: ${(err as Error).message}`);
				continue;
			}

			let resolved: ReturnType<typeof resolveEngine>;
			try {
				resolved = resolveEngine(path, frontmatter, { configEngine });
			} catch (error) {
				warnings.push(
					`Skipping ${path}: ${error instanceof Error ? error.message : String(error)}`,
				);
				continue;
			}

			// Document rule (mirrors cli-runner): a file with no meaningful
			// frontmatter whose engine only resolved implicitly is not a flow.
			if (
				isImplicitEngineSource(resolved.source) &&
				isCompatOnlyFrontmatter(frontmatter as Record<string, unknown>)
			) {
				continue;
			}

			const name = fileName.replace(/\.md$/i, "");
			const id = `${source}:${name}`;
			if (seenIds.has(id)) {
				warnings.push(`Duplicate flow id ${id}: ${path} is shadowed`);
				continue;
			}
			seenIds.add(id);

			flows.push({
				id,
				path,
				source,
				name,
				description:
					typeof frontmatter.description === "string"
						? frontmatter.description
						: null,
				engine: resolved.engine,
				engineSource: resolved.source,
				inputs: mapInputsToProtocol(frontmatter._inputs),
				isWorkflow: frontmatter._steps !== undefined,
				interactive:
					hasInteractiveMarker(path) || isInteractiveModeEnabled(frontmatter),
				mtimeMs,
			});
		}
	};

	// Ordering contract: project flows first (alphabetical), then global,
	// then registry (project-scope registry before user-scope registry).
	const sources = new Set(options.sources ?? ["project", "global", "registry"]);
	if (projectRoot && sources.has("project"))
		scanDir(join(projectRoot, "flows"), "project");
	if (sources.has("global")) scanDir(join(homeDir, ".mdflow"), "global");
	if (projectRoot && sources.has("registry"))
		scanDir(join(projectRoot, ".mdflow", "registry"), "registry");
	if (sources.has("registry"))
		scanDir(join(homeDir, ".mdflow", "registry"), "registry");

	return {
		protocolVersion: FLOW_UX_PROTOCOL_VERSION,
		cwd,
		projectRoot,
		flows,
		warnings,
	};
}

/**
 * Run the roster subcommand. Enumeration always exits 0 (warnings carry soft
 * failures); `sync` exits 1 when any managed surface is stale or invalid.
 */
export async function runRoster(
	args: string[],
	cwd = process.cwd(),
): Promise<number> {
	if (args[0] === "sync") {
		const json = args.includes("--json");
		const check = args.includes("--check");
		const agents = args.includes("--agents");
		const unknown = args
			.slice(1)
			.filter(
				(arg) => arg !== "--json" && arg !== "--check" && arg !== "--agents",
			);
		if (unknown.length > 0) {
			const message = `Unknown roster sync option: ${unknown[0]}`;
			if (json)
				process.stdout.write(
					`${JSON.stringify({ type: "mdflow.roster-sync", protocolVersion: 1, ok: false, error: message })}\n`,
				);
			else process.stderr.write(`${message}\n`);
			return 1;
		}
		const projectRoot = resolveProjectRoot(cwd).projectRoot;
		if (!projectRoot) {
			const message =
				"No mdflow project root found. Run `md init --yes` first.";
			if (json)
				process.stdout.write(
					`${JSON.stringify({ type: "mdflow.roster-sync", protocolVersion: 1, ok: false, error: message })}\n`,
				);
			else process.stderr.write(`${message}\n`);
			return 1;
		}
		// ONE fail-closed synchronization unit: preflight EVERY managed surface
		// (guidance files and the README) BEFORE the first write. If any
		// surface is invalid, nothing is written to any of them.
		const guidancePreflight = inspectAgentGuidance(projectRoot);
		const guidanceInvalid = guidancePreflight.some(
			(entry) => entry.state === "invalid",
		);
		let result: ReturnType<typeof syncRosterReadme>;
		try {
			result = syncRosterReadme(projectRoot, {
				check: check || guidanceInvalid,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (json)
				process.stdout.write(
					`${JSON.stringify({ type: "mdflow.roster-sync", protocolVersion: 1, effect: check ? "FREE" : "LOCAL_WRITE", ok: false, error: message })}\n`,
				);
			else process.stderr.write(`Roster README sync failed: ${message}\n`);
			return 1;
		}
		// Agent guidance blocks (AGENTS.md / CLAUDE.md). EVERY guidance write
		// requires the explicit --agents opt-in: a marker already present in
		// the repository is data, not the current user's authorization, so
		// plain sync is README-only and merely REPORTS guidance drift. When
		// the README sync itself failed (invalid markers, missing flows/),
		// guidance is inspected but never written either — a partial sync
		// that points agents at a broken roster is worse than no sync.
		const readmeFailed = result.state === "invalid";
		const guidance = syncAgentGuidance(projectRoot, {
			check: check || guidanceInvalid || readmeFailed,
			optIn: agents,
		});
		const guidanceOk =
			!readmeFailed &&
			!guidanceInvalid &&
			guidance.every((entry) =>
				agents
					? entry.state === "current"
					: entry.state !== "stale" && entry.state !== "invalid",
			);

		const ok = result.state === "current" && guidanceOk;
		if (json) {
			process.stdout.write(
				`${JSON.stringify({ type: "mdflow.roster-sync", protocolVersion: 1, effect: check ? "FREE" : "LOCAL_WRITE", ok, path: result.path, state: result.state, changed: result.changed, error: result.error, agents: guidance.map((entry) => ({ file: entry.file, path: entry.path, state: entry.state, changed: entry.changed, error: entry.error })) })}\n`,
			);
			return ok ? 0 : 1;
		}
		if (result.state === "invalid") {
			process.stderr.write(`Roster README is invalid: ${result.error}\n`);
		} else if (check) {
			process.stdout.write(
				result.state === "current"
					? `Roster README is current: ${result.path}\n`
					: `Roster README is stale: ${result.path}\n`,
			);
		} else {
			process.stdout.write(
				result.changed
					? `Updated roster README: ${result.path}\n`
					: `Roster README is current: ${result.path}\n`,
			);
		}
		for (const entry of guidance) {
			if (entry.state === "invalid") {
				process.stderr.write(`Agent guidance is invalid: ${entry.error}\n`);
			} else if (entry.changed) {
				process.stdout.write(`Updated agent guidance: ${entry.path}\n`);
			} else if (entry.state === "stale") {
				process.stdout.write(`Agent guidance is stale: ${entry.path}\n`);
			} else if (entry.state === "current") {
				process.stdout.write(`Agent guidance is current: ${entry.path}\n`);
			} else if (agents && check) {
				process.stdout.write(
					`Agent guidance not written yet (${entry.state}): ${entry.path}\n`,
				);
			}
			// missing / not-opted-in without --agents is the normal quiet state.
		}
		return ok ? 0 : 1;
	}

	const roster = await collectRoster({ cwd });
	process.stdout.write(`${JSON.stringify(roster)}\n`);
	return 0;
}
