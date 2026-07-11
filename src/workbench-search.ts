/**
 * Search primitives for the Flow Workbench.
 *
 * The matcher uses four deliberately non-overlapping categories. Their large
 * score bands make the ordering easy to reason about: a stronger category can
 * never be overtaken by field or compactness bonuses.
 */

import type { AgentFile } from "./cli";
import { getFrecencyScore } from "./history";

export type FuzzyMatchCategory = "prefix" | "word-boundary" | "contiguous" | "scattered";

/** Public so the ranking contract is visible to callers and tests. */
export const FUZZY_CATEGORY_WEIGHTS: Readonly<Record<FuzzyMatchCategory, number>> = {
  prefix: 4,
  "word-boundary": 3,
  contiguous: 2,
  scattered: 1,
};

export interface FuzzyMatch {
  category: FuzzyMatchCategory;
  /**
   * Category weight * 100, refined by at most 1.1 points for compactness and
   * an early start. Category bands therefore never overlap.
   */
  score: number;
  /** UTF-16 indices into the original candidate, suitable for row highlighting. */
  indices: number[];
  start: number;
  span: number;
}

export type WorkbenchSearchField = "name" | "description" | "path";

export interface WorkbenchFlowMatch extends FuzzyMatch {
  field: WorkbenchSearchField;
  value: string;
}

export interface RankedWorkbenchFlow {
  file: AgentFile;
  /** Fuzzy score including the bounded field-preference bonus. */
  score: number;
  frecency: number;
  /** Absent for an empty query, where ranking is frecency-only. */
  match?: WorkbenchFlowMatch;
}

export type FrecencyScore = (path: string) => number;

const FIELD_BONUS: Readonly<Record<WorkbenchSearchField, number>> = {
  name: 30,
  description: 20,
  path: 10,
};

function isAsciiWordCharacter(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9]/.test(character);
}

function isWordBoundary(value: string, index: number): boolean {
  if (index === 0) return true;
  const previous = value[index - 1];
  const current = value[index];
  if (!isAsciiWordCharacter(previous)) return true;
  // Preserve camelCase boundaries even though matching itself is case-insensitive.
  return current !== undefined
    && /[A-Z]/.test(current)
    && previous !== undefined
    && /[a-z0-9]/.test(previous);
}

function rangeIndices(start: number, length: number): number[] {
  return Array.from({ length }, (_, offset) => start + offset);
}

function findBoundarySubstring(value: string, haystack: string, needle: string): number {
  let from = 1; // index zero is the prefix category
  while (from <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) return -1;
    if (isWordBoundary(value, index)) return index;
    from = index + 1;
  }
  return -1;
}

/**
 * Find the most compact ordered subsequence. For each possible first
 * character, greedily taking the next character produces that start's
 * shortest completion; comparing those completions yields the shortest span.
 */
function findScatteredIndices(haystack: string, needle: string): number[] | undefined {
  let best: number[] | undefined;
  for (let start = haystack.indexOf(needle[0]!); start !== -1; start = haystack.indexOf(needle[0]!, start + 1)) {
    const indices = [start];
    let cursor = start + 1;
    for (let queryIndex = 1; queryIndex < needle.length; queryIndex += 1) {
      const index = haystack.indexOf(needle[queryIndex]!, cursor);
      if (index === -1) {
        indices.length = 0;
        break;
      }
      indices.push(index);
      cursor = index + 1;
    }
    if (indices.length !== needle.length) continue;

    const span = indices[indices.length - 1]! - indices[0]! + 1;
    const bestSpan = best ? best[best.length - 1]! - best[0]! + 1 : Number.POSITIVE_INFINITY;
    if (span < bestSpan || (span === bestSpan && indices[0]! < best![0]!)) best = indices;
  }
  return best;
}

function buildMatch(category: FuzzyMatchCategory, indices: number[], queryLength: number): FuzzyMatch {
  const start = indices[0]!;
  const span = indices[indices.length - 1]! - start + 1;
  const compactness = queryLength / span;
  const earlyStart = 1 / (start + 1) / 10;
  return {
    category,
    score: FUZZY_CATEGORY_WEIGHTS[category] * 100 + compactness + earlyStart,
    indices,
    start,
    span,
  };
}

/**
 * Case-insensitive fuzzy matching with this strict category order:
 *
 * 1. prefix: contiguous at index zero
 * 2. word-boundary: contiguous after punctuation, a separator, or camelCase
 * 3. contiguous: contiguous elsewhere
 * 4. scattered: an ordered subsequence
 */
export function fuzzyMatch(value: string, query: string): FuzzyMatch | null {
  const needle = query.toLocaleLowerCase();
  if (!needle) return null;
  const haystack = value.toLocaleLowerCase();

  if (haystack.startsWith(needle)) {
    return buildMatch("prefix", rangeIndices(0, needle.length), needle.length);
  }

  const boundaryIndex = findBoundarySubstring(value, haystack, needle);
  if (boundaryIndex !== -1) {
    return buildMatch(
      "word-boundary",
      rangeIndices(boundaryIndex, needle.length),
      needle.length,
    );
  }

  const contiguousIndex = haystack.indexOf(needle);
  if (contiguousIndex !== -1) {
    return buildMatch(
      "contiguous",
      rangeIndices(contiguousIndex, needle.length),
      needle.length,
    );
  }

  const scatteredIndices = findScatteredIndices(haystack, needle);
  return scatteredIndices
    ? buildMatch("scattered", scatteredIndices, needle.length)
    : null;
}

function bestFlowMatch(file: AgentFile, query: string): { match: WorkbenchFlowMatch; score: number } | undefined {
  const fields: Array<readonly [WorkbenchSearchField, string | undefined]> = [
    ["name", file.name],
    ["description", file.description],
    ["path", file.path],
  ];
  let best: { match: WorkbenchFlowMatch; score: number } | undefined;

  for (const [field, value] of fields) {
    if (!value) continue;
    const match = fuzzyMatch(value, query);
    if (!match) continue;
    const score = match.score + FIELD_BONUS[field];
    if (!best || score > best.score) {
      best = { match: { ...match, field, value }, score };
    }
  }
  return best;
}

/**
 * Rank Workbench flows. Empty queries are frecency-first. Search queries are
 * fuzzy-score-first, with frecency used only to break equal search scores.
 */
export function rankWorkbenchFlows(
  files: readonly AgentFile[],
  query: string,
  scorePath: FrecencyScore = getFrecencyScore,
): RankedWorkbenchFlow[] {
  const normalizedQuery = query;
  const ranked = files.map((file, originalIndex) => {
    const frecency = file.frecency ?? scorePath(file.path);
    if (!normalizedQuery) {
      return { file, score: frecency, frecency, originalIndex };
    }
    const best = bestFlowMatch(file, normalizedQuery);
    return best
      ? { file, score: best.score, frecency, match: best.match, originalIndex }
      : undefined;
  }).filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);

  ranked.sort((left, right) => {
    if (normalizedQuery) {
      const scoreDifference = right.score - left.score;
      if (scoreDifference !== 0) return scoreDifference;
    }
    const frecencyDifference = right.frecency - left.frecency;
    if (frecencyDifference !== 0) return frecencyDifference;
    return left.originalIndex - right.originalIndex;
  });

  return ranked.map(({ originalIndex: _originalIndex, ...entry }) => entry);
}
