/**
 * Tests for the flow eval harness. All free: the flow runner is injected, so
 * no engine is ever spawned and no model turn is ever spent here.
 */

import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  resolveEvalSuitePath,
  runEvalSuite,
  recordEvalResult,
  readEvalLedger,
  type EvalCase,
  type FlowRunner,
} from "./evals";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mdflow-evals-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const okRunner: FlowRunner = async () => ({ stdout: "hello", stderr: "", exitCode: 0 });

describe("resolveEvalSuitePath", () => {
  test("maps flow files to colocated eval suites", () => {
    expect(resolveEvalSuitePath("flows/jq.md")).toBe("flows/jq.eval.ts");
    expect(resolveEvalSuitePath("flows/review.claude.md")).toBe("flows/review.claude.eval.ts");
  });
});

describe("runEvalSuite", () => {
  test("passing and failing checks are tallied with reasons", async () => {
    const cases: EvalCase[] = [
      { name: "passes", check: ({ stdout }) => (stdout.includes("hello") ? null : "no greeting") },
      { name: "fails", check: () => "wrong answer" },
    ];

    const lines: string[] = [];
    const outcome = await runEvalSuite({
      flowPath: "fake.md",
      cases,
      runFlow: okRunner,
      log: (l) => lines.push(l),
      noLedger: true,
    });

    expect(outcome.pass).toBe(1);
    expect(outcome.fail).toBe(1);
    expect(outcome.failures).toEqual(["fails: wrong answer"]);
    expect(lines.some((l) => l.includes("✓ passes"))).toBe(true);
    expect(lines.some((l) => l.includes("✗ fails: wrong answer"))).toBe(true);
  });

  test("setup runs inside the sandbox and check sees the same dir", async () => {
    let setupDir = "";
    const cases: EvalCase[] = [
      {
        name: "sandboxed",
        setup: (dir) => {
          setupDir = dir;
          writeFileSync(join(dir, "fixture.json"), "{}");
        },
        check: ({ dir }) => {
          if (dir !== setupDir) return "check ran in a different dir than setup";
          return existsSync(join(dir, "fixture.json")) ? null : "fixture missing";
        },
      },
    ];

    const outcome = await runEvalSuite({
      flowPath: "fake.md",
      cases,
      runFlow: okRunner,
      log: () => {},
      noLedger: true,
    });
    expect(outcome.pass).toBe(1);
    // Sandbox is cleaned up afterwards.
    expect(existsSync(setupDir)).toBe(false);
  });

  test("--filter selects cases by substring", async () => {
    const cases: EvalCase[] = [
      { name: "alpha one", check: () => null },
      { name: "beta two", check: () => "should not run" },
    ];

    const outcome = await runEvalSuite({
      flowPath: "fake.md",
      cases,
      runFlow: okRunner,
      filter: "alpha",
      log: () => {},
      noLedger: true,
    });
    expect(outcome.total).toBe(1);
    expect(outcome.fail).toBe(0);
  });

  test("a throwing check counts as a failure, not a crash", async () => {
    const cases: EvalCase[] = [
      {
        name: "explodes",
        check: () => {
          throw new Error("boom");
        },
      },
    ];

    const outcome = await runEvalSuite({
      flowPath: "fake.md",
      cases,
      runFlow: okRunner,
      log: () => {},
      noLedger: true,
    });
    expect(outcome.fail).toBe(1);
    expect(outcome.failures[0]).toContain("boom");
  });

  test("the runner receives prompt, stdin, and a sandbox cwd", async () => {
    let seen: Parameters<FlowRunner>[0] | undefined;
    const spyRunner: FlowRunner = async (spec) => {
      seen = spec;
      return { stdout: "", stderr: "", exitCode: 0 };
    };

    await runEvalSuite({
      flowPath: "fake.md",
      cases: [{ name: "spy", prompt: "top 3", stdin: "{}", check: () => null }],
      runFlow: spyRunner,
      log: () => {},
      noLedger: true,
    });

    expect(seen?.prompt).toBe("top 3");
    expect(seen?.stdin).toBe("{}");
    expect(seen?.cwd).toContain("mdflow-eval-");
  });
});

