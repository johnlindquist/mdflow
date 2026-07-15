/**
 * Marker-delimited managed blocks inside user-owned markdown files.
 *
 * mdflow owns exactly the bytes between one start/end marker pair and never
 * touches the user-authored text around it. Markers inside code fences are
 * ignored so documentation ABOUT the markers cannot be mistaken for the
 * managed block itself.
 */

export interface ManagedMarkers {
	start: string;
	end: string;
}

export type ManagedBlockRange =
	| { start: number; end: number }
	| { error: string }
	| null;

/**
 * Locate the single managed block in `source`. Returns null when no marker is
 * present, an error when markers are duplicated, unbalanced, or out of order.
 */
export function findManagedBlock(
	source: string,
	markers: ManagedMarkers,
): ManagedBlockRange {
	const starts: number[] = [];
	const ends: number[] = [];
	let offset = 0;
	let fence: "```" | "~~~" | null = null;
	for (const lineWithEol of source.match(/.*(?:\r?\n|$)/g) ?? []) {
		if (!lineWithEol) continue;
		const line = lineWithEol.replace(/\r?\n$/, "");
		const trimmed = line.trim();
		if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
			const marker = trimmed.startsWith("```") ? "```" : "~~~";
			fence = fence === marker ? null : (fence ?? marker);
		} else if (!fence && trimmed === markers.start) {
			starts.push(offset + line.indexOf(markers.start));
		} else if (!fence && trimmed === markers.end) {
			ends.push(offset + line.indexOf(markers.end));
		}
		offset += lineWithEol.length;
	}
	if (starts.length === 0 && ends.length === 0) return null;
	if (starts.length !== 1 || ends.length !== 1)
		return {
			error: "managed markers must appear exactly once outside code fences",
		};
	const start = starts[0];
	const endMarker = ends[0];
	if (start === undefined || endMarker === undefined)
		return { error: "managed marker offsets are unavailable" };
	const end = endMarker + markers.end.length;
	if (end <= start) return { error: "managed markers are out of order" };
	return { start, end };
}

export interface UpsertManagedBlockResult {
	source?: string;
	error?: string;
}

/**
 * Compute the desired file content: replace an existing managed block, append
 * one to a marker-free file, or create the file from `create(block)` when
 * `source` is null.
 */
export function upsertManagedBlock(
	source: string | null,
	block: string,
	markers: ManagedMarkers,
	create: (block: string) => string,
): UpsertManagedBlockResult {
	if (source === null) return { source: create(block) };
	const range = findManagedBlock(source, markers);
	if (range && "error" in range) return { error: range.error };
	if (range)
		return {
			source: `${source.slice(0, range.start)}${block}${source.slice(range.end)}`,
		};
	const separator = source.endsWith("\n") ? "\n" : "\n\n";
	return { source: `${source}${separator}${block}\n` };
}
