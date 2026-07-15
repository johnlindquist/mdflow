/**
 * Agent guidance files — the "flows are the primary workflow" opt-in.
 *
 * When a user decides flows should be the natural way agents work in their
 * repository, mdflow maintains one marker-delimited block in `AGENTS.md` and
 * `CLAUDE.md` at the project root pointing coding agents at the flow roster.
 *
 * Opt-in is explicit: default `md roster sync` only refreshes files that
 * already contain the markers; `md roster sync --agents` (or the init-time
 * question) creates them. Everything outside the markers is user-owned.
 */

import {
	existsSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { findManagedBlock, upsertManagedBlock } from "./managed-block";

export const AGENT_GUIDANCE_START = "<!-- mdflow:agents:start contract=1 -->";
export const AGENT_GUIDANCE_END = "<!-- mdflow:agents:end -->";
const GUIDANCE_MARKERS = {
	start: AGENT_GUIDANCE_START,
	end: AGENT_GUIDANCE_END,
} as const;

/** Guidance files maintained at the project root, in write order. */
export const AGENT_GUIDANCE_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
export type AgentGuidanceFile = (typeof AGENT_GUIDANCE_FILES)[number];

export type AgentGuidanceState =
	/** File does not exist; only --agents opt-in creates it. */
	| "missing"
	/** File exists without markers; only --agents opt-in appends the block. */
	| "not-opted-in"
	| "current"
	| "stale"
	| "invalid";

export interface AgentGuidanceInspection {
	file: AgentGuidanceFile;
	path: string;
	state: AgentGuidanceState;
	error?: string;
}

export interface AgentGuidanceSyncResult extends AgentGuidanceInspection {
	changed: boolean;
}

/**
 * The managed block is deliberately static pointers (roster location, doctor,
 * consent invariants) rather than per-flow data, so ordinary roster edits do
 * not leave stale guidance in every agent's context file.
 */
export function renderAgentGuidanceBlock(): string {
	return `${AGENT_GUIDANCE_START}
## mdflow flows

Agent work in this repository runs through mdflow flows: markdown-defined,
eval-guarded agent jobs in \`flows/\`. When a task matches a flow, hand it off
to that flow instead of improvising the same work ad hoc.

- Start every maintenance task with \`md doctor --json\` (FREE, no execution).
- The flow roster and operator card live in \`flows/README.md\`.
- Run a flow: \`md flows/<name>.md\`. Preview any run for free first:
  \`md flows/<name>.md --_dry-run\`.
- Enumerate flows for machines: \`md roster --json\` (FREE).
- Create a new flow: \`md create "describe what it should do"\` (preview with
  \`--dry-run\`).
- A real flow run, eval run, proposal run, and source mutation each require
  separate consent.
${AGENT_GUIDANCE_END}`;
}

function inspectFile(
	root: string,
	file: AgentGuidanceFile,
	block: string,
): AgentGuidanceInspection {
	const path = join(root, file);
	try {
		if (!existsSync(path)) return { file, path, state: "missing" };
		const source = readFileSync(path, "utf8");
		const range = findManagedBlock(source, GUIDANCE_MARKERS);
		if (range && "error" in range)
			return {
				file,
				path,
				state: "invalid",
				error: `${file}: ${range.error}`,
			};
		if (range === null) return { file, path, state: "not-opted-in" };
		return {
			file,
			path,
			state:
				source.slice(range.start, range.end) === block ? "current" : "stale",
		};
	} catch (error) {
		return {
			file,
			path,
			state: "invalid",
			error: `cannot inspect ${file}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

export function inspectAgentGuidance(
	projectRoot: string,
): AgentGuidanceInspection[] {
	const root = resolve(projectRoot);
	const block = renderAgentGuidanceBlock();
	return AGENT_GUIDANCE_FILES.map((file) => inspectFile(root, file, block));
}

/** True once any guidance file carries the managed markers. */
export function hasAgentGuidance(projectRoot: string): boolean {
	return inspectAgentGuidance(projectRoot).some(
		(inspection) =>
			inspection.state === "current" || inspection.state === "stale",
	);
}

function writeAtomically(path: string, content: string): void {
	const dir = dirname(path);
	const temp = join(
		dir,
		`.${path.split("/").pop()}.${process.pid}.${Date.now()}.tmp`,
	);
	try {
		writeFileSync(temp, content, { flag: "wx" });
		renameSync(temp, path);
	} catch (error) {
		try {
			if (existsSync(temp)) rmSync(temp, { force: true });
		} catch (cleanupError) {
			void cleanupError;
		}
		throw error;
	}
}

export interface AgentGuidanceSyncOptions {
	/** Report without writing. */
	check?: boolean;
	/** Create missing files and append the block to marker-free files. */
	optIn?: boolean;
}

/**
 * Bring the managed guidance blocks up to date. Without `optIn`, files that
 * never opted in ("missing" / "not-opted-in") are left untouched; with it,
 * they are created or extended. "invalid" files are never rewritten.
 */
export function syncAgentGuidance(
	projectRoot: string,
	options: AgentGuidanceSyncOptions = {},
): AgentGuidanceSyncResult[] {
	const root = resolve(projectRoot);
	const block = renderAgentGuidanceBlock();
	return AGENT_GUIDANCE_FILES.map((file): AgentGuidanceSyncResult => {
		const inspection = inspectFile(root, file, block);
		const needsWrite =
			inspection.state === "stale" ||
			(Boolean(options.optIn) &&
				(inspection.state === "missing" ||
					inspection.state === "not-opted-in"));
		if (options.check || !needsWrite) return { ...inspection, changed: false };
		try {
			const source = existsSync(inspection.path)
				? readFileSync(inspection.path, "utf8")
				: null;
			const desired = upsertManagedBlock(
				source,
				block,
				GUIDANCE_MARKERS,
				(managed) => `${managed}\n`,
			);
			if (!desired.source)
				return {
					...inspection,
					state: "invalid",
					error: `${file}: ${desired.error}`,
					changed: false,
				};
			writeAtomically(inspection.path, desired.source);
			const verified = inspectFile(root, file, block);
			if (verified.state !== "current")
				return {
					...verified,
					state: "invalid",
					error:
						verified.error ?? `${file} did not verify after write`,
					changed: true,
				};
			return { ...verified, changed: true };
		} catch (error) {
			return {
				...inspection,
				state: "invalid",
				error: `cannot sync ${file}: ${error instanceof Error ? error.message : String(error)}`,
				changed: false,
			};
		}
	});
}
