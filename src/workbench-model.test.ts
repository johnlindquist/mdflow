import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "./parse";
import {
  applyFlowDraft,
  docReferenceLine,
  draftFlowFromIntent,
  effortFrontmatter,
  effortLevels,
  listNewFlowEngines,
  NEW_FLOW_DEFAULT_ENGINE,
  resolveWorkbenchTarget,
  slugifyFlowIntent,
  suggestFlowSlug,
  summarizeFlowLifecycle,
} from "./workbench-model";
import type { EvidenceEvent, EvolutionRunRecord } from "./evolution-store";

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "mdflow-workbench-model-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("draftFlowFromIntent", () => {
  it("turns intent into a runnable, versioned, identified Markdown flow", () => {
    const draft = draftFlowFromIntent("Review database migrations for rollback risks", {
      version: "4.2.0",
      flowId: "flow_test123",
    });

    expect(draft.slug).toBe("review-database-migrations");
    expect(draft.filename).toBe(`${draft.slug}.md`);
    expect(draft.description).toBe("Review database migrations for rollback risks");
    expect(draft.markdown).toContain("_flow_id: flow_test123");
    expect(draft.markdown).toContain("_mdflow_version: 4.2.0");
    const parsed = parseFrontmatter(draft.markdown);
    expect(parsed.frontmatter.description).toBe(draft.description);
    expect(parsed.body).toBe("Review database migrations for rollback risks");
  });

  it("supports composer overrides while preserving a safe filename", () => {
    const draft = draftFlowFromIntent("A long exploratory intent", {
      slug: "Release Notes!",
      description: "draft release notes",
      body: "Draft notes from !`git log --oneline -20`",
      version: "4.1.0",
      flowId: "flow_release",
    });

    expect(draft.filename).toBe("release-notes.md");
    expect(parseFrontmatter(draft.markdown)).toMatchObject({
      frontmatter: { description: "draft release notes", _flow_id: "flow_release" },
      body: "Draft notes from !`git log --oneline -20`",
    });
  });

  it("rejects an empty intent", () => {
    expect(() => draftFlowFromIntent(" \n\t ")).toThrow("Flow intent cannot be empty");
  });

  it("persists engine, model, effort, and preloaded docs", () => {
    const draft = draftFlowFromIntent("Summarize gog output", {
      engine: "codex",
      model: "gpt-5.5",
      effort: "high",
      docs: ["gog --help", "https://example.com/api.md"],
      version: "4.3.0",
      flowId: "flow_docs",
    });

    const parsed = parseFrontmatter(draft.markdown);
    expect(parsed.frontmatter).toMatchObject({
      engine: "codex",
      model: "gpt-5.5",
      config: ["model_reasoning_effort=high"],
    });
    expect(parsed.body).toBe(
      "Summarize gog output\n\n## Reference\n\n!`gog --help`\n@https://example.com/api.md",
    );
  });

  it("refuses effort without an engine or on an engine with no effort control", () => {
    expect(() => draftFlowFromIntent("Do a thing", { effort: "high" })).toThrow(
      "Effort is engine-specific",
    );
    expect(() => draftFlowFromIntent("Do a thing", { engine: "gemini", effort: "high" })).toThrow(
      "no verified reasoning-effort control",
    );
  });
});

describe("suggestFlowSlug", () => {
  it("keeps only the first few meaningful words", () => {
    expect(suggestFlowSlug("Review database migrations for rollback risks")).toBe(
      "review-database-migrations",
    );
    expect(suggestFlowSlug("Summarize this repository for a new contributor")).toBe(
      "summarize-repository-contributor",
    );
    expect(suggestFlowSlug("Draft release notes from recent commits")).toBe("draft-release-notes");
  });

  it("falls back safely for stopword-only and empty intents", () => {
    expect(suggestFlowSlug("for the with")).toBe("for-the-with");
    expect(suggestFlowSlug("✨")).toBe("new-flow");
  });
});

