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
 *
 * The sync is fail-closed as one multi-file operation: every target is
 * preflighted before the first write, and if ANY target is invalid (bad
 * markers, ambiguous markdown, symlink, non-regular file) nothing is written
 * at all. Each write re-reads its target immediately before the atomic
 * rename and refuses to clobber bytes that changed since inspection.
 */

import {
	chmodSync,
	existsSync,
	lstatSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { ContainmentError, containedWritePath } from "./contained-write";
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
- If you are already executing inside an mdflow flow (the environment
  variable \`MDFLOW_ACTIVE_FLOW\` is set), do the current task directly and
  never invoke another flow without a new, explicit user request — recursive
  handoff multiplies cost without a fresh consent boundary.
${AGENT_GUIDANCE_END}`;
}

interface InspectedFile extends AgentGuidanceInspection {
	/** Exact bytes read at inspection time; null when the file is absent. */
	source: string | null;
	/** File mode at inspection time; null when the file is absent. */
	mode: number | null;
}

function inspectFile(
	root: string,
	file: AgentGuidanceFile,
	block: string,
): InspectedFile {
	const path = join(root, file);
	try {
		let stats: ReturnType<typeof lstatSync> | null = null;
		try {
			stats = lstatSync(path);
		} catch {
			stats = null;
		}
		if (!stats)
			return { file, path, state: "missing", source: null, mode: null };
		if (stats.isSymbolicLink())
			return {
				file,
				path,
				state: "invalid",
				error: `${file} is a symlink — mdflow never writes through symlinks`,
				source: null,
				mode: null,
			};
		if (!stats.isFile())
			return {
				file,
				path,
				state: "invalid",
				error: `${file} is not a regular file`,
				source: null,
				mode: null,
			};
		const source = readFileSync(path, "utf8");
		const mode = stats.mode & 0o777;
		const range = findManagedBlock(source, GUIDANCE_MARKERS);
		if (range && "error" in range)
			return {
				file,
				path,
				state: "invalid",
				error: `${file}: ${range.error}`,
				source,
				mode,
			};
		if (range === null)
			return { file, path, state: "not-opted-in", source, mode };
		return {
			file,
			path,
			state:
				source.slice(range.start, range.end) === block ? "current" : "stale",
			source,
			mode,
		};
	} catch (error) {
		return {
			file,
			path,
			state: "invalid",
			error: `cannot inspect ${file}: ${error instanceof Error ? error.message : String(error)}`,
			source: null,
			mode: null,
		};
	}
}

function publicInspection(inspected: InspectedFile): AgentGuidanceInspection {
	const { source, mode, ...inspection } = inspected;
	void source;
	void mode;
	return inspection;
}

export function inspectAgentGuidance(
	projectRoot: string,
): AgentGuidanceInspection[] {
	const root = resolve(projectRoot);
	const block = renderAgentGuidanceBlock();
	return AGENT_GUIDANCE_FILES.map((file) =>
		publicInspection(inspectFile(root, file, block)),
	);
}

/** True once any guidance file carries the managed markers. */
export function hasAgentGuidance(projectRoot: string): boolean {
	return inspectAgentGuidance(projectRoot).some(
		(inspection) =>
			inspection.state === "current" || inspection.state === "stale",
	);
}

/**
 * Commit one managed write: revalidate containment at write time, stage the
 * bytes in a same-directory temp file, then re-read the target IMMEDIATELY
 * before the rename and refuse if it no longer matches the bytes the caller
 * inspected. All paths are the canonical (checked) target, never the lexical
 * inspection path.
 */
function commitManagedWrite(
	root: string,
	file: AgentGuidanceFile,
	expected: string | null,
	content: string,
	mode: number | null,
): void {
	const target = containedWritePath(root, file);
	const temp = join(
		dirname(target),
		`.${basename(target)}.${process.pid}.${Date.now()}.tmp`,
	);
	try {
		writeFileSync(temp, content, { flag: "wx" });
		if (mode !== null) chmodSync(temp, mode);
		// Rename-boundary compare-and-swap: the window between this read and
		// the rename is the smallest this API allows.
		let current: string | null = null;
		try {
			current = readFileSync(target, "utf8");
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
			current = null;
		}
		if (current !== expected)
			throw new Error(`${file} changed while syncing — re-run md roster sync`);
		renameSync(temp, target);
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
 * Bring the managed guidance blocks up to date. EVERY write — creating,
 * extending, or refreshing a stale block — requires `optIn`: a marker
 * already present in the repository is data, not the current user's
 * authorization, so plain maintenance surfaces only report drift. The
 * operation is fail-closed as a unit: if ANY guidance file is invalid,
 * nothing is written to any of them, and a write failure stops every
 * remaining write.
 */
export function syncAgentGuidance(
	projectRoot: string,
	options: AgentGuidanceSyncOptions = {},
): AgentGuidanceSyncResult[] {
	const root = resolve(projectRoot);
	const block = renderAgentGuidanceBlock();
	const inspected = AGENT_GUIDANCE_FILES.map((file) =>
		inspectFile(root, file, block),
	);

	const needsWrite = (state: AgentGuidanceState): boolean =>
		Boolean(options.optIn) &&
		(state === "stale" || state === "missing" || state === "not-opted-in");

	// Preflight boundary: one invalid target stops the whole multi-file
	// operation before the first write.
	const anyInvalid = inspected.some((entry) => entry.state === "invalid");
	if (options.check || anyInvalid) {
		return inspected.map((entry) => ({
			...publicInspection(entry),
			changed: false,
			error:
				entry.error ??
				(anyInvalid && needsWrite(entry.state)
					? "not written: another guidance file is invalid (guidance syncs as one fail-closed operation)"
					: entry.error),
		}));
	}

	const results: AgentGuidanceSyncResult[] = [];
	let writeFailed = false;
	for (const entry of inspected) {
		if (!needsWrite(entry.state)) {
			results.push({ ...publicInspection(entry), changed: false });
			continue;
		}
		if (writeFailed) {
			// Stop after the first commit failure: continuing would deepen the
			// partial write the unit exists to prevent.
			results.push({
				...publicInspection(entry),
				changed: false,
				error:
					"not written: an earlier guidance write failed (guidance syncs as one fail-closed operation)",
			});
			continue;
		}
		try {
			const desired = upsertManagedBlock(
				entry.source,
				block,
				GUIDANCE_MARKERS,
				(managed) => `${managed}\n`,
			);
			if (!desired.source) {
				writeFailed = true;
				results.push({
					...publicInspection(entry),
					state: "invalid",
					error: `${entry.file}: ${desired.error}`,
					changed: false,
				});
				continue;
			}
			commitManagedWrite(root, entry.file, entry.source, desired.source, entry.mode);
			const verified = inspectFile(root, entry.file, block);
			if (verified.state !== "current") {
				writeFailed = true;
				results.push({
					...publicInspection(verified),
					state: "invalid",
					error: verified.error ?? `${entry.file} did not verify after write`,
					changed: true,
				});
				continue;
			}
			results.push({ ...publicInspection(verified), changed: true });
		} catch (error) {
			writeFailed = true;
			const reason =
				error instanceof ContainmentError
					? error.message
					: `cannot sync ${entry.file}: ${error instanceof Error ? error.message : String(error)}`;
			results.push({
				...publicInspection(entry),
				state: "invalid",
				error: reason,
				changed: false,
			});
		}
	}
	return results;
}
