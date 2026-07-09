import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "./parse";
import {
  applyFlowDraft,
  draftFlowFromIntent,
  resolveWorkbenchTarget,
  slugifyFlowIntent,
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

    expect(draft.slug).toBe("review-database-migrations-for-rollback-risks");
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
      join(directory, "flows", "review-staged-changes-for-bugs.md"),
      join(directory, "flows", "README.md"),
      join(directory, ".mdflow.yaml"),
    ]);
    expect(readFileSync(result.flowPath, "utf8")).toBe(draft.markdown);
    expect(readFileSync(join(directory, "flows", "README.md"), "utf8")).toContain("Open the Flow Workbench: `md`");
    expect(readFileSync(join(directory, ".mdflow.yaml"), "utf8")).toContain("engine: codex");
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
