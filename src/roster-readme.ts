import {
	chmodSync,
	existsSync,
	lstatSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { resolveEngine } from "./command";
import { ContainmentError, containedWritePath } from "./contained-write";
import { upsertManagedBlock } from "./managed-block";
import { isCompatOnlyFrontmatter } from "./compat";
import { parseFrontmatter } from "./parse";
import type { AgentFrontmatter } from "./types";

export const MANAGED_ROSTER_START = "<!-- mdflow:managed:start contract=1 -->";
export const MANAGED_ROSTER_END = "<!-- mdflow:managed:end -->";

export type RosterReadmeState = "missing" | "current" | "stale" | "invalid";

export interface RosterReadmeInspection {
	path: string;
	state: RosterReadmeState;
	expectedBlock: string;
	error?: string;
}

export interface RosterReadmeSyncResult extends RosterReadmeInspection {
	changed: boolean;
}

interface SourceFlow {
	filename: string;
	description: string;
	engine: string;
	proof: string;
}

function markdownCell(value: string): string {
	return value
		.replaceAll(
			MANAGED_ROSTER_START,
			"&lt;!-- mdflow:managed:start contract=1 --&gt;",
		)
		.replaceAll(MANAGED_ROSTER_END, "&lt;!-- mdflow:managed:end --&gt;")
		.replaceAll("`", "&#96;")
		.replaceAll("|", "\\|")
		.replaceAll("\n", " ")
		.trim();
}

function shellQuote(value: string): string {
	return /^[A-Za-z0-9_./:@=-]+$/.test(value)
		? value
		: `'${value.replaceAll("'", `'"'"'`)}'`;
}

export interface RunnableFlowSource {
	frontmatter: AgentFrontmatter;
	engine: string;
	engineSource: string;
}

/** Shared lightweight document-vs-flow classification for init and roster docs. */
export function inspectRunnableFlowSource(
	path: string,
	source: string,
): RunnableFlowSource | null {
	const frontmatter = parseFrontmatter(source).frontmatter;
	const resolved = resolveEngine(path, frontmatter, { env: {} });
	if (
		(resolved.source === "default" || resolved.source === "config") &&
		isCompatOnlyFrontmatter(frontmatter)
	) {
		return null;
	}
	return {
		frontmatter,
		engine: resolved.engine,
		engineSource: resolved.source,
	};
}

function engineLabel(flow: RunnableFlowSource): string {
	return flow.engineSource === "default"
		? "project default"
		: `${flow.engine} (${flow.engineSource})`;
}

function proofLabel(flowPath: string): string {
	const suitePath = flowPath.replace(/\.md$/i, ".eval.ts");
	if (!existsSync(suitePath)) return "suite missing";
	try {
		const source = readFileSync(suitePath, "utf8");
		if (
			source.includes("MDFLOW_DRAFT_CASE") ||
			/\bdraft\s*:\s*true\b/.test(source)
		)
			return "draft suite";
		return "suite present; inspect with md eval --plan";
	} catch {
		return "suite unreadable";
	}
}

function listSourceFlows(projectRoot: string): SourceFlow[] {
	const flowsDir = join(projectRoot, "flows");
	if (!existsSync(flowsDir)) return [];
	return readdirSync(flowsDir)
		.filter(
			(name) =>
				name.toLowerCase().endsWith(".md") &&
				name.toLowerCase() !== "readme.md",
		)
		.sort((a, b) => a.localeCompare(b))
		.flatMap((filename) => {
			const path = join(flowsDir, filename);
			try {
				if (!statSync(path).isFile()) return [];
				const flow = inspectRunnableFlowSource(
					path,
					readFileSync(path, "utf8"),
				);
				if (!flow) return [];
				return [
					{
						filename,
						description:
							typeof flow.frontmatter.description === "string"
								? flow.frontmatter.description
								: "—",
						engine: engineLabel(flow),
						proof: proofLabel(path),
					},
				];
			} catch {
				return [
					{
						filename,
						description: "invalid flow; run md doctor --json",
						engine: "unknown",
						proof: "uninspectable",
					},
				];
			}
		});
}

export function renderManagedRosterBlock(projectRoot: string): string {
	const rows = listSourceFlows(projectRoot).map(
		(flow) =>
			`| [${markdownCell(flow.filename)}](./${encodeURIComponent(flow.filename)}) | ${markdownCell(flow.description)} | ${markdownCell(flow.engine)} | ${markdownCell(flow.proof)} | \`${markdownCell(`md explain ${shellQuote(`flows/${flow.filename}`)} --json`)}\` |`,
	);
	const table = [
		"| Flow | Description | Engine | Source proof | Inspect |",
		"| --- | --- | --- | --- | --- |",
		...(rows.length > 0
			? rows
			: [
					"| — | No project flows yet | — | — | `md create <intent> --dry-run` |",
				]),
	].join("\n");
	return `${MANAGED_ROSTER_START}
## mdflow operator card

Start every maintenance task with:

\`\`\`bash
md doctor --json
\`\`\`

- Open the Flow Workbench: \`md\`.
- Create another flow: \`md create "describe what it should do"\` (preview first with \`--dry-run\`).
- **FREE**: \`md doctor --json\`, \`md explain <flow.md> --json\`, \`md <flow.md> --_dry-run\`, and \`md eval <flow.md> --plan\`.
- A real flow run, eval run, proposal run, and source mutation require separate consent.
- \`.eval.ts\` and \`.hooks.ts\` sidecars are executable local code; review them.
- Evolution is proposal-first: feedback → plan → propose → show → explicit apply or reject.
- Registry install adds one flow, not trusted eval or hook sidecars.
- Engine context isolation is not a host filesystem, network, process, environment, or credential sandbox.
- A suite's presence is not verification; use \`md eval list <flow.md> --json\` for local receipt state.

${table}
${MANAGED_ROSTER_END}`;
}

const ROSTER_MARKERS = {
	start: MANAGED_ROSTER_START,
	end: MANAGED_ROSTER_END,
} as const;

function desiredSource(
	source: string | null,
	block: string,
): { source?: string; error?: string } {
	const result = upsertManagedBlock(
		source,
		block,
		ROSTER_MARKERS,
		(managed) => `# Flow roster\n\n${managed}\n`,
	);
	if (result.error)
		return { error: `managed roster ${result.error.replace(/^managed /, "")}` };
	return result;
}

export function inspectRosterReadme(
	projectRoot: string,
): RosterReadmeInspection {
	const root = resolve(projectRoot);
	const path = join(root, "flows", "README.md");
	let expectedBlock = "";
	try {
		expectedBlock = renderManagedRosterBlock(root);
		const source = existsSync(path) ? readFileSync(path, "utf8") : null;
		const desired = desiredSource(source, expectedBlock);
		if (desired.error)
			return { path, state: "invalid", expectedBlock, error: desired.error };
		if (source === null) return { path, state: "missing", expectedBlock };
		return {
			path,
			state: source === desired.source ? "current" : "stale",
			expectedBlock,
		};
	} catch (error) {
		return {
			path,
			state: "invalid",
			expectedBlock,
			error: `cannot inspect roster README: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

export function syncRosterReadme(
	projectRoot: string,
	options: { check?: boolean } = {},
): RosterReadmeSyncResult {
	const root = resolve(projectRoot);
	const flowsDir = join(root, "flows");
	try {
		if (!statSync(flowsDir).isDirectory()) {
			return {
				path: join(flowsDir, "README.md"),
				state: "invalid",
				expectedBlock: "",
				error: "flows/ is not a directory",
				changed: false,
			};
		}
	} catch {
		return {
			path: join(flowsDir, "README.md"),
			state: "invalid",
			expectedBlock: "",
			error: "flows/ does not exist; run md init --yes first",
			changed: false,
		};
	}
	const inspection = inspectRosterReadme(root);
	if (inspection.state === "invalid") return { ...inspection, changed: false };
	if (inspection.state === "current" || options.check)
		return { ...inspection, changed: false };
	// Containment: a symlinked flows/ (or README.md symlink) would redirect
	// this write outside the project; refuse instead of following it. All
	// subsequent I/O uses the CANONICAL checked target, never the lexical
	// inspection path.
	let target: string;
	try {
		target = containedWritePath(root, "flows", "README.md");
	} catch (error) {
		return {
			...inspection,
			state: "invalid",
			error:
				error instanceof ContainmentError
					? error.message
					: `containment check failed: ${error instanceof Error ? error.message : String(error)}`,
			changed: false,
		};
	}
	// Fail-closed read: ONLY genuine absence may mean "create new". Any other
	// error (permissions, I/O, replacement mid-flight) must stop the sync —
	// interpreting an observed filesystem error as permission to replace the
	// file would destroy user-owned text outside the managed block.
	const readTarget = (): { source: string | null; mode: number | null } => {
		try {
			const stats = lstatSync(target);
			return { mode: stats.mode & 0o777, source: readFileSync(target, "utf8") };
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ENOTDIR")
				return { source: null, mode: null };
			throw new ContainmentError(
				`cannot read ${target}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};
	let expected: { source: string | null; mode: number | null };
	try {
		expected = readTarget();
	} catch (error) {
		return {
			...inspection,
			state: "invalid",
			error: error instanceof Error ? error.message : String(error),
			changed: false,
		};
	}
	const desired = desiredSource(expected.source, inspection.expectedBlock);
	if (!desired.source)
		return {
			...inspection,
			state: "invalid",
			error: desired.error,
			changed: false,
		};
	const temp = join(
		dirname(target),
		`.README.md.${process.pid}.${Date.now()}.tmp`,
	);
	try {
		writeFileSync(temp, desired.source, { flag: "wx" });
		if (expected.mode !== null) chmodSync(temp, expected.mode);
		// Rename-boundary compare-and-swap: refuse if the target's bytes
		// changed since the read this content was computed from.
		renameBoundaryTestHook?.(target);
		const current = readTarget();
		if (current.source !== expected.source)
			throw new ContainmentError(
				"flows/README.md changed while syncing — re-run md roster sync",
			);
		renameSync(temp, target);
	} catch (error) {
		try {
			if (existsSync(temp)) rmSync(temp, { force: true });
		} catch (cleanupError) {
			void cleanupError;
		}
		if (error instanceof ContainmentError)
			return {
				...inspection,
				state: "invalid",
				error: error.message,
				changed: false,
			};
		throw error;
	}
	const verified = inspectRosterReadme(root);
	if (verified.state !== "current") {
		return {
			...verified,
			state: "invalid",
			error: verified.error ?? "roster README did not verify after write",
			changed: true,
		};
	}
	return { ...verified, changed: true };
}

/**
 * TEST-ONLY fault-injection seam: invoked with the canonical target
 * immediately before the rename-boundary re-read, so regressions can
 * deterministically make that read fail or its bytes mismatch. Never set
 * outside tests.
 */
let renameBoundaryTestHook: ((target: string) => void) | null = null;
export function __setRenameBoundaryTestHook(
	hook: ((target: string) => void) | null,
): void {
	renameBoundaryTestHook = hook;
}

export function rosterReadmePath(projectRoot: string): string {
	return join(resolve(projectRoot), "flows", "README.md");
}

export function projectRelativeRosterPath(projectRoot: string): string {
	return relative(
		resolve(projectRoot),
		rosterReadmePath(projectRoot),
	).replaceAll("\\", "/");
}
