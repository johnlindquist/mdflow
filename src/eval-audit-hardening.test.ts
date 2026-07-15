/**
 * Regression tests for the SECOND Oracle audit (2026-07-11, session
 * `mdflow-eval-hardening-audit`, raw answer archived at
 * `.artifacts/2026-07-11-eval-hardening-audit-oracle.md`), which audited the
 * remediation of the first critique and found the paid-eval hardening was
 * bypassable through evolve, transient mutation, post-install sidecars, and
 * an incomplete fingerprint graph.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildVerificationEnvironmentFingerprint,
  buildVerificationFingerprint,
  importPreparedEvalSuite,
  inspectEvalSuitePlan,
  readEvalLedger,
  recordEvalResult,
  resolveEvalEnvironment,
  resolveEvalSuitePath,
  runEvalCli,
  runEvalSuite,
  type EvalCase,
  type EvalLedgerEntry,
  type FlowRunner,
} from "./evals";
import { runEvolve } from "./evolve";
import { runEvalManagementCli } from "./evals-cli";
import { isRegistryPath } from "./project-root";

let tempDir: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["MDFLOW_EVAL_RESULTS", "MDFLOW_EVIDENCE_FILE", "MDFLOW_EVOLUTION_HOME", "MDFLOW_RUNS_FILE"];

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mdflow-eval-audit-"));
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.MDFLOW_EVAL_RESULTS = join(tempDir, "ledger.json");
  process.env.MDFLOW_EVIDENCE_FILE = join(tempDir, "state", "evidence.jsonl");
  process.env.MDFLOW_EVOLUTION_HOME = join(tempDir, "state");
  process.env.MDFLOW_RUNS_FILE = join(tempDir, "state", "runs.jsonl");
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(tempDir, { recursive: true, force: true });
});

function write(path: string, content: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

const okRunner: FlowRunner = async () => ({ stdout: "ok", stderr: "", exitCode: 0 });

/* ── Finding 1: evolve was an unhardened second paid eval runner ─────────── */

describe("evolve runs through the shared paid preparation boundary (audit F1)", () => {
  test("a getter-backed repetitions case cannot overspend evolve's announced consent", async () => {
    const flow = write(join(tempDir, "repo", "color.md"), "---\ndescription: color\n---\nSay BLUE.\n");
    // A hostile suite: `repetitions` reads 1 for the first N reads (planning,
    // shape comparison, fingerprinting) and 50 once execution begins.
    write(
      join(tempDir, "repo", "color.eval.ts"),
      `let reads = 0;
export default [
  {
    name: "answers green",
    get repetitions() {
      reads += 1;
      return reads > 8 ? 50 : 1;
    },
    check: ({ stdout }: { stdout: string }) => (stdout.includes("GREEN") ? null : "expected GREEN"),
  },
];
`
    );
    // Materialization reads each property exactly ONCE and freezes it, so the
    // executed repetitions is whatever the plan announced — never 50.
    const staticPlan = inspectEvalSuitePlan(join(tempDir, "repo", "color.eval.ts"), 1);
    const cases = await importPreparedEvalSuite({
      suitePath: join(tempDir, "repo", "color.eval.ts"),
      policyRepetitions: 1,
      staticPlan,
    });
    let invocations = 0;
    const countingRunner: FlowRunner = async () => {
      invocations += 1;
      return { stdout: "GREEN", stderr: "", exitCode: 0 };
    };
    await runEvalSuite({ flowPath: flow, cases, runFlow: countingRunner, noLedger: true });
    expect(invocations).toBe(staticPlan.invocations);
    expect(invocations).toBeLessThanOrEqual(1);
  });

  test("evolve refuses a static draft suite before any paid work", async () => {
    const flow = write(join(tempDir, "repo", "color.md"), "---\ndescription: color\n---\nSay BLUE.\n");
    write(
      join(tempDir, "repo", "color.eval.ts"),
      `export default [
  { name: "draft case", draft: true, check: () => "MDFLOW_DRAFT_CASE: replace me" },
];
`
    );
    const { recordComplaint } = await import("./evolve");
    recordComplaint(flow, "blue is wrong");

    let drafts = 0;
    let runs = 0;
    const result = await runEvolve({
      flowPath: flow,
      draft: async () => {
        drafts += 1;
        return JSON.stringify({ body: "Say GREEN." });
      },
      runFlow: async () => {
        runs += 1;
        return { stdout: "GREEN", stderr: "", exitCode: 0 };
      },
      yes: true,
      log: () => {},
    });
    expect(result.decision.reasonCode).toBe("DRAFT_SUITE");
    expect(result.exitCode).toBe(1);
    expect(drafts).toBe(0);
    expect(runs).toBe(0);
  });

  test("evolve's workspace verification loads the copied project's root config", async () => {
    // A roster-shaped project: config at the root, flow under flows/.
    const projectDir = join(tempDir, "project");
    write(join(projectDir, ".mdflow.yaml"), "commands:\n  claude:\n    model: root-config-model\n");
    const flow = write(join(projectDir, "flows", "color.claude.md"), "---\ndescription: color\n---\nSay BLUE.\n");

    // The eval environment must resolve the PROJECT ROOT (where .mdflow.yaml
    // lives), not merely the flow's own directory — otherwise the eval child
    // and the fingerprint see a different config than a normal run.
    const environment = await resolveEvalEnvironment(flow);
    expect(environment.configCwd).toBe(projectDir);
    expect(environment.model).toBe("root-config-model");
  });
});

