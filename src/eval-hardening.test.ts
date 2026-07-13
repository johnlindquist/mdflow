/**
 * Regression tests for the Oracle critique fixes (2026-07-11): resolved eval
 * environment, ledger split + fail-closed reads, lock hardening, case
 * materialization, sealed fingerprints, harness accounting, strict CLI
 * grammar, marker scoping, bounded fingerprinting, coverage universe, and
 * registry/remote sidecar trust boundaries.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  EvalInconclusiveError,
  buildVerificationFingerprint,
  materializeEvalCases,
  readEvalLedger,
  recordEvalResult,
  resolveEvalSuitePath,
  runEvalCli,
  runEvalSuite,
  type EvalCase,
  type EvalLedgerEntry,
  type FlowRunner,
} from "./evals";
import {
  classifyEvalVerdict,
  detectDraftCaseIds,
  inspectEvalCoverage,
  parseManagedEvalCases,
  renderEvalTemplate,
} from "./eval-convention";
import { withAtomicFileLock } from "./evolution-store";
import { resolveHooksFile } from "./hooks";
import { installAgent } from "./registry";
import { scaffoldStarterFlows } from "./init";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mdflow-eval-hardening-"));
  process.env.MDFLOW_EVAL_RESULTS = join(tempDir, "ledger.json");
});

afterEach(() => {
  delete process.env.MDFLOW_EVAL_RESULTS;
  rmSync(tempDir, { recursive: true, force: true });
});

const okRunner: FlowRunner = async () => ({ stdout: "ok", stderr: "", exitCode: 0 });

function writeFlow(name: string, body = "---\ndescription: fixture\n---\n\nSay hello.\n"): string {
  const path = join(tempDir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
}

function passingCase(name = "passes"): EvalCase {
  return { name, check: () => null };
}

describe("resolved eval environment (C1)", () => {
  test("the eval child inherits MDFLOW_CONFIG_CWD pointing at the flow's home, not the sandbox", async () => {
    const flow = writeFlow("flow.md");
    const seenEnvs: Array<Record<string, string> | undefined> = [];
    const runner: FlowRunner = async (spec) => {
      seenEnvs.push(spec.env);
      return { stdout: "ok", stderr: "", exitCode: 0 };
    };
    await runEvalSuite({ flowPath: flow, cases: [passingCase()], runFlow: runner, noLedger: true });
    expect(seenEnvs).toHaveLength(1);
    expect(seenEnvs[0]?.MDFLOW_CONFIG_CWD).toBe(tempDir);
  });

  test("a child md process loads project config from MDFLOW_CONFIG_CWD, not its sandbox cwd", async () => {
    // Project A owns the flow and a config that stamps a marker model;
    // the child runs from sandbox B (like an eval workspace).
    const projectDir = join(tempDir, "project-a");
    const sandboxDir = join(tempDir, "sandbox-b");
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(sandboxDir, { recursive: true });
    writeFileSync(join(projectDir, ".mdflow.yaml"), "commands:\n  claude:\n    model: smoke-config-model\n");
    const flow = join(projectDir, "task.claude.md");
    writeFileSync(flow, "---\ndescription: fixture\n---\n\nSay hello.\n");

    const run = async (extraEnv: Record<string, string>) => {
      const proc = Bun.spawn(
        ["bun", "run", join(import.meta.dir, "index.ts"), flow, "--_dry-run"],
        {
          cwd: sandboxDir,
          env: { ...process.env, ...extraEnv },
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return `${stdout}\n${stderr}`;
    };

    const withPointer = await run({ MDFLOW_CONFIG_CWD: projectDir });
    expect(withPointer).toContain("smoke-config-model");
    const withoutPointer = await run({});
    expect(withoutPointer).not.toContain("smoke-config-model");
  }, 30_000);

  test("the injected config cwd is a trust pointer — caller env can never override it", async () => {
    // MDFLOW_CONFIG_CWD binds the child's config resolution to the project
    // the receipt fingerprints. If a caller-supplied env var could override
    // it, suite-adjacent code could point the child at a different project
    // than the one being verified (2026-07-11 hardening audit, finding 4).
    const flow = writeFlow("flow.md");
    let seen: Record<string, string> | undefined;
    const runner: FlowRunner = async (spec) => {
      seen = spec.env;
      return { stdout: "ok", stderr: "", exitCode: 0 };
    };
    await runEvalSuite({
      flowPath: flow,
      cases: [passingCase()],
      runFlow: runner,
      noLedger: true,
      env: { MDFLOW_CONFIG_CWD: "/elsewhere", OTHER_VAR: "kept" },
    });
    expect(seen?.MDFLOW_CONFIG_CWD).not.toBe("/elsewhere");
    expect(seen?.MDFLOW_CONFIG_CWD).toBeTruthy();
    expect(seen?.OTHER_VAR).toBe("kept");
  });
});

describe("ledger split (H3)", () => {
  const fullReceipt = (flow: string, fingerprint: string): Omit<EvalLedgerEntry, "lastCleanAt" | "lastFullRunAt" | "latestRun" | "schemaVersion"> => ({
    flow,
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

  test("a filtered run never clobbers the full receipt", () => {
    const flow = writeFlow("flow.md");
    const suite = resolveEvalSuitePath(flow);
    const ledgerPath = join(tempDir, "split-ledger.json");
    recordEvalResult(suite, fullReceipt(flow, "abc"), ledgerPath);

    recordEvalResult(
      suite,
      {
        flow,
        pass: 0,
        fail: 1,
        total: 1,
        lastRunAt: "2026-07-11T00:00:00.000Z",
        full: false,
        inconclusive: 0,
        flaky: 0,
      },
      ledgerPath
    );

    const entry = readEvalLedger(ledgerPath)[suite]!;
    // Full-run proof fields are intact…
    expect(entry.full).toBe(true);
    expect(entry.pass).toBe(2);
    expect(entry.total).toBe(2);
    expect(entry.currentClean).toBe(true);
    expect(entry.verification?.fingerprint).toBe("abc");
    expect(entry.lastRunFingerprint).toBe("abc");
    expect(entry.lastFullRunAt).toBe("2026-07-10T00:00:00.000Z");
    // …while the filtered run is visible as display data.
    expect(entry.latestRun).toMatchObject({ full: false, pass: 0, fail: 1, total: 1 });
  });

  test("a corrupt ledger aborts the write instead of being replaced", () => {
    const ledgerPath = join(tempDir, "corrupt.json");
    writeFileSync(ledgerPath, "{not json");
    const flow = writeFlow("flow.md");
    expect(() =>
      recordEvalResult(resolveEvalSuitePath(flow), fullReceipt(flow, "abc"), ledgerPath)
    ).toThrow(/corrupt/);
    expect(readFileSync(ledgerPath, "utf8")).toBe("{not json");
  });

  test("only ENOENT reads as an empty ledger", () => {
    expect(readEvalLedger(join(tempDir, "missing.json"))).toEqual({});
    const bad = join(tempDir, "bad.json");
    writeFileSync(bad, "[]");
    expect(() => readEvalLedger(bad)).toThrow(/corrupt/);
  });
});

describe("lock hardening (H4)", () => {
  test("a fresh zero-byte lock is busy, not stale", () => {
    const target = join(tempDir, "state.json");
    const fd = openSync(`${target}.lock`, "wx");
    closeSync(fd);
    expect(() => withAtomicFileLock(target, () => 1, 60_000)).toThrow(/busy/);
  });

  test("an old zero-byte lock is stale and can be taken over", () => {
    const target = join(tempDir, "state.json");
    const lockPath = `${target}.lock`;
    const fd = openSync(lockPath, "wx");
    closeSync(fd);
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(lockPath, past, past);
    expect(withAtomicFileLock(target, () => "ran", 60_000)).toBe("ran");
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe("case materialization (H5)", () => {
  test("getter-backed metadata is read exactly once", () => {
    let reads = 0;
    const sneaky = {
      name: "sneaky",
      check: () => null,
      get repetitions() {
        reads += 1;
        return reads === 1 ? 1 : 100;
      },
    };
    const [materialized] = materializeEvalCases([sneaky], "suite.eval.ts");
    expect(materialized!.repetitions).toBe(1);
    expect(materialized!.repetitions).toBe(1);
    expect(reads).toBe(1);
    expect(Object.isFrozen(materialized)).toBe(true);
  });

  test("cases without a check function are rejected", () => {
    expect(() => materializeEvalCases([{ name: "x" }], "suite.eval.ts")).toThrow(/check function/);
    expect(() => materializeEvalCases([], "suite.eval.ts")).toThrow(/no cases/);
  });
});

describe("sealed fingerprints (H6)", () => {
  test("a mid-run input change withholds the receipt (EVAL_INPUTS_CHANGED)", async () => {
    const flow = writeFlow("sealed.md");
    const suite = resolveEvalSuitePath(flow);
    writeFileSync(suite, "export default [];\n");
    const ledgerPath = join(tempDir, "sealed-ledger.json");

    const outcome = await runEvalSuite({
      flowPath: flow,
      cases: [passingCase()],
      runFlow: okRunner,
      ledgerPath,
      sealedFingerprint: "fingerprint-from-before-the-suite-changed-things",
      log: () => {},
    });

    expect(outcome.inputsChanged).toBe(true);
    expect(outcome.failures.some((line) => line.includes("EVAL_INPUTS_CHANGED"))).toBe(true);
    const entry = Object.values(readEvalLedger(ledgerPath))[0]!;
    expect(entry.currentClean).toBe(false);
    expect(entry.verification).toBeUndefined();
  });

  test("an unchanged sealed fingerprint records the receipt normally", async () => {
    const flow = writeFlow("stable.md");
    const suite = resolveEvalSuitePath(flow);
    writeFileSync(suite, "export default [];\n");
    const ledgerPath = join(tempDir, "stable-ledger.json");
    const cases = [passingCase()];
    const sealed = await buildVerificationFingerprint(flow, suite, cases);

    const outcome = await runEvalSuite({
      flowPath: flow,
      cases,
      runFlow: okRunner,
      ledgerPath,
      sealedFingerprint: sealed.fingerprint,
      log: () => {},
    });

    expect(outcome.inputsChanged).toBeUndefined();
    const entry = Object.values(readEvalLedger(ledgerPath))[0]!;
    expect(entry.currentClean).toBe(true);
    expect(entry.verification?.fingerprint).toBe(sealed.fingerprint);
  });
});

describe("harness accounting (M11)", () => {
  test("a failed setup never counts as a paid invocation", async () => {
    const flow = writeFlow("setup-fail.md");
    let flowRuns = 0;
    const runner: FlowRunner = async () => {
      flowRuns += 1;
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const outcome = await runEvalSuite({
      flowPath: flow,
      cases: [
        {
          name: "broken fixture",
          setup: () => {
            throw new Error("fixture exploded");
          },
          check: () => null,
        },
      ],
      runFlow: runner,
      noLedger: true,
      log: () => {},
    });
    expect(flowRuns).toBe(0);
    expect(outcome.invocations).toBe(0);
    expect(outcome.fail).toBe(1);
  });

  test("EvalInconclusiveError and INCONCLUSIVE: prefixed throws mark trials inconclusive, not failing", async () => {
    const flow = writeFlow("prereq.md");
    const outcome = await runEvalSuite({
      flowPath: flow,
      cases: [
        {
          name: "typed prerequisite",
          setup: () => {
            throw new EvalInconclusiveError("git unavailable");
          },
          check: () => null,
        },
        {
          name: "prefixed prerequisite",
          setup: () => {
            throw new Error("INCONCLUSIVE: git is not on PATH");
          },
          check: () => null,
        },
      ],
      runFlow: okRunner,
      noLedger: true,
      log: () => {},
    });
    expect(outcome.inconclusive).toBe(2);
    expect(outcome.fail).toBe(0);
    expect(outcome.invocations).toBe(0);
  });

  test("an unreachable quorum is a fail even when some trials were inconclusive", async () => {
    const flow = writeFlow("quorum.md");
    let trial = 0;
    const runner: FlowRunner = async () => {
      trial += 1;
      // Trial 1+2 behaviorally fail; trial 3 times out (inconclusive).
      if (trial === 3) return { stdout: "", stderr: "", exitCode: 1, timedOut: true };
      return { stdout: "wrong", stderr: "", exitCode: 0 };
    };
    const outcome = await runEvalSuite({
      flowPath: flow,
      cases: [
        {
          name: "needs all three",
          repetitions: 3,
          quorum: 3,
          check: ({ stdout }) => (stdout === "right" ? null : "wrong output"),
        },
      ],
      runFlow: runner,
      noLedger: true,
      log: () => {},
    });
    expect(outcome.fail).toBe(1);
    expect(outcome.inconclusive).toBe(0);
  });

  test("a met quorum passes even alongside an inconclusive trial", async () => {
    const flow = writeFlow("quorum-pass.md");
    let trial = 0;
    const runner: FlowRunner = async () => {
      trial += 1;
      if (trial === 3) return { stdout: "", stderr: "", exitCode: 1, timedOut: true };
      return { stdout: "right", stderr: "", exitCode: 0 };
    };
    const outcome = await runEvalSuite({
      flowPath: flow,
      cases: [
        {
          name: "two of three",
          repetitions: 3,
          quorum: 2,
          check: ({ stdout }) => (stdout === "right" ? null : "wrong output"),
        },
      ],
      runFlow: runner,
      noLedger: true,
      log: () => {},
    });
    expect(outcome.pass).toBe(1);
  });
});

describe("strict CLI grammar (M12)", () => {
  function captureJson(run: () => Promise<number>): Promise<{ code: number; lines: string[] }> {
    const lines: string[] = [];
    const prior = console.log;
    console.log = (line: unknown) => lines.push(String(line));
    return run()
      .then((code) => ({ code, lines }))
      .finally(() => {
        console.log = prior;
      });
  }

  test("--filter without a value is a hard error, never a silent full run", async () => {
    const flow = writeFlow("grammar.md");
    writeFileSync(resolveEvalSuitePath(flow), "export default [];\n");
    const { code, lines } = await captureJson(() => runEvalCli([flow, "--filter", "--json"]));
    expect(code).toBe(1);
    const error = JSON.parse(lines[0]!);
    expect(error.reasonCode).toBe("FILTER_VALUE_REQUIRED");
    expect(error.protocolVersion).toBe(1);
  });

  test("--filter=value and unknown-flag rejection both work", async () => {
    const flow = writeFlow("grammar2.md");
    writeFileSync(
      resolveEvalSuitePath(flow),
      `export default [{ name: "alpha case", check: () => null }, { name: "beta case", check: () => null }];\n`
    );
    const plan = await captureJson(() => runEvalCli([flow, "--plan", "--json", "--filter=alpha"]));
    expect(plan.code).toBe(0);
    const planPayload = JSON.parse(plan.lines.find((l) => l.includes('"eval.plan"'))!);
    expect(planPayload.filter).toBe("alpha");
    expect(planPayload.selectedCount).toBe(1);
    expect(planPayload.engine).toBeString();
    expect(planPayload.protocolVersion).toBe(1);

    const unknown = await captureJson(() => runEvalCli([flow, "--json", "--frobnicate"]));
    expect(unknown.code).toBe(1);
    expect(JSON.parse(unknown.lines[0]!).reasonCode).toBe("UNKNOWN_OPTION");

    const extra = await captureJson(() => runEvalCli([flow, "extra-positional", "--json"]));
    expect(extra.code).toBe(1);
    expect(JSON.parse(extra.lines[0]!).reasonCode).toBe("UNEXPECTED_ARGUMENT");
  });
});

describe("marker scoping (M13)", () => {
  test("re-indented markers still parse", () => {
    const indented = renderEvalTemplate(["output"])
      .split("\n")
      .map((line) => (line.includes("mdflow:case:") ? `    ${line.trim()}` : line))
      .join("\n");
    const parsed = parseManagedEvalCases(indented);
    expect(parsed.blocks.map((block) => block.id)).toEqual(["output"]);
    expect(parsed.insertMarkerCount).toBe(1);
  });

  test("a draft-marker mention outside the cases array does not block runs", () => {
    const suite = `/**
 * Docs may mention MDFLOW_DRAFT_CASE freely — that is not a draft case.
 */