describe("composer engine metadata", () => {
  it("offers codex first and only registered engines", () => {
    const engines = listNewFlowEngines();
    expect(engines[0]).toBe(NEW_FLOW_DEFAULT_ENGINE);
    expect(engines[0]).toBe("codex");
    expect(engines).toContain("claude");
    expect(new Set(engines).size).toBe(engines.length);
  });

  it("translates effort per engine and hides it where unsupported", () => {
    expect(effortLevels("claude")).toContain("max");
    expect(effortFrontmatter("claude", "high")).toEqual({ effort: "high" });
    expect(effortFrontmatter("codex", "medium")).toEqual({
      config: ["model_reasoning_effort=medium"],
    });
    expect(effortFrontmatter("pi", "low")).toEqual({ thinking: "low" });
    expect(effortLevels("copilot")).toEqual([]);
    expect(() => effortFrontmatter("copilot", "high")).toThrow("no verified reasoning-effort control");
  });

  it("rejects effort levels the engine does not support", () => {
    expect(() => effortFrontmatter("claude", "banana")).toThrow('got "banana"');
    expect(() => effortFrontmatter("claude", "banana")).toThrow("low, medium, high");
    expect(() => effortFrontmatter("codex", "max")).toThrow("minimal, low, medium, high, xhigh");
  });
});

describe("docReferenceLine", () => {
  it("classifies commands, URLs, paths, and bare tool names", () => {
    expect(docReferenceLine("gog --help")).toBe("!`gog --help`");
    expect(docReferenceLine("https://example.com/docs.md")).toBe("@https://example.com/docs.md");
    expect(docReferenceLine("./docs/api.md")).toBe("@./docs/api.md");
    expect(docReferenceLine("gog")).toBe("!`gog --help`");
    expect(docReferenceLine("@./already-an-import.md")).toBe("@./already-an-import.md");
    expect(docReferenceLine("!git log --oneline -5")).toBe("!`git log --oneline -5`");
  });

  it("refuses a path with spaces instead of turning it into a shell command", () => {
    expect(() => docReferenceLine("./docs/API Guide.md")).toThrow("cannot express");
    expect(() => docReferenceLine("./docs/API Guide.md")).toThrow("prefix with !");
    // The explicit ! prefix remains the escape hatch for intentional commands.
    expect(docReferenceLine("!cat './docs/API Guide.md'")).toBe("!`cat './docs/API Guide.md'`");
  });
});

describe("slugifyFlowIntent", () => {
  it("normalizes unicode, bounds length, and protects the roster filename", () => {
    expect(slugifyFlowIntent("  Résumé / Review  ")).toBe("resume-review");
    expect(slugifyFlowIntent("README")).toBe("readme-flow");
    expect(slugifyFlowIntent("✨")).toBe("new-flow");
    expect(slugifyFlowIntent("word ".repeat(30)).length).toBeLessThanOrEqual(56);
  });
});

describe("resolveWorkbenchTarget", () => {
  it("uses a Git root for an uninitialized nested working directory", () => {
    mkdirSync(join(directory, ".git"));
    const nested = join(directory, "packages", "app", "src");
    mkdirSync(nested, { recursive: true });

    expect(resolveWorkbenchTarget(nested)).toMatchObject({
      projectRoot: directory,
      flowsDir: join(directory, "flows"),
      configPath: join(directory, ".mdflow.yaml"),
      source: "git",
    });
  });

  it("uses the nearest mdflow marker and preserves an alternate config name", () => {
    mkdirSync(join(directory, ".git"));
    const project = join(directory, "packages", "tool");
    const nested = join(project, "src");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(project, "mdflow.config.yaml"), "engine: codex\n");

    expect(resolveWorkbenchTarget(nested)).toMatchObject({
      projectRoot: project,
      configPath: join(project, "mdflow.config.yaml"),
      existingConfigPath: join(project, "mdflow.config.yaml"),
      source: "config",
    });
  });

  it("accepts a file as the starting location", () => {
    mkdirSync(join(directory, ".git"));
    const file = join(directory, "src", "index.ts");
    mkdirSync(join(directory, "src"));
    writeFileSync(file, "export {}\n");
    expect(resolveWorkbenchTarget(file).projectRoot).toBe(directory);
  });
});

