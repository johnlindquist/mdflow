import {
	existsSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { resolveEngine } from "./command";
import { findManagedBlock, upsertManagedBlock } from "./managed-block";
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
	const source = existsSync(inspection.path)
		? readFileSync(inspection.path, "utf8")
		: null;
	const desired = desiredSource(source, inspection.expectedBlock);
	if (!desired.source)
		return {
			...inspection,
			state: "invalid",
			error: desired.error,
			changed: false,
		};
	const dir = dirname(inspection.path);
	const temp = join(dir, `.README.md.${process.pid}.${Date.now()}.tmp`);
	try {
		writeFileSync(temp, desired.source, { flag: "wx" });
		renameSync(temp, inspection.path);
	} catch (error) {
		try {
			if (existsSync(temp)) rmSync(temp, { force: true });
		} catch (cleanupError) {
			void cleanupError;
		}
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

export function rosterReadmePath(projectRoot: string): string {
	return join(resolve(projectRoot), "flows", "README.md");
}

export function projectRelativeRosterPath(projectRoot: string): string {
	return relative(
		resolve(projectRoot),
		rosterReadmePath(projectRoot),
	).replaceAll("\\", "/");
}