describe("runEvalCli guardrails", () => {
  test("a filter matching zero cases exits 1 instead of reporting a hollow pass", async () => {
    const { runEvalCli } = await import("./evals");
    const flow = join(tempDir, "guard.md");
    writeFileSync(flow, "---\nengine: echo\n---\nbody\n");
    writeFileSync(
      join(tempDir, "guard.eval.ts"),
      `const cases = [{ name: "only case", check: () => null }];\nexport default cases;\n`
    );

    const origError = console.error;
    const errors: string[] = [];
    console.error = (...a: unknown[]) => errors.push(a.join(" "));
    try {
      const code = await runEvalCli([flow, "--filter", "zzz-no-match"]);
      expect(code).toBe(1);
      expect(errors.join("\n")).toContain("no cases match");
    } finally {
      console.error = origError;
    }
  });

  test("missing suite exits 1 with the expected path in the message", async () => {
    const { runEvalCli } = await import("./evals");
    const flow = join(tempDir, "nosuite.md");
    writeFileSync(flow, "---\nengine: echo\n---\nbody\n");

    const origError = console.error;
    const errors: string[] = [];
    console.error = (...a: unknown[]) => errors.push(a.join(" "));
    try {
      const code = await runEvalCli([flow]);
      expect(code).toBe(1);
      expect(errors.join("\n")).toContain("nosuite.eval.ts");
    } finally {
      console.error = origError;
    }
  });
});

describe("trust ledger", () => {
  test("full clean run stamps lastCleanAt; later failure preserves it", () => {
    const ledger = join(tempDir, "eval-results.json");

    recordEvalResult(
      "flows/jq.eval.ts",
      { flow: "flows/jq.md", pass: 2, fail: 0, total: 2, lastRunAt: "2026-07-04T00:00:00Z", full: true },
      ledger
    );
    let entry = readEvalLedger(ledger)["flows/jq.eval.ts"]!;
    expect(entry.lastCleanAt).toBe("2026-07-04T00:00:00Z");

    recordEvalResult(
      "flows/jq.eval.ts",
      { flow: "flows/jq.md", pass: 1, fail: 1, total: 2, lastRunAt: "2026-07-05T00:00:00Z", full: true },
      ledger
    );
    entry = readEvalLedger(ledger)["flows/jq.eval.ts"]!;
    expect(entry.fail).toBe(1);
    expect(entry.lastCleanAt).toBe("2026-07-04T00:00:00Z");
  });

  test("filtered runs never stamp lastCleanAt", () => {
    const ledger = join(tempDir, "eval-results.json");
    recordEvalResult(
      "flows/x.eval.ts",
      { flow: "flows/x.md", pass: 1, fail: 0, total: 1, lastRunAt: "2026-07-04T00:00:00Z", full: false },
      ledger
    );
    expect(readEvalLedger(ledger)["flows/x.eval.ts"]!.lastCleanAt).toBeUndefined();
  });

  test("ledger write goes through runEvalSuite with suiteKey and ledgerPath", async () => {
    const ledger = join(tempDir, "suite-ledger.json");
    await runEvalSuite({
      flowPath: "fake.md",
      cases: [{ name: "ok", check: () => null }],
      runFlow: okRunner,
      log: () => {},
      suiteKey: "suites/fake.eval.ts",
      ledgerPath: ledger,
    });

    const entry = readEvalLedger(ledger)["suites/fake.eval.ts"]!;
    expect(entry.pass).toBe(1);
    expect(entry.full).toBe(true);
    expect(entry.lastCleanAt).toBeDefined();
  });
});

describe("repo-bound eval cases (explicit cwd)", () => {
  test("cwd resolves relative to the flow file and is never cleaned up", async () => {
    const flowsDir = join(tempDir, "flows");
    const repoMarker = join(tempDir, "repo-marker.txt");
    writeFileSync(join(tempDir, "keep.txt"), "still here");
    writeFileSync(repoMarker, "repo root");
    const flow = join(flowsDir, "scout.md");
    // flow lives in flows/, cwd ".." should be tempDir (the "repo root")
    const runner: FlowRunner = async ({ cwd }) => ({
      stdout: existsSync(join(cwd, "repo-marker.txt")) ? "IN_REPO" : "WRONG_DIR",
      stderr: "",
      exitCode: 0,
    });

    const { mkdirSync } = await import("fs");
    mkdirSync(flowsDir, { recursive: true });
    writeFileSync(flow, "---\ndescription: x\n---\nbody");

    const outcome = await runEvalSuite({
      flowPath: flow,
      cases: [{ name: "runs in repo", cwd: "..", check: ({ stdout }) => (stdout === "IN_REPO" ? null : stdout) }],
      runFlow: runner,
      log: () => {},
      noLedger: true,
    });

    expect(outcome.pass).toBe(1);
    // The real directory survives (no sandbox cleanup).
    expect(existsSync(join(tempDir, "keep.txt"))).toBe(true);
  });
});