/* ── Finding 2: mutate-run-restore could mint a clean receipt ─────────────── */

describe("transient input mutation cannot mint a clean receipt (audit F2)", () => {
  test("a suite that swaps the flow for the run and restores it in check gets no receipt", async () => {
    const flow = write(join(tempDir, "flow.md"), "---\ndescription: fixture\n---\n\nORIGINAL.\n");
    const suite = write(join(tempDir, "flow.eval.ts"), "export default [];\n");
    const original = readFileSync(flow, "utf8");
    const environment = await resolveEvalEnvironment(flow);

    let childRan = false;
    const cases: EvalCase[] = [
      {
        name: "mutating case",
        setup: () => {
          // Swap the flow's bytes AFTER the seal, so the child would execute
          // content the receipt never described.
          writeFileSync(flow, "---\ndescription: fixture\n---\n\nALTERED.\n");
        },
        check: () => {
          // Restore, so the POST-RUN hash would match the seal and the old
          // end-of-run-only comparison would have been satisfied.
          writeFileSync(flow, original);
          return null;
        },
      },
    ];
    const seal = await buildVerificationFingerprint(flow, suite, cases, environment);

    const countingRunner: FlowRunner = async () => {
      childRan = true;
      return { stdout: "ok", stderr: "", exitCode: 0 };
    };
    const outcome = await runEvalSuite({
      flowPath: flow,
      cases,
      runFlow: countingRunner,
      environment,
      sealedFingerprint: seal.fingerprint,
      ledgerPath: join(tempDir, "ledger.json"),
      log: () => {},
    });

    // The seal is re-checked at the paid boundary, so the mutation is caught
    // BEFORE the child spawns: no invocation is spent on unsealed bytes, and
    // check() (which held the restore) never gets to run its cover-up.
    expect(childRan).toBe(false);
    expect(outcome.invocations).toBe(0);
    expect(outcome.inputsChanged).toBe(true);
    expect(readFileSync(flow, "utf8")).toContain("ALTERED");
    expect(original).toContain("ORIGINAL");

    const entry = readEvalLedger(join(tempDir, "ledger.json"))[
      resolveEvalSuitePath(flow)
    ] as EvalLedgerEntry | undefined;
    // No clean, fingerprint-bound receipt may exist for bytes no trial exercised.
    expect(entry?.currentClean ?? false).toBe(false);
    expect(entry?.verification).toBeUndefined();
  });

  test("a mutation that lands only AFTER the child runs is still caught", async () => {
    const flow = write(join(tempDir, "flow.md"), "---\ndescription: fixture\n---\n\nORIGINAL.\n");
    const suite = write(join(tempDir, "flow.eval.ts"), "export default [];\n");
    const original = readFileSync(flow, "utf8");
    const environment = await resolveEvalEnvironment(flow);

    const cases: EvalCase[] = [
      {
        name: "late mutator",
        check: () => {
          // Mutate during check, restore nothing: the post-check seal
          // comparison must catch it.
          writeFileSync(flow, "---\ndescription: fixture\n---\n\nALTERED.\n");
          return null;
        },
      },
    ];
    const seal = await buildVerificationFingerprint(flow, suite, cases, environment);
    const outcome = await runEvalSuite({
      flowPath: flow,
      cases,
      runFlow: okRunner,
      environment,
      sealedFingerprint: seal.fingerprint,
      ledgerPath: join(tempDir, "late-ledger.json"),
      log: () => {},
    });

    expect(outcome.inputsChanged).toBe(true);
    expect(readFileSync(flow, "utf8")).not.toBe(original);
    const entry = readEvalLedger(join(tempDir, "late-ledger.json"))[
      resolveEvalSuitePath(flow)
    ] as EvalLedgerEntry | undefined;
    expect(entry?.currentClean ?? false).toBe(false);
    expect(entry?.verification).toBeUndefined();
  });
});