import type { EvalCase } from "mdflow/src/evals";

const cases: EvalCase[] = [
  { name: "real case", check: () => null },
];

export default cases;
`;
    expect(detectDraftCaseIds(suite)).toEqual([]);
  });

  test("a sentinel inside the cases array still fails closed", () => {
    const suite = `import type { EvalCase } from "mdflow/src/evals";

const cases: EvalCase[] = [
  { name: "still a draft", check: () => "MDFLOW_DRAFT_CASE: replace me" },
];

export default cases;
`;
    expect(detectDraftCaseIds(suite)).toEqual(["(unmanaged)"]);
  });
});

describe("bounded passive fingerprinting (H8)", () => {
  test("a quoted relative string in suite code is not treated as an import", async () => {
    const flow = writeFlow("strings.md");
    const suite = resolveEvalSuitePath(flow);
    const bystander = join(tempDir, "bystander.txt");
    writeFileSync(bystander, "original");
    writeFileSync(
      suite,
      `const note = "./bystander.txt";\nexport default [{ name: "x", check: () => null }];\n`
    );
    const before = await buildVerificationFingerprint(flow, suite, [passingCase("x")]);
    writeFileSync(bystander, "changed");
    const after = await buildVerificationFingerprint(flow, suite, [passingCase("x")]);
    expect(after.fingerprint).toBe(before.fingerprint);
  });

  test("verdicts distinguish unknown freshness from a proven diff", () => {
    const entry: EvalLedgerEntry = {
      flow: "/x.md",
      pass: 1,
      fail: 0,
      total: 1,
      lastRunAt: "2026-07-10T00:00:00.000Z",
      full: true,
      currentClean: true,
      lastRunFingerprint: "abc",
      verification: {
        fingerprint: "abc",
        flowHash: "f",
        suiteHash: "s",
        configHash: "c",
        mdflowVersion: "1",
        engine: "claude",
        engineSource: "filename",
        caseIds: [],
        createdAt: "2026-07-10T00:00:00.000Z",
      },
    };
    const unknown = classifyEvalVerdict({
      suiteExists: true,
      inspectable: true,
      draft: false,
      plannedCases: 1,
      entry,
      currentFingerprint: undefined,
    });
    expect(unknown.verdict).toBe("Unverified");
    expect(unknown.reason).toContain("freshness");
    const diff = classifyEvalVerdict({
      suiteExists: true,
      inspectable: true,
      draft: false,
      plannedCases: 1,
      entry,
      currentFingerprint: "zzz",
    });
    expect(diff.verdict).toBe("Stale");
  });
});

describe("coverage universe (H9)", () => {
  test("a real changelog.md FLOW counts; a changelog document does not", async () => {
    writeFlow("changelog.md"); // has frontmatter → flow
    writeFileSync(join(tempDir, "notes.md"), "# Just a document\n\nNo frontmatter.\n");
    const report = await inspectEvalCoverage(tempDir);
    expect(report.scanned).toBe(1);
    expect(report.uncovered).toEqual(["changelog.md"]);
  });

  test("symlinked markdown is never scanned as a flow", async () => {
    const real = writeFlow("real.md");
    symlinkSync(real, join(tempDir, "link.md"));
    const report = await inspectEvalCoverage(tempDir);
    expect(report.scanned).toBe(1);
    expect(report.uncovered).toEqual(["real.md"]);
  });
});

describe("registry/remote sidecar trust (C2)", () => {
  test("convention hooks next to a remote/registry flow are rejected, not attached", () => {
    const flow = writeFlow("remote-flow.md");
    writeFileSync(join(tempDir, "remote-flow.hooks.ts"), "// planted\n");
    const resolved = resolveHooksFile({ flowPath: flow, isRemote: true });
    expect(resolved.kind).toBe("file");
    if (resolved.kind === "file") {
      expect(resolved.rejected).toContain("not trusted");
    }
    // Local flows keep convention discovery.
    const local = resolveHooksFile({ flowPath: flow });
    expect(local.kind).toBe("file");
    if (local.kind === "file") expect(local.rejected).toBeUndefined();
  });

  test("md install refuses a target with planted sidecars", async () => {
    const home = join(tempDir, "home");
    const registryDir = join(home, ".mdflow", "registry");
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(join(registryDir, "evil.hooks.ts"), "// planted\n");
    const fetchFn = (async () =>
      new Response("# a flow\n\nbody\n", { status: 200 })) as unknown as typeof fetch;
    await expect(
      installAgent("https://example.com/evil.md", { scope: "user", homeDir: home, cwd: tempDir, fetchFn })
    ).rejects.toThrow(/sidecar/);
    expect(existsSync(join(registryDir, "evil.md"))).toBe(false);
  });
});

describe("init same-transaction pairing (H7)", () => {
  test("a pre-existing flow never receives the catalog's shipped suite", () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(join(projectDir, "flows"), { recursive: true });
    writeFileSync(join(projectDir, "flows", "review.md"), "---\ndescription: mine\n---\n\nMy own review flow.\n");
    scaffoldStarterFlows(projectDir, "claude");
    expect(existsSync(join(projectDir, "flows", "review.eval.ts"))).toBe(false);
    // Catalog flows created fresh in the same run DO get their suites.
    expect(existsSync(join(projectDir, "flows", "changelog.md"))).toBe(true);
    expect(existsSync(join(projectDir, "flows", "changelog.eval.ts"))).toBe(true);
  });
});
