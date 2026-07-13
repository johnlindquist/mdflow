/**
 * Tests for the eval convention layer: template rendering, marker parsing,
 * surgical edits, recipe inference, the fail-closed verdict classifier, and
 * the coverage ratchet. All free — nothing here imports or executes suite
 * code and no engine is ever spawned.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EVAL_DRAFT_MARKER,
  EVAL_INSERT_MARKER,
  EVAL_RECIPES,
  classifyEvalVerdict,
  detectDraftCaseIds,
  inferEvalRecipes,
  insertEvalRecipes,
  inspectEvalCoverage,
  inspectEvalSuiteStatic,
  parseManagedEvalCases,
  removeManagedEvalCases,
  renderEvalTemplate,
  type EvalVerdictInput,
} from "./eval-convention";
import { inspectEvalSuitePlan, type EvalLedgerEntry } from "./evals";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mdflow-eval-convention-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeSuite(source: string, name = "flow.eval.ts"): string {
  const path = join(tempDir, name);
  writeFileSync(path, source);
  return path;
}

describe("renderEvalTemplate", () => {
  test("every recipe renders a statically plannable draft case", () => {
    const path = writeSuite(renderEvalTemplate([...EVAL_RECIPES]));
    const plan = inspectEvalSuitePlan(path);
    expect(plan.cases.length).toBe(EVAL_RECIPES.length);
    for (const evalCase of plan.cases) {
      expect(evalCase.name.startsWith("TODO:")).toBe(true);
    }
    const stochastic = plan.cases.find((c) => c.repetitions === 3);
    expect(stochastic?.quorum).toBe(2);
  });

  test("defaults to the output recipe and dedupes", () => {
    const source = renderEvalTemplate(["output", "output"]);
    expect(parseManagedEvalCases(source).blocks.map((b) => b.id)).toEqual(["output"]);
    expect(parseManagedEvalCases(renderEvalTemplate([])).blocks.map((b) => b.id)).toEqual([
      "output",
    ]);
  });

  test("every draft case carries the draft marker", () => {
    const source = renderEvalTemplate([...EVAL_RECIPES]);
    expect(detectDraftCaseIds(source)).toEqual([...EVAL_RECIPES]);
  });
});

describe("inferEvalRecipes", () => {
  test("maps body features to recipes deterministically", () => {
    expect(inferEvalRecipes("plain body")).toEqual(["output"]);
    expect(inferEvalRecipes("uses {{ _stdin }}")).toEqual(["stdin"]);
    expect(inferEvalRecipes("takes {{ _1 }}")).toEqual(["prompt"]);
    expect(inferEvalRecipes("lists {{ _args }}")).toEqual(["prompt"]);
    expect(inferEvalRecipes("runs !`git diff`")).toEqual(["fixture"]);
    expect(inferEvalRecipes("{{ _stdin }} and {{ _1 }} and !`ls`")).toEqual([
      "stdin",
      "prompt",
      "fixture",
    ]);
  });
});

describe("marker parsing and surgical edits", () => {
  test("insert adds fresh recipes before the single marker and is idempotent", () => {
    const source = renderEvalTemplate(["output"]);
    const first = insertEvalRecipes(source, ["stdin", "output"]);
    expect(first.added).toEqual(["stdin"]);
    const again = insertEvalRecipes(first.updated, ["stdin"]);
    expect(again.added).toEqual([]);
    expect(again.updated).toBe(first.updated);
    expect(parseManagedEvalCases(first.updated).blocks.map((b) => b.id)).toEqual([
      "output",
      "stdin",
    ]);
  });

  test("insert preserves unrelated hand-written code byte-for-byte", () => {
    const custom = renderEvalTemplate(["output"]).replace(
      "export default cases;",
      "function helper(): number {\n  return 42;\n}\nvoid helper;\n\nexport default cases;"
    );
    const { updated } = insertEvalRecipes(custom, ["stdin"]);
    expect(updated).toContain("function helper(): number {\n  return 42;\n}");
  });

  test("missing insert marker fails loudly", () => {
    const source = renderEvalTemplate(["output"]).replace(`${EVAL_INSERT_MARKER}\n`, "");
    expect(() => insertEvalRecipes(source, ["stdin"])).toThrow(/missing insertion marker/);
  });

  test("duplicate insert markers fail loudly", () => {
    const source = renderEvalTemplate(["output"]).replace(
      EVAL_INSERT_MARKER,
      `${EVAL_INSERT_MARKER}\n${EVAL_INSERT_MARKER}`
    );
    expect(() => insertEvalRecipes(source, ["stdin"])).toThrow(/expected exactly one/);
  });

  test("unbalanced markers fail loudly", () => {
    const source = renderEvalTemplate(["output"]).replace("  // mdflow:case:end output\n", "");
    expect(() => parseManagedEvalCases(source)).toThrow(/unterminated/);
  });

  test("remove deletes only the selected block", () => {
    const source = renderEvalTemplate(["output", "stdin", "nonzero"]);
    const updated = removeManagedEvalCases(source, ["stdin"]);
    expect(parseManagedEvalCases(updated).blocks.map((b) => b.id)).toEqual(["output", "nonzero"]);
    expect(updated).toContain("mdflow:case:start output");
    expect(updated).not.toContain("mdflow:case:start stdin");
  });

  test("removing an unknown id fails rather than guessing", () => {
    expect(() => removeManagedEvalCases(renderEvalTemplate(["output"]), ["stdin"])).toThrow(
      /no removable managed case/
    );
  });

  test("CRLF sources stay CRLF through insert and remove", () => {
    const crlf = renderEvalTemplate(["output"]).replace(/\n/g, "\r\n");
    const { updated } = insertEvalRecipes(crlf, ["stdin"]);
    expect(updated).toContain("\r\n");
    expect(updated.split("\r\n").length).toBeGreaterThan(10);
    const removed = removeManagedEvalCases(updated, ["output"]);
    expect(removed).toContain("\r\n");
    expect(removed).not.toContain("mdflow:case:start output");
  });
});

describe("inspectEvalSuiteStatic", () => {
  test("missing suite reports non-existence", () => {
    const inspection = inspectEvalSuiteStatic(join(tempDir, "none.md"));
    expect(inspection.exists).toBe(false);
    expect(inspection.draft).toBe(false);
  });

  test("hand-written suite without markers is plannable but not editable", () => {
    const flow = join(tempDir, "hand.md");
    writeFileSync(flow, "body");
    writeSuite(
      `export default [{ name: "real case", check: () => null }];\n`,
      "hand.eval.ts"
    );
    const inspection = inspectEvalSuiteStatic(flow);
    expect(inspection.plan?.cases.map((c) => c.name)).toEqual(["real case"]);
    expect(inspection.managedCaseIds).toEqual([]);
    expect(inspection.hasInsertMarker).toBe(false);
    expect(inspection.draft).toBe(false);
  });

  test("damaged markers with a draft marker fail closed as one draft", () => {
    const damaged = renderEvalTemplate(["output"]).replace("  // mdflow:case:end output\n", "");
    expect(detectDraftCaseIds(damaged)).toEqual(["(unmanaged)"]);
  });
});

describe("classifyEvalVerdict", () => {
  const cleanEntry = (fingerprint: string): EvalLedgerEntry => ({
    flow: "/repo/flows/x.md",
    pass: 2,
    fail: 0,
    total: 2,
    lastRunAt: "2026-07-10T00:00:00.000Z",
    full: true,
    currentClean: true,
    inconclusive: 0,
    flaky: 0,
    lastRunFingerprint: fingerprint,
    verification: {
      fingerprint,
      flowHash: "f",
      suiteHash: "s",
      configHash: "c",
      mdflowVersion: "1",
      engine: "claude",
      engineSource: "filename",
      caseIds: [],
      createdAt: "2026-07-10T00:00:00.000Z",
    },
  });

  const base: EvalVerdictInput = {
    suiteExists: true,
    inspectable: true,
    draft: false,
    plannedCases: 2,
    entry: cleanEntry("abc"),
    currentFingerprint: "abc",
  };

  test("only a complete current clean receipt is Verified", () => {
    expect(classifyEvalVerdict(base).verdict).toBe("Verified");
  });

  test("missing, uninspectable, and draft suites are Unverified", () => {
    expect(classifyEvalVerdict({ ...base, suiteExists: false }).verdict).toBe("Unverified");
    expect(classifyEvalVerdict({ ...base, inspectable: false }).verdict).toBe("Unverified");
    expect(classifyEvalVerdict({ ...base, draft: true }).verdict).toBe("Unverified");
  });

  test("fingerprint mismatch is Stale and beats any old outcome", () => {
    expect(classifyEvalVerdict({ ...base, currentFingerprint: "zzz" }).verdict).toBe("Stale");
    const oldFailing = { ...cleanEntry("abc"), fail: 2, pass: 0, currentClean: false };
    expect(
      classifyEvalVerdict({ ...base, entry: oldFailing, currentFingerprint: "zzz" }).verdict
    ).toBe("Stale");
  });

  test("current flaky beats current failing; inconclusive maps to Unverified", () => {
    expect(
      classifyEvalVerdict({ ...base, entry: { ...cleanEntry("abc"), flaky: 1, fail: 1 } }).verdict
    ).toBe("Flaky");
    expect(
      classifyEvalVerdict({ ...base, entry: { ...cleanEntry("abc"), fail: 1 } }).verdict
    ).toBe("Failing");
    const inconclusive = classifyEvalVerdict({
      ...base,
      entry: { ...cleanEntry("abc"), inconclusive: 1 },
    });
    expect(inconclusive.verdict).toBe("Unverified");
    expect(inconclusive.current).toBe(true);
  });

  test("filtered, legacy, and case-count-mismatched receipts are Unverified", () => {
    expect(
      classifyEvalVerdict({ ...base, entry: { ...cleanEntry("abc"), full: false } }).verdict
    ).toBe("Unverified");
    const legacy = { ...cleanEntry("abc") };
    delete legacy.verification;
    delete legacy.lastRunFingerprint;
    expect(classifyEvalVerdict({ ...base, entry: legacy }).verdict).toBe("Unverified");
    expect(classifyEvalVerdict({ ...base, plannedCases: 3 }).verdict).toBe("Unverified");
  });
});

describe("inspectEvalCoverage", () => {
  function writeFlow(relPath: string, body = "---\ndescription: fixture flow\n---\n\nflow body\n"): string {
    const path = join(tempDir, relPath);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body);
    return path;
  }

  test("covered flows pass; uncovered flows fail without a baseline entry", async () => {
    writeFlow("covered.md");
    writeSuite(`export default [{ name: "real", check: () => null }];\n`, "covered.eval.ts");
    writeFlow("naked.md");
    const report = await inspectEvalCoverage(tempDir);
    expect(report.scanned).toBe(2);
    expect(report.covered).toEqual(["covered.md"]);
    expect(report.uncovered).toEqual(["naked.md"]);
    expect(report.ok).toBe(false);
    expect(report.failures[0]).toContain("naked.md");
  });

  test("baseline entries excuse uncovered flows; zombies fail", async () => {
    writeFlow("legacy.md");
    writeFlow("covered.md");
    writeSuite(`export default [{ name: "real", check: () => null }];\n`, "covered.eval.ts");
    const okReport = await inspectEvalCoverage(tempDir, {
      schemaVersion: 1,
      uncovered: { "legacy.md": "migration debt" },
    });
    expect(okReport.ok).toBe(true);
    expect(okReport.baselined).toEqual(["legacy.md"]);

    const zombieCovered = await inspectEvalCoverage(tempDir, {
      schemaVersion: 1,
      uncovered: { "legacy.md": "debt", "covered.md": "stale excuse" },
    });
    expect(zombieCovered.ok).toBe(false);
    expect(zombieCovered.zombies.map((z) => z.path)).toEqual(["covered.md"]);

    const zombieMissing = await inspectEvalCoverage(tempDir, {
      schemaVersion: 1,
      uncovered: { "legacy.md": "debt", "gone.md": "vanished" },
    });
    expect(zombieMissing.ok).toBe(false);
    expect(zombieMissing.zombies.map((z) => z.path)).toEqual(["gone.md"]);
  });

  test("draft and unplannable suites count as uncovered", async () => {
    writeFlow("draft.md");
    writeSuite(renderEvalTemplate(["output"]), "draft.eval.ts");
    writeFlow("dynamic.md");
    writeSuite(`const c = [{ name: "x" + "y", check: () => null }];\nexport default c;\n`, "dynamic.eval.ts");
    const report = await inspectEvalCoverage(tempDir);
    expect(report.uncovered.sort()).toEqual(["draft.md", "dynamic.md"]);
    expect(report.covered).toEqual([]);
  });

  test("README-style docs are not counted as flows", async () => {
    writeFlow("README.md");
    writeFlow("real.md");
    const report = await inspectEvalCoverage(tempDir);
    expect(report.scanned).toBe(1);
    expect(report.uncovered).toEqual(["real.md"]);
  });
});

describe("draft marker constant", () => {
  test("the marker string matches what the runner refuses on", () => {
    expect(EVAL_DRAFT_MARKER).toBe("MDFLOW_DRAFT_CASE");
    expect(renderEvalTemplate(["output"])).toContain(EVAL_DRAFT_MARKER);
  });
});
