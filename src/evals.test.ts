/**
 * Tests for the flow eval harness. All free: the flow runner is injected, so
 * no engine is ever spawned and no flow invocation is ever spent here.
 */

import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  resolveEvalSuitePath,
  runEvalSuite,
  recordEvalResult,
  readEvalLedger,
  isVerificationCurrent,
  getEvalLedgerEntry,
  buildVerificationFingerprint,
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

  test("non-zero exits fail by default before a permissive check can pass", async () => {
    const outcome = await runEvalSuite({
      flowPath: "fake.md",
      cases: [{ name: "crashed", check: () => null }],
      runFlow: async () => ({ stdout: "looks fine", stderr: "boom", exitCode: 42 }),
      log: () => {},
      noLedger: true,
    });
    expect(outcome.pass).toBe(0);
    expect(outcome.fail).toBe(1);
    expect(outcome.cases[0]).toMatchObject({ status: "fail", exitCode: 42 });
  });

  test("classified provider/auth/environment exits are inconclusive, not behavioral failures", async () => {
    const outcome = await runEvalSuite({
      flowPath: "fake.md",
      cases: [{ name: "provider unavailable", check: () => null }],
      runFlow: async () => ({ stdout: "", stderr: "429 rate limit", exitCode: 1, failureClass: "provider" }),
      log: () => {},
      noLedger: true,
    });
    expect(outcome.fail).toBe(0);
    expect(outcome.inconclusive).toBe(1);
    expect(outcome.cases[0]?.trials[0]).toMatchObject({ status: "inconclusive", failureClass: "provider" });
  });

  test("allowNonZero is an explicit case-level escape hatch", async () => {
    const outcome = await runEvalSuite({
      flowPath: "fake.md",
      cases: [{ name: "expected nonzero", allowNonZero: true, check: ({ exitCode }) => exitCode === 2 ? null : "wrong exit" }],
      runFlow: async () => ({ stdout: "", stderr: "", exitCode: 2 }),
      log: () => {},
      noLedger: true,
    });
    expect(outcome.pass).toBe(1);
  });

  test("timeouts are inconclusive, never passing behavior", async () => {
    const outcome = await runEvalSuite({
      flowPath: "fake.md",
      cases: [{ name: "hangs", timeoutMs: 5, check: () => null }],
      runFlow: async () => ({ stdout: "", stderr: "", exitCode: 143, timedOut: true }),
      log: () => {},
      noLedger: true,
    });
    expect(outcome.inconclusive).toBe(1);
    expect(outcome.cases[0]?.status).toBe("inconclusive");
  });

  test("repetitions run independently and report their exact invocation count", async () => {
    let invocations = 0;
    const outcome = await runEvalSuite({
      flowPath: "fake.md",
      cases: [{ name: "three trials", repetitions: 3, check: () => null }],
      runFlow: async () => {
        invocations++;
        return { stdout: "ok", stderr: "", exitCode: 0 };
      },
      log: () => {},
      noLedger: true,
    });
    expect(invocations).toBe(3);
    expect(outcome.invocations).toBe(3);
    expect(outcome.cases[0]).toMatchObject({ repetitions: 3, quorum: 3, passCount: 3, flaky: false });
  });

  test("mixed quorum results are flagged as flaky and cannot become clean proof", async () => {
    let trial = 0;
    const outcome = await runEvalSuite({
      flowPath: "fake.md",
      cases: [{ name: "variable", kind: "stochastic", repetitions: 3, quorum: 2, check: ({ stdout }) => stdout === "pass" ? null : "variance" }],
      runFlow: async () => ({ stdout: ++trial === 2 ? "fail" : "pass", stderr: "", exitCode: 0 }),
      log: () => {},
      noLedger: true,
    });
    expect(outcome.pass).toBe(1);
    expect(outcome.flaky).toBe(1);
    expect(outcome.cases[0]).toMatchObject({ status: "pass", passCount: 2, flaky: true });
  });

  test("invalid repetition policies fail before spending an invocation", async () => {
    let invocations = 0;
    const outcome = await runEvalSuite({
      flowPath: "fake.md",
      cases: [{ name: "invalid", repetitions: 2, quorum: 3, check: () => null }],
      runFlow: async () => { invocations++; return { stdout: "", stderr: "", exitCode: 0 }; },
      log: () => {},
      noLedger: true,
    });
    expect(invocations).toBe(0);
    expect(outcome.fail).toBe(1);
  });
});