describe("applyFlowDraft", () => {
  it("creates the flow, roster, and config additively", () => {
    mkdirSync(join(directory, ".git"));
    const draft = draftFlowFromIntent("Review staged changes for bugs", {
      version: "4.1.0",
      flowId: "flow_review",
    });
    const result = applyFlowDraft(draft, { startPath: directory, engine: "codex" });

    expect(result.status).toBe("created");
    expect(result.created).toEqual([
      join(directory, "flows", "review-staged-changes.md"),
      join(directory, "flows", "README.md"),
      join(directory, ".mdflow.yaml"),
    ]);
    expect(readFileSync(result.flowPath, "utf8")).toBe(draft.markdown);
    expect(readFileSync(join(directory, "flows", "README.md"), "utf8")).toContain("Open the Flow Workbench: `md`");
    expect(readFileSync(join(directory, ".mdflow.yaml"), "utf8")).toContain("engine: codex");
  });

  it("does not stamp a project engine default without an explicit engine choice", () => {
    mkdirSync(join(directory, ".git"));
    const draft = draftFlowFromIntent("Review staged changes for bugs", {
      version: "4.1.0",
      flowId: "flow_review",
    });
    const result = applyFlowDraft(draft, { startPath: directory });

    expect(result.status).toBe("created");
    expect(result.created).toEqual([
      join(directory, "flows", "review-staged-changes.md"),
      join(directory, "flows", "README.md"),
    ]);
    expect(existsSync(join(directory, ".mdflow.yaml"))).toBe(false);
  });

  it("never overwrites an existing flow or creates support files on conflict", () => {
    mkdirSync(join(directory, "flows"), { recursive: true });
    const draft = draftFlowFromIntent("Review changes", { flowId: "flow_review", version: "4.1.0" });
    const flowPath = join(directory, "flows", draft.filename);
    writeFileSync(flowPath, "MINE\n");

    const result = applyFlowDraft(draft, { startPath: directory, engine: "claude" });

    expect(result.status).toBe("conflict");
    expect(result.created).toEqual([]);
    expect(readFileSync(flowPath, "utf8")).toBe("MINE\n");
    expect(existsSync(join(directory, "flows", "README.md"))).toBe(false);
    expect(existsSync(join(directory, ".mdflow.yaml"))).toBe(false);
  });

  it("preserves existing roster and config files", () => {
    mkdirSync(join(directory, "flows"), { recursive: true });
    writeFileSync(join(directory, "flows", "README.md"), "MY ROSTER\n");
    writeFileSync(join(directory, ".mdflow.json"), '{"engine":"claude"}\n');
    const draft = draftFlowFromIntent("Draft release notes", { flowId: "flow_release", version: "4.1.0" });

    const result = applyFlowDraft(draft, { startPath: directory, engine: "codex" });

    expect(result.status).toBe("created");
    expect(readFileSync(join(directory, "flows", "README.md"), "utf8")).toBe("MY ROSTER\n");
    expect(readFileSync(join(directory, ".mdflow.json"), "utf8")).toBe('{"engine":"claude"}\n');
    expect(existsSync(join(directory, ".mdflow.yaml"))).toBe(false);
    expect(result.skipped).toEqual([
      join(directory, "flows", "README.md"),
      join(directory, ".mdflow.json"),
    ]);
  });
});

function evidence(status: EvidenceEvent["status"], flowId = "flow_one"): EvidenceEvent {
  return {
    id: `fb_${status}`,
    flowId,
    flowPath: "/repo/flows/one.md",
    type: "explicit_feedback",
    confidence: "high",
    message: "Improve this",
    timestamp: "2026-07-09T00:00:00.000Z",
    status,
  };
}

function run(status: EvolutionRunRecord["status"], updatedAt: string, flowId = "flow_one"): EvolutionRunRecord {
  return {
    schemaVersion: 1,
    id: `evr_${status}`,
    flow: { id: flowId, path: "/repo/flows/one.md", relativePath: "flows/one.md" },
    suitePath: "/repo/flows/one.eval.ts",
    status,
    createdAt: updatedAt,
    updatedAt,
    currentHash: "abc",
    evidenceIds: [],
    targetEvidenceIds: [],
    plannedInvocations: 0,
    actualInvocations: 0,
  };
}

describe("summarizeFlowLifecycle", () => {
  it("prioritizes a verified proposal over open evidence", () => {
    const summary = summarizeFlowLifecycle({
      flowId: "flow_one",
      evidence: [evidence("open"), evidence("targeted"), evidence("open", "flow_other")],
      runs: [
        run("applied", "2026-07-08T00:00:00.000Z"),
        run("verified_improvement", "2026-07-09T00:00:00.000Z"),
      ],
    });

    expect(summary.evidence).toMatchObject({ total: 2, open: 1, targeted: 1, actionable: 2 });
    expect(summary.evolution).toMatchObject({ latestStatus: "verified_improvement", reviewable: true });
    expect(summary.headline).toBe("1 open feedback · 1 targeted · verified improvement ready");
    expect(summary.recommendedAction).toBe("evolve-apply");
  });

  it("recommends a plan when actionable evidence has no pending proposal", () => {
    const summary = summarizeFlowLifecycle({ evidence: [evidence("open")] });
    expect(summary.recommendedAction).toBe("evolve-plan");
  });
});
