import { describe, expect, test } from "bun:test";
import type { AgentFile } from "./cli";
import {
  fuzzyMatch,
  rankWorkbenchFlows,
} from "./workbench-search";

function flow(name: string, options: Partial<AgentFile> = {}): AgentFile {
  return {
    name,
    path: `/flows/${name}`,
    source: "flows",
    ...options,
  };
}

describe("Workbench fuzzy matching", () => {
  test("uses non-overlapping prefix, word-boundary, contiguous, and scattered categories", () => {
    const prefix = fuzzyMatch("review.codex.md", "rev")!;
    const boundary = fuzzyMatch("review.codex.md", "cod")!;
    const contiguous = fuzzyMatch("review.codex.md", "vie")!;
    const scattered = fuzzyMatch("review.codex.md", "rvc")!;

    expect(prefix).toMatchObject({ category: "prefix", indices: [0, 1, 2] });
    expect(boundary).toMatchObject({ category: "word-boundary", indices: [7, 8, 9] });
    expect(contiguous).toMatchObject({ category: "contiguous", indices: [2, 3, 4] });
    expect(scattered).toMatchObject({ category: "scattered", indices: [0, 2, 7] });
    expect(prefix.score).toBeGreaterThan(boundary.score);
    expect(boundary.score).toBeGreaterThan(contiguous.score);
    expect(contiguous.score).toBeGreaterThan(scattered.score);
  });

  test("is case-insensitive, recognizes camelCase boundaries, and rejects out-of-order text", () => {
    expect(fuzzyMatch("releaseCodex.md", "CODEX")).toMatchObject({
      category: "word-boundary",
      indices: [7, 8, 9, 10, 11],
    });
    expect(fuzzyMatch("review.codex.md", "cvr")).toBeNull();
    expect(fuzzyMatch("review.codex.md", "")).toBeNull();
    expect(fuzzyMatch("release notes.md", " ")).toMatchObject({ category: "contiguous" });
  });

  test("chooses the most compact scattered subsequence and returns highlight indices", () => {
    expect(fuzzyMatch("axxxabxc", "abc")).toMatchObject({
      category: "scattered",
      indices: [4, 5, 7],
      start: 4,
      span: 4,
    });
  });
});

describe("Workbench flow ranking", () => {
  test("sorts an empty query by frecency descending and preserves input order for ties", () => {
    const files = [
      flow("quiet.md", { frecency: 2 }),
      flow("hot.md", { frecency: 20 }),
      flow("also-hot.md", { frecency: 20 }),
    ];

    expect(rankWorkbenchFlows(files, "").map((entry) => entry.file.name)).toEqual([
      "hot.md",
      "also-hot.md",
      "quiet.md",
    ]);
  });

  test("falls back to the supplied frecency scorer when discovery did not attach a score", () => {
    const files = [flow("one.md"), flow("two.md")];
    const scores: Record<string, number> = { "/flows/one.md": 1, "/flows/two.md": 9 };

    expect(rankWorkbenchFlows(files, "", (path) => scores[path] ?? 0).map((entry) => entry.file.name))
      .toEqual(["two.md", "one.md"]);
  });

  test("keeps category priority above field preference", () => {
    const nameScattered = flow("review-codex.md", {
      path: "/flows/first.md",
    });
    const descriptionContiguous = flow("other.md", {
      path: "/flows/second.md",
      description: "Run an rvc playbook",
    });

    const ranked = rankWorkbenchFlows([nameScattered, descriptionContiguous], "rvc");
    expect(ranked.map((entry) => entry.file.name)).toEqual(["other.md", "review-codex.md"]);
    expect(ranked.map((entry) => entry.match?.field)).toEqual(["description", "name"]);
  });

  test("prefers name over description and path for equal-category matches", () => {
    const nameMatch = flow("review.md", { path: "/flows/first.md" });
    const descriptionMatch = flow("other.md", {
      path: "/flows/second.md",
      description: "Review production",
    });
    const pathMatch = flow("last.md", { path: "review/archive/last.md" });

    const ranked = rankWorkbenchFlows([pathMatch, descriptionMatch, nameMatch], "rev");
    expect(ranked.map((entry) => entry.match?.field)).toEqual(["name", "description", "path"]);
  });

  test("uses frecency to break equal fuzzy scores", () => {
    const cold = flow("review.md", { path: "/cold/review.md", frecency: 1 });
    const hot = flow("review.md", { path: "/hot/review.md", frecency: 99 });

    const ranked = rankWorkbenchFlows([cold, hot], "review");
    expect(ranked.map((entry) => entry.file.path)).toEqual(["/hot/review.md", "/cold/review.md"]);
    expect(ranked[0]?.score).toBe(ranked[1]?.score);
  });

  test("filters flows that do not match name, description, or path", () => {
    const ranked = rankWorkbenchFlows(
      [flow("review.md"), flow("deploy.md", { description: "Ship the release" })],
      "xyz",
    );
    expect(ranked).toEqual([]);
  });
});