describe("runEvalCli guardrails", () => {
  test("help is successful and advertises planning and consent", async () => {
    const { runEvalCli } = await import("./evals");
    const prior = console.log;
    const output: string[] = [];
    console.log = (...args: unknown[]) => output.push(args.join(" "));
    try {
      expect(await runEvalCli(["--help"])).toBe(0);
    } finally {
      console.log = prior;
    }
    expect(output.join("\n")).toContain("--plan");
    expect(output.join("\n")).toContain("--yes");
  });

  test("JSON plan is one machine-readable object with repetition-aware cost", async () => {
    const { runEvalCli } = await import("./evals");
    const flow = join(tempDir, "repeat.md");
    writeFileSync(flow, "---\nengine: echo\nevolve:\n  mode: suggest\n  gate:\n    repetitions: 3\n---\nbody\n");
    writeFileSync(join(tempDir, "repeat.eval.ts"), `export default [{ name: "repeat", check: () => null }];\n`);
    const prior = console.log;
    const output: string[] = [];
    console.log = (...args: unknown[]) => output.push(args.join(" "));
    try {
      expect(await runEvalCli([flow, "--plan", "--json"])).toBe(0);
    } finally {
      console.log = prior;
    }
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!)).toMatchObject({ type: "eval.plan", selectedCount: 1, plannedInvocations: 3 });
  });

  test("plan and pre-consent refusal never execute suite top-level code", async () => {
    const { runEvalCli } = await import("./evals");
    const flow = join(tempDir, "untrusted.md");
    const marker = join(tempDir, "suite-executed.txt");
    writeFileSync(flow, "---\nengine: echo\n---\nbody\n");
    writeFileSync(join(tempDir, "untrusted.eval.ts"), `
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(marker)}, "executed");
      export default [{ name: "static case", check: () => null }];
    `);
    const prior = console.log;
    const priorError = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      expect(await runEvalCli([flow, "--plan"])).toBe(0);
      expect(existsSync(marker)).toBe(false);
      expect(await runEvalCli([flow])).toBe(1);
      expect(existsSync(marker)).toBe(false);
    } finally {
      console.log = prior;
      console.error = priorError;
    }
  });

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
  test("full clean run keeps historical lastCleanAt but a later failure invalidates current-clean state", () => {
    const ledger = join(tempDir, "eval-results.json");
    const verification = {
      fingerprint: "fingerprint",
      flowHash: "flow",
      suiteHash: "suite",
      configHash: "config",
      mdflowVersion: "test",
      engine: "test",
      engineSource: "frontmatter",
      caseIds: ["case"],
      createdAt: "2026-07-04T00:00:00Z",
    };

    recordEvalResult(
      "flows/jq.eval.ts",
      { flow: "flows/jq.md", pass: 2, fail: 0, total: 2, lastRunAt: "2026-07-04T00:00:00Z", full: true, verification },
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
    expect(entry.currentClean).toBe(false);
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

  test("a concurrent ledger writer gets a clear busy result instead of a lost update", () => {
    const ledger = join(tempDir, "busy-ledger.json");
    writeFileSync(`${ledger}.lock`, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    expect(() => recordEvalResult(
      "flows/x.eval.ts",
      { flow: "flows/x.md", pass: 0, fail: 1, total: 1, lastRunAt: new Date().toISOString(), full: true },
      ledger
    )).toThrow("State file is busy");
    expect(existsSync(ledger)).toBe(false);
  });

  test("ledger write goes through runEvalSuite with suiteKey and ledgerPath", async () => {
    const ledger = join(tempDir, "suite-ledger.json");
    const flow = join(tempDir, "fake.md");
    const suite = join(tempDir, "fake.eval.ts");
    writeFileSync(flow, "---\ndescription: test\n---\nbody\n");
    writeFileSync(suite, "export default [];\n");
    const cases: EvalCase[] = [{ name: "ok", check: () => null }];
    await runEvalSuite({
      flowPath: flow,
      cases,
      runFlow: okRunner,
      log: () => {},
      suiteKey: suite,
      ledgerPath: ledger,
    });

    const entry = getEvalLedgerEntry(suite, readEvalLedger(ledger))!;
    expect(entry.pass).toBe(1);
    expect(entry.full).toBe(true);
    expect(entry.lastCleanAt).toBeDefined();
    expect(entry.currentClean).toBe(true);
    expect(await isVerificationCurrent(flow, suite, cases, entry)).toBe(true);
    writeFileSync(flow, "---\ndescription: test\n---\nchanged\n");
    expect(await isVerificationCurrent(flow, suite, cases, entry)).toBe(false);
  });

  test("verification invalidates when a flow import changes", async () => {
    const ledger = join(tempDir, "import-ledger.json");
    const flow = join(tempDir, "importer.md");
    const context = join(tempDir, "context.txt");
    const suite = join(tempDir, "importer.eval.ts");
    writeFileSync(context, "first");
    writeFileSync(flow, "---\ndescription: test\n---\nUse @./context.txt\n");
    writeFileSync(suite, "export default [];\n");
    const cases: EvalCase[] = [{ name: "ok", check: () => null }];
    await runEvalSuite({ flowPath: flow, cases, runFlow: okRunner, log: () => {}, suiteKey: suite, ledgerPath: ledger });
    const entry = getEvalLedgerEntry(suite, readEvalLedger(ledger))!;
    expect(await isVerificationCurrent(flow, suite, cases, entry)).toBe(true);
    writeFileSync(context, "second");
    expect(await isVerificationCurrent(flow, suite, cases, entry)).toBe(false);
  });

  test("equivalent checkouts produce the same content receipt", async () => {
    const cases: EvalCase[] = [{ name: "ok", repetitions: 2, quorum: 2, check: () => null }];
    const fingerprints = [];
    const checkouts: Array<{ flow: string; suite: string }> = [];
    for (const name of ["checkout-a", "checkout-b"]) {
      const root = join(tempDir, name);
      const flows = join(root, "flows");
      mkdirSync(flows, { recursive: true });
      writeFileSync(join(root, ".git"), "test marker");
      writeFileSync(join(root, "context.txt"), "same context");
      const flow = join(flows, "review.md");
      const suite = join(flows, "review.eval.ts");
      writeFileSync(flow, "---\n_flow_id: flow_shared_checkout\nengine: echo\n---\nReview @../context.txt\n");
      writeFileSync(suite, "export default [];\n");
      fingerprints.push(await buildVerificationFingerprint(flow, suite, cases));
      checkouts.push({ flow, suite });
    }
    expect(fingerprints[0]?.fingerprint).toBe(fingerprints[1]?.fingerprint);
    const ledger = join(tempDir, "relocated-ledger.json");
    await runEvalSuite({
      flowPath: checkouts[0]!.flow,
      cases,
      runFlow: okRunner,
      suiteKey: checkouts[0]!.suite,
      ledgerPath: ledger,
      log: () => {},
    });
    const movedEntry = getEvalLedgerEntry(checkouts[1]!.suite, readEvalLedger(ledger));
    expect(movedEntry?.flowId).toBe("flow_shared_checkout");
    expect(await isVerificationCurrent(checkouts[1]!.flow, checkouts[1]!.suite, cases, movedEntry)).toBe(true);
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

describe("draft suites never spend", () => {
  test("a paid run refuses while MDFLOW_DRAFT_CASE markers remain; --plan stays free", async () => {
    const { renderEvalTemplate } = await import("./eval-convention");
    const { runEvalCli } = await import("./evals");
    const flow = join(tempDir, "draft-flow.md");
    writeFileSync(flow, "Say hello.\n");
    writeFileSync(join(tempDir, "draft-flow.eval.ts"), renderEvalTemplate(["output"]));

    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (line: unknown) => lines.push(String(line));
    try {
      // Free plan succeeds and reports the draft.
      expect(await runEvalCli([flow, "--plan", "--json"])).toBe(0);
      const plan = JSON.parse(lines.find((l) => l.includes('"eval.plan"'))!);
      expect(plan.draft).toBe(true);
      expect(plan.runnable).toBe(false);
      // Both draft mechanisms report: static `draft: true` metadata (by case
      // name) and the scoped sentinel scan (by managed block id).
      expect(plan.draftCaseIds).toContain("output");
      expect(plan.cases.every((c: { draft: boolean }) => c.draft)).toBe(true);

      // A consented paid run is refused before importing the suite.
      lines.length = 0;
      expect(await runEvalCli([flow, "--yes", "--json"])).toBe(1);
      const refusal = JSON.parse(lines.find((l) => l.includes('"eval.error"'))!);
      expect(refusal.reasonCode).toBe("DRAFT_SUITE");
    } finally {
      console.log = originalLog;
    }
  });
});

describe("fingerprints bind non-clean outcomes", () => {
  test("a first-ever flaky full run records a current fingerprint but is never clean", async () => {
    const flow = join(tempDir, "flaky-flow.md");
    const suite = resolveEvalSuitePath(flow);
    writeFileSync(flow, "Say hello.\n");
    writeFileSync(suite, "export default [];\n");
    const ledger = join(tempDir, "ledger.json");

    let trial = 0;
    const flakyRunner: FlowRunner = async () => ({
      stdout: ++trial % 2 === 1 ? "hello" : "goodbye",
      stderr: "",
      exitCode: 0,
    });
    const cases: EvalCase[] = [
      {
        name: "sometimes greets",
        repetitions: 2,
        quorum: 1,
        check: ({ stdout }) => (stdout.includes("hello") ? null : "no greeting"),
      },
    ];

    const outcome = await runEvalSuite({
      flowPath: flow,
      cases,
      runFlow: flakyRunner,
      ledgerPath: ledger,
      log: () => {},
    });
    expect(outcome.flaky).toBe(1);

    const entry = getEvalLedgerEntry(suite, readEvalLedger(ledger));
    expect(entry?.verification?.fingerprint).toBeDefined();
    expect(entry?.lastRunFingerprint).toBe(entry!.verification!.fingerprint);
    expect(entry?.currentClean).toBe(false);
    expect(entry?.lastCleanAt).toBeUndefined();

    // The canonical classifier sees a CURRENT Flaky verdict, not Stale.
    const { classifyEvalVerdict } = await import("./eval-convention");
    const current = await buildVerificationFingerprint(flow, suite, cases);
    const verdict = classifyEvalVerdict({
      suiteExists: true,
      inspectable: true,
      draft: false,
      plannedCases: 1,
      entry,
      currentFingerprint: current.fingerprint,
    });
    expect(verdict.verdict).toBe("Flaky");
    expect(verdict.current).toBe(true);
  });
});