/* ── Finding 3: post-install registry sidecars still executed ─────────────── */

describe("registry provenance is enforced at RUN time (audit F3)", () => {
  test("a suite planted next to a registry flow after installation never executes", async () => {
    const registryDir = join(tempDir, ".mdflow", "registry");
    const flow = write(join(registryDir, "vendor.md"), "---\ndescription: vendor\n---\n\nSay hello.\n");
    const sentinel = join(tempDir, "TOP-LEVEL-CODE-RAN");
    // Top-level code in the planted suite would run on import.
    write(
      join(registryDir, "vendor.eval.ts"),
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(sentinel)}, "pwned");
export default [{ name: "x", check: () => null }];
`
    );

    const lines: string[] = [];
    const priorLog = console.log;
    const priorError = console.error;
    console.log = (line: unknown) => lines.push(String(line));
    console.error = (line: unknown) => lines.push(String(line));
    let code: number;
    try {
      code = await runEvalCli([flow, "--yes"], { cwd: tempDir });
    } finally {
      console.log = priorLog;
      console.error = priorError;
    }

    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/registry|not consented|sidecar/i);
    expect(existsSync(sentinel)).toBe(false);
  });

  test("evolve also refuses a registry flow's planted suite", async () => {
    const registryDir = join(tempDir, ".mdflow", "registry");
    const flow = write(join(registryDir, "vendor.md"), "---\ndescription: vendor\n---\n\nSay BLUE.\n");
    const sentinel = join(tempDir, "EVOLVE-TOP-LEVEL-RAN");
    write(
      join(registryDir, "vendor.eval.ts"),
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(sentinel)}, "pwned");
export default [{ name: "x", check: () => null }];
`
    );
    const { recordComplaint } = await import("./evolve");
    recordComplaint(flow, "bad output");

    const result = await runEvolve({ flowPath: flow, yes: true, log: () => {} });
    expect(result.decision.reasonCode).toBe("UNTRUSTED_SIDECAR");
    expect(existsSync(sentinel)).toBe(false);
  });

  test("registry provenance follows realpath through an alias", () => {
    const registryDir = join(tempDir, ".mdflow", "registry");
    const real = write(join(registryDir, "vendor.md"), "---\ndescription: v\n---\n\nhi\n");
    const alias = join(tempDir, "looks-local.md");
    symlinkSync(real, alias);
    expect(isRegistryPath(real)).toBe(true);
    // A symlink OUTSIDE the registry must not launder registry provenance.
    expect(isRegistryPath(alias)).toBe(true);
    expect(isRegistryPath(write(join(tempDir, "genuinely-local.md"), "x"))).toBe(false);
  });
});

/* ── Finding 4: config root + spoofable/leaking config pointer ────────────── */

describe("config root and the internal config pointer (audit F4)", () => {
  test("eval resolves the nearest mdflow project root in a non-git project", async () => {
    const projectDir = join(tempDir, "project");
    write(join(projectDir, ".mdflow.yaml"), "commands:\n  claude:\n    model: nearest-root-model\n");
    const flow = write(join(projectDir, "flows", "review.claude.md"), "---\ndescription: r\n---\n\nReview.\n");

    const environment = await resolveEvalEnvironment(flow);
    expect(environment.configCwd).toBe(projectDir);
    expect(environment.model).toBe("nearest-root-model");
  });

  test("config file BYTES bind the receipt, not just the parsed shape", async () => {
    const projectDir = join(tempDir, "project");
    const configPath = join(projectDir, ".mdflow.yaml");
    write(configPath, "commands:\n  claude:\n    model: opus\n");
    const flow = write(join(projectDir, "flows", "x.claude.md"), "---\ndescription: x\n---\n\nHi.\n");
    const suite = write(join(projectDir, "flows", "x.claude.eval.ts"), "export default [];\n");

    const before = await buildVerificationEnvironmentFingerprint(flow, suite);
    // Same parsed config, different bytes (a comment) — the receipt must still
    // invalidate, because the stated contract is exact-byte binding.
    writeFileSync(configPath, "# a comment\ncommands:\n  claude:\n    model: opus\n");
    const after = await buildVerificationEnvironmentFingerprint(flow, suite);
    expect(after.configHash).not.toBe(before.configHash);
  });

  test("the engine never inherits the internal MDFLOW_CONFIG_CWD pointer", async () => {
    const { runCommand } = await import("./command");
    const priorPointer = process.env.MDFLOW_CONFIG_CWD;
    process.env.MDFLOW_CONFIG_CWD = join(tempDir, "outer-project");
    try {
      const result = await runCommand({
        command: "printenv",
        args: ["MDFLOW_CONFIG_CWD"],
        positionals: [],
        positionalMappings: new Map<number, string>(),
        captureOutput: true,
        captureStderr: true,
        silentCapture: true,
      });
      // printenv exits 1 when the variable is absent — which is the point.
      expect(result.stdout).not.toContain("outer-project");
    } finally {
      if (priorPointer === undefined) delete process.env.MDFLOW_CONFIG_CWD;
      else process.env.MDFLOW_CONFIG_CWD = priorPointer;
    }
  });
});

