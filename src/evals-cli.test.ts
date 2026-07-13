/**
 * Tests for `md eval add|list|remove|coverage` — the management surface.
 * Mirrors hooks-cli.test.ts: an injectable runtime, no engine calls, no
 * suite imports, all writes inside a temp dir.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVAL_DRAFT_MARKER, renderEvalTemplate } from "./eval-convention";
import { runEvalCommand, runEvalManagementCli, evalUsage } from "./evals-cli";

let tempDir: string;
let logs: string[];
let errors: string[];

function runtime(overrides: Record<string, unknown> = {}) {
  return {
    cwd: tempDir,
    isTTY: false,
    log: (m: string) => logs.push(m),
    error: (m: string) => errors.push(m),
    ...overrides,
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mdflow-evals-cli-"));
  logs = [];
  errors = [];
  // Point the ledger away from the developer's real trust ledger.
  process.env.MDFLOW_EVAL_RESULTS = join(tempDir, "ledger.json");
});

afterEach(() => {
  delete process.env.MDFLOW_EVAL_RESULTS;
  rmSync(tempDir, { recursive: true, force: true });
});

function writeFlow(name: string, body = "Say hello.\n"): string {
  const path = join(tempDir, name);
  // Frontmatter marks the fixture as a FLOW (not a document) under the
  // runtime document-vs-flow rule that list/coverage enumeration reuses.
  writeFileSync(path, `---\ndescription: fixture flow\n---\n\n${body}`);
  return path;
}

describe("runEvalCommand routing", () => {
  test("--help with no positionals prints the combined usage", async () => {
    expect(await runEvalCommand(["--help"], runtime())).toBe(0);
    expect(logs.join("\n")).toContain("add|list|remove|coverage");
    expect(logs.join("\n")).toContain("fail-closed");
  });

  test("management actions route to the management CLI", async () => {
    writeFlow("flow.md");
    expect(await runEvalCommand(["add", "flow.md"], runtime())).toBe(0);
    expect(existsSync(join(tempDir, "flow.eval.ts"))).toBe(true);
  });

  test("unknown management action falls through to the runner and fails on a missing flow", async () => {
    const code = await runEvalCommand(["definitely-not-a-flow.md"], runtime());
    expect(code).toBe(1);
  });
});

describe("md eval add", () => {
  test("creates a draft suite with inferred recipes", async () => {
    writeFlow("piped.md", "Uses {{ _stdin }} here.\n");
    expect(await runEvalManagementCli(["add", "piped.md"], runtime())).toBe(0);
    const suite = readFileSync(join(tempDir, "piped.eval.ts"), "utf8");
    expect(suite).toContain("mdflow:case:start stdin");
    expect(suite).toContain(EVAL_DRAFT_MARKER);
    expect(logs.join("\n")).toContain("fail-closed DRAFT");
  });

  test("explicit recipes override inference and extend surgically", async () => {
    writeFlow("flow.md");
    expect(await runEvalManagementCli(["add", "flow.md", "output"], runtime())).toBe(0);
    expect(await runEvalManagementCli(["add", "flow.md", "nonzero", "output"], runtime())).toBe(0);
    const suite = readFileSync(join(tempDir, "flow.eval.ts"), "utf8");
    expect(suite).toContain("mdflow:case:start output");
    expect(suite).toContain("mdflow:case:start nonzero");
    expect(logs.join("\n")).toContain("Extended flow.eval.ts with: nonzero");
  });

  test("re-adding existing recipes is a no-op", async () => {
    writeFlow("flow.md");
    await runEvalManagementCli(["add", "flow.md", "output"], runtime());
    expect(await runEvalManagementCli(["add", "flow.md", "output"], runtime())).toBe(0);
    expect(logs.join("\n")).toContain("Nothing to do");
  });

  test("unknown recipe lists the valid ones", async () => {
    writeFlow("flow.md");
    expect(await runEvalManagementCli(["add", "flow.md", "nope"], runtime())).toBe(1);
    expect(errors.join("\n")).toContain('Unknown eval recipe "nope"');
    expect(errors.join("\n")).toContain("stochastic");
  });

  test("a hand-rewritten suite without markers fails loudly on extension", async () => {
    writeFlow("hand.md");
    writeFileSync(
      join(tempDir, "hand.eval.ts"),
      `export default [{ name: "real", check: () => null }];\n`
    );
    expect(await runEvalManagementCli(["add", "hand.md", "stdin"], runtime())).toBe(1);
    expect(errors.join("\n")).toContain("Cannot extend");
  });

  test("missing flow and non-markdown targets fail clearly", async () => {
    expect(await runEvalManagementCli(["add", "ghost.md"], runtime())).toBe(1);
    expect(errors.join("\n")).toContain("Flow file not found");
    writeFileSync(join(tempDir, "not-a-flow.txt"), "x");
    expect(await runEvalManagementCli(["add", "not-a-flow.txt"], runtime())).toBe(1);
    expect(errors.join("\n")).toContain("Not a markdown flow file");
  });
});

describe("md eval list", () => {
  test("missing suite reports Unverified with the add hint", async () => {
    writeFlow("bare.md");
    expect(await runEvalManagementCli(["list", "bare.md"], runtime())).toBe(0);
    const text = logs.join("\n");
    expect(text).toContain("Verdict: Unverified");
    expect(text).toContain("no sibling eval suite");
    expect(text).toContain("md eval add bare.md");
  });

  test("draft suite reports Unverified with draft ids", async () => {
    writeFlow("draft.md");
    writeFileSync(join(tempDir, "draft.eval.ts"), renderEvalTemplate(["output"]));
    expect(await runEvalManagementCli(["list", "draft.md"], runtime())).toBe(0);
    const text = logs.join("\n");
    expect(text).toContain("Verdict: Unverified");
    expect(text).toContain("draft assertions remain");
  });

  test("--json emits exactly one machine-readable object", async () => {
    writeFlow("bare.md");
    expect(await runEvalManagementCli(["list", "bare.md", "--json"], runtime())).toBe(0);
    expect(logs.length).toBe(1);
    const payload = JSON.parse(logs[0]!);
    expect(payload.type).toBe("eval.status");
    expect(payload.protocolVersion).toBe(1);
    expect(payload.verdict).toBe("Unverified");
  });

  test("directory listing scans every flow and reports full cardinality", async () => {
    writeFlow("a.md");
    writeFlow("b.md");
    writeFileSync(join(tempDir, "b.eval.ts"), `export default [{ name: "real", check: () => null }];\n`);
    expect(await runEvalManagementCli(["list", "."], runtime())).toBe(0);
    const text = logs.join("\n");
    expect(text).toContain("a.md");
    expect(text).toContain("b.md");
    expect(text).toContain("Scanned 2/2 flows. No result cap.");
  });
});

describe("md eval remove", () => {
  test("removes one managed block and keeps the rest", async () => {
    writeFlow("flow.md");
    await runEvalManagementCli(["add", "flow.md", "output", "stdin"], runtime());
    expect(await runEvalManagementCli(["remove", "flow.md", "stdin"], runtime())).toBe(0);
    const suite = readFileSync(join(tempDir, "flow.eval.ts"), "utf8");
    expect(suite).toContain("mdflow:case:start output");
    expect(suite).not.toContain("mdflow:case:start stdin");
    expect(logs.join("\n")).toContain("Managed cases remaining: output");
  });

  test("whole-file deletion requires --yes off a TTY", async () => {
    writeFlow("flow.md");
    await runEvalManagementCli(["add", "flow.md"], runtime());
    expect(await runEvalManagementCli(["remove", "flow.md"], runtime())).toBe(1);
    expect(existsSync(join(tempDir, "flow.eval.ts"))).toBe(true);
    expect(await runEvalManagementCli(["remove", "flow.md", "--yes"], runtime())).toBe(0);
    expect(existsSync(join(tempDir, "flow.eval.ts"))).toBe(false);
  });

  test("cancelled TTY confirmation keeps the file", async () => {
    writeFlow("flow.md");
    await runEvalManagementCli(["add", "flow.md"], runtime());
    const code = await runEvalManagementCli(
      ["remove", "flow.md"],
      runtime({ isTTY: true, promptConfirm: async () => false })
    );
    expect(code).toBe(1);
    expect(existsSync(join(tempDir, "flow.eval.ts"))).toBe(true);
    expect(logs.join("\n")).toContain("Cancelled");
  });

  test("removing a nonexistent block fails rather than guessing", async () => {
    writeFlow("flow.md");
    await runEvalManagementCli(["add", "flow.md", "output"], runtime());
    expect(await runEvalManagementCli(["remove", "flow.md", "stdin"], runtime())).toBe(1);
    expect(errors.join("\n")).toContain("no removable managed case");
  });

  test("no suite is a friendly no-op", async () => {
    writeFlow("flow.md");
    expect(await runEvalManagementCli(["remove", "flow.md", "--yes"], runtime())).toBe(0);
    expect(logs.join("\n")).toContain("nothing to remove");
  });
});

describe("md eval coverage", () => {
  test("fails on uncovered flows and passes with a baseline", async () => {
    writeFlow("naked.md");
    expect(await runEvalManagementCli(["coverage", "."], runtime())).toBe(1);
    expect(logs.join("\n")).toContain("uncovered flow: naked.md");

    writeFileSync(
      join(tempDir, ".mdflow-eval-baseline.json"),
      JSON.stringify({ schemaVersion: 1, uncovered: { "naked.md": "debt" } })
    );
    logs = [];
    expect(await runEvalManagementCli(["coverage", "."], runtime())).toBe(0);
    expect(logs.join("\n")).toContain("Coverage ratchet holds.");
  });

  test("--json reports the full machine-readable ledger", async () => {
    writeFlow("naked.md");
    expect(await runEvalManagementCli(["coverage", ".", "--json"], runtime())).toBe(1);
    const payload = JSON.parse(logs[0]!);
    expect(payload.type).toBe("eval.coverage");
    expect(payload.scanned).toBe(1);
    expect(payload.ok).toBe(false);
  });

  test("an explicit missing baseline path is an error, not silence", async () => {
    writeFlow("naked.md");
    expect(
      await runEvalManagementCli(["coverage", ".", "--baseline", "ghost.json"], runtime())
    ).toBe(1);
    expect(errors.join("\n")).toContain("baseline not found");
  });
});

describe("usage", () => {
  test("usage names every surface and its cost", () => {
    const usage = evalUsage();
    expect(usage).toContain("PAID");
    expect(usage).toContain("LOCAL WRITE");
    expect(usage).toContain("FREE");
    expect(usage).toContain("coverage");
  });
});