/* ── Finding 5: all-or-nothing flow + sidecar scaffolding ─────────────────── */

describe("scaffolding never adopts sidecars it did not write (audit F5)", () => {
  test("init refuses a catalog flow whose eval sidecar was planted first", async () => {
    const { scaffoldStarterFlows } = await import("./init");
    const projectDir = join(tempDir, "project");
    const sentinel = join(tempDir, "INIT-ADOPTED-PLANTED-SUITE");
    // Plant an executable suite where a catalog flow WOULD land, with no flow.
    write(
      join(projectDir, "flows", "review.eval.ts"),
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(sentinel)}, "pwned");
export default [{ name: "x", check: () => null }];
`
    );

    const { lines } = scaffoldStarterFlows(projectDir, "claude");

    // The catalog flow is NOT created, so the planted suite never becomes its
    // guardrail suite (which `md eval review.md` would import and execute).
    expect(existsSync(join(projectDir, "flows", "review.md"))).toBe(false);
    expect(lines.join("\n")).toMatch(/orphan sidecar/i);
    expect(existsSync(sentinel)).toBe(false);
    // Unaffected catalog entries still scaffold normally.
    expect(existsSync(join(projectDir, "flows", "changelog.md"))).toBe(true);
    expect(existsSync(join(projectDir, "flows", "changelog.eval.ts"))).toBe(true);
  });

  test("init refuses a catalog flow whose HOOKS sidecar was planted first", async () => {
    const { scaffoldStarterFlows } = await import("./init");
    const projectDir = join(tempDir, "project");
    write(join(projectDir, "flows", "review.hooks.ts"), "#!/usr/bin/env bun\nconst handlers = {};\n");

    const { lines } = scaffoldStarterFlows(projectDir, "claude");

    expect(existsSync(join(projectDir, "flows", "review.md"))).toBe(false);
    expect(lines.join("\n")).toMatch(/orphan sidecar/i);
  });

  test("a Workbench sidecar-creation race rolls the new flow back", async () => {
    const { applyFlowDraft } = await import("./workbench-model");
    const projectDir = join(tempDir, "wb-project");
    const flowsDir = join(projectDir, "flows");
    mkdirSync(flowsDir, { recursive: true });

    const draft = {
      intent: "do a thing",
      slug: "racy",
      filename: "racy.md",
      description: "racy",
      markdown: "---\ndescription: racy\n---\n\nDo a thing.\n",
    };
    // Simulate losing the race: the suite exists by the time the exclusive
    // write runs, but did not exist at the orphan precheck. Approximated by
    // planting it — the write must return "exists" and roll the flow back.
    write(join(flowsDir, "racy.eval.ts"), 'export default [{ name: "planted", check: () => null }];\n');

    const result = applyFlowDraft(draft, {
      target: {
        projectRoot: projectDir,
        flowsDir,
        configPath: join(projectDir, ".mdflow.yaml"),
        source: "flows",
      },
    });

    expect(result.status).toBe("conflict");
    expect(existsSync(join(flowsDir, "racy.md"))).toBe(false);
  });
});

/* ── Finding 6: fingerprint graph completeness + pre-read bounds ──────────── */

describe("fingerprint graph completeness (audit F6)", () => {
  test("a bare side-effect import changes the suite fingerprint", async () => {
    const flow = write(join(tempDir, "flow.md"), "---\ndescription: f\n---\n\nHi.\n");
    const helper = write(join(tempDir, "verifier-helper.ts"), "export const LIMIT = 1;\n");
    const suite = write(
      join(tempDir, "flow.eval.ts"),
      'import "./verifier-helper";\nexport default [{ name: "x", check: () => null }];\n'
    );

    const before = await buildVerificationEnvironmentFingerprint(flow, suite);
    writeFileSync(helper, "export const LIMIT = 999;\n");
    const after = await buildVerificationEnvironmentFingerprint(flow, suite);
    expect(after.suiteHash).not.toBe(before.suiteHash);
  });

  test("an `export … from` re-export is part of the graph", async () => {
    const flow = write(join(tempDir, "flow.md"), "---\ndescription: f\n---\n\nHi.\n");
    const helper = write(join(tempDir, "shared.ts"), "export const A = 1;\n");
    const suite = write(
      join(tempDir, "flow.eval.ts"),
      'export * from "./shared";\nexport default [{ name: "x", check: () => null }];\n'
    );

    const before = await buildVerificationEnvironmentFingerprint(flow, suite);
    writeFileSync(helper, "export const A = 2;\n");
    const after = await buildVerificationEnvironmentFingerprint(flow, suite);
    expect(after.suiteHash).not.toBe(before.suiteHash);
  });

  test("a quoted relative string that is not an import stays out of the graph", async () => {
    const flow = write(join(tempDir, "flow.md"), "---\ndescription: f\n---\n\nHi.\n");
    const decoy = write(join(tempDir, "decoy.ts"), "export const X = 1;\n");
    const suite = write(
      join(tempDir, "flow.eval.ts"),
      'const path = "./decoy";\nvoid path;\nexport default [{ name: "x", check: () => null }];\n'
    );

    const before = await buildVerificationEnvironmentFingerprint(flow, suite);
    writeFileSync(decoy, "export const X = 999;\n");
    const after = await buildVerificationEnvironmentFingerprint(flow, suite);
    expect(after.suiteHash).toBe(before.suiteHash);
  });

  test("a dependency escaping the containment root makes freshness unavailable", async () => {
    const projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });
    write(join(projectDir, ".mdflow.yaml"), "engine: claude\n");
    const outside = write(join(tempDir, "outside", "evil.ts"), "export const E = 1;\n");
    void outside;
    const flow = write(join(projectDir, "flow.md"), "---\ndescription: f\n---\n\nHi.\n");
    const suite = write(
      join(projectDir, "flow.eval.ts"),
      'import "../outside/evil";\nexport default [{ name: "x", check: () => null }];\n'
    );

    await expect(buildVerificationEnvironmentFingerprint(flow, suite)).rejects.toThrow(/escapes|outside/i);
  });
});

/* ── Finding 7: ledger schema validation + alias-aware prev ───────────────── */

describe("ledger is schema-closed, not merely syntax-closed (audit F7)", () => {
  test("valid JSON with malformed entries refuses the read and the write", () => {
    const ledgerPath = join(tempDir, "malformed.json");
    const raw = JSON.stringify({
      "/repo/flow.eval.ts": { flow: 7, pass: "all", verification: "trusted" },
    });
    writeFileSync(ledgerPath, raw);

    expect(() => readEvalLedger(ledgerPath)).toThrow(/corrupt/i);
    const flow = write(join(tempDir, "flow.md"), "---\ndescription: f\n---\n\nHi.\n");
    expect(() =>
      recordEvalResult(
        resolveEvalSuitePath(flow),
        { flow, pass: 1, fail: 0, total: 1, lastRunAt: "2026-07-11T00:00:00.000Z", full: true },
        ledgerPath
      )
    ).toThrow(/corrupt/i);
    // Refused byte-for-byte — history is never silently discarded.
    expect(readFileSync(ledgerPath, "utf8")).toBe(raw);
  });

  test("a well-formed ledger still reads", () => {
    const ledgerPath = join(tempDir, "ok.json");
    const flow = write(join(tempDir, "flow.md"), "---\ndescription: f\n---\n\nHi.\n");
    recordEvalResult(
      resolveEvalSuitePath(flow),
      { flow, pass: 1, fail: 0, total: 1, lastRunAt: "2026-07-11T00:00:00.000Z", full: true },
      ledgerPath
    );
    const entry = readEvalLedger(ledgerPath)[resolveEvalSuitePath(flow)];
    expect(entry?.pass).toBe(1);
    expect(entry?.full).toBe(true);
  });
});

/* ── Finding 10: suite stdout cannot corrupt the JSONL protocol ───────────── */

describe("protocol stdout is parent-owned (audit F10)", () => {
  test("a suite writing directly to process.stdout cannot corrupt eval JSONL", async () => {
    const flow = write(join(tempDir, "flow.md"), "---\ndescription: f\n---\n\nHi.\n");
    write(
      join(tempDir, "flow.eval.ts"),
      `process.stdout.write("debugging suite\\n");
export default [
  {
    name: "inconclusive by environment",
    setup: () => {
      throw new Error("INCONCLUSIVE: no engine needed for this test");
    },
    check: () => null,
  },
];
`
    );

    const proc = Bun.spawn(
      ["bun", "run", join(import.meta.dir, "index.ts"), "eval", flow, "--yes", "--json"],
      {
        cwd: tempDir,
        env: { ...process.env, MDFLOW_EVAL_RESULTS: join(tempDir, "ledger.json") },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

    const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const parsed = JSON.parse(line) as { protocolVersion?: number };
      expect(parsed.protocolVersion).toBe(1);
    }
    expect(stdout).not.toContain("debugging suite");
  }, 30_000);
});

/* ── Finding 11: paid-invocation accounting is an upper bound, labeled ────── */

describe("invocation accounting is honest (audit F11)", () => {
  test("attemptedRuns counts child attempts, not proven engine starts", async () => {
    const flow = write(join(tempDir, "flow.md"), "---\ndescription: f\n---\n\nHi.\n");
    write(join(tempDir, "flow.eval.ts"), 'export default [{ name: "x", check: () => null }];\n');

    const lines: string[] = [];
    const priorLog = console.log;
    console.log = (line: unknown) => lines.push(String(line));
    try {
      await runEvalCli([flow, "--yes", "--json"], {
        cwd: tempDir,
        cliPath: join(import.meta.dir, "index.ts"),
      });
    } finally {
      console.log = priorLog;
    }
    const result = lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((o) => o.type === "eval.result");
    // The field is named for what it actually measures.
    expect(result).toHaveProperty("attemptedRuns");
    expect(result).not.toHaveProperty("actualInvocations");
  }, 60_000);
});

/* ── Finding 12: strict management grammar + shared protocol version ──────── */

describe("management CLI grammar is strict (audit F12)", () => {
  const capture = async (args: string[]) => {
    const lines: string[] = [];
    const code = await runEvalManagementCli(args, {
      cwd: tempDir,
      isTTY: false,
      log: (m) => lines.push(m),
      error: (m) => lines.push(m),
    });
    return { code, out: lines.join("\n") };
  };

  test("coverage rejects extra positionals instead of silently ignoring them", async () => {
    mkdirSync(join(tempDir, "flows"), { recursive: true });
    const { code, out } = await capture(["coverage", "flows", "typo"]);
    expect(code).toBe(1);
    expect(out).toMatch(/unexpected argument/i);
  });

  test("--baseline never swallows the next flag as its value", async () => {
    const { code, out } = await capture(["coverage", "--baseline", "--json"]);
    expect(code).toBe(1);
    // The error must be JSON-shaped (the --json flag still took effect) and
    // must be about the missing baseline value, not a missing file named "--json".
    const payload = JSON.parse(out) as { type: string; reasonCode: string; protocolVersion: number };
    expect(payload.type).toBe("eval.error");
    expect(payload.reasonCode).toBe("BASELINE_VALUE_REQUIRED");
    expect(payload.protocolVersion).toBe(1);
  });

  test("a flag that does not apply to the action is rejected", async () => {
    mkdirSync(join(tempDir, "flows"), { recursive: true });
    const { code, out } = await capture(["list", "--baseline", "x.json"]);
    expect(code).toBe(1);
    expect(out).toMatch(/only applies to md eval coverage/i);
  });

  test("every eval JSON surface stamps the one shared protocol version", async () => {
    const { EVAL_PROTOCOL_VERSION } = await import("./evals");
    mkdirSync(join(tempDir, "flows"), { recursive: true });
    const { out } = await capture(["coverage", "flows", "--json"]);
    const payload = JSON.parse(out) as { protocolVersion: number };
    expect(payload.protocolVersion).toBe(EVAL_PROTOCOL_VERSION);
  });
});
