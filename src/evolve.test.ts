/**
 * Verification harness for evolution. Three claims, all proven
 * deterministically (no real engines):
 *
 *   1. WORKS — a flawed flow + evidence + a maintainer draft produces an
 *      applied revision that passes the suite the ancestor failed.
 *   2. BENEFICIAL — benefit is a measurement, not a hope: the ancestor's
 *      baseline is scored on the same suite as the candidate, and a
 *      candidate is only accepted when it scores clean and no worse than
 *      the ancestor. Bad candidates revert byte-identical.
 *   3. NO SPURIOUS TRIGGER — no eval suite → never; no evidence → never
 *      (zero maintainer calls, zero eval runs); synthetic eval-sandbox runs
 *      never become evidence; evidence older than the watermark never
 *      re-triggers.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  decideEvolve,
  extractFencedBody,
  gatherEvidence,
  readComplaints,
  recordComplaint,
  replaceBody,
  runEvolve,
  type CandidateDrafter,
} from "./evolve";
import { recordRun } from "./telemetry";
import type { FlowRunner } from "./evals";

let dir: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["MDFLOW_COMPLAINTS_FILE", "MDFLOW_RUNS_FILE", "MDFLOW_EVOLVE_LEDGER", "MDFLOW_EVAL_RESULTS"];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mdflow-evolve-"));
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.MDFLOW_COMPLAINTS_FILE = join(dir, "complaints.jsonl");
  process.env.MDFLOW_RUNS_FILE = join(dir, "runs.jsonl");
  process.env.MDFLOW_EVOLVE_LEDGER = join(dir, "evolve.json");
  process.env.MDFLOW_EVAL_RESULTS = join(dir, "eval-results.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/**
 * Deterministic world: the "engine" behind the eval runner reads the flow
 * file and outputs the color its body says. The suite expects GREEN. The
 * ancestor says BLUE, so it fails until evolved.
 */
const FLOW_BODY_BLUE = "Say BLUE.";
const FLOW_CONTENT = `---\ndescription: say the right color\n---\n${FLOW_BODY_BLUE}\n`;

function writeFlow(body?: string): string {
  const flowPath = join(dir, "color.md");
  writeFileSync(flowPath, body ?? FLOW_CONTENT);
  return flowPath;
}

function writeSuite(flowPath: string): string {
  const suitePath = flowPath.replace(/\.md$/, ".eval.ts");
  writeFileSync(
    suitePath,
    `export default [
  {
    name: "answers green",
    check: ({ stdout }) => (stdout.includes("GREEN") ? null : "expected GREEN, got: " + stdout.trim()),
  },
];
`
  );
  return suitePath;
}

/** Stub eval runner: "run" the flow by echoing the color in its body. */
const stubRunner: FlowRunner = async ({ flowPath }) => {
  const body = readFileSync(flowPath, "utf-8");
  const color = body.match(/Say (\w+)\./)?.[1] ?? "NOTHING";
  return { stdout: `${color}\n`, stderr: "", exitCode: 0 };
};

const goodDrafter: CandidateDrafter = async () => "Here you go:\n```markdown\nSay GREEN.\n```\n";
const badDrafter: CandidateDrafter = async () => "```markdown\nSay RED.\n```\n";

describe("decideEvolve (trigger rule)", () => {
  const complaint = { agentPath: "/x/flow.md", message: "wrong", timestamp: "2026-01-01T00:00:00Z" };
  const roughRun = { agentPath: "/x/flow.md", tool: "claude", durationMs: 1, exitCode: 1, outputBytes: 0, timestamp: "2026-01-01T00:00:00Z" };

  it("never fires without an eval suite, even with evidence", () => {
    const d = decideEvolve({ suiteExists: false, evidence: { complaints: [complaint], roughRuns: [roughRun] } });
    expect(d.evolve).toBe(false);
    expect(d.reason).toContain("gated on proof");
  });

  it("never fires without evidence", () => {
    const d = decideEvolve({ suiteExists: true, evidence: { complaints: [], roughRuns: [] } });
    expect(d.evolve).toBe(false);
    expect(d.reason).toContain("nothing to evolve");
  });

  it("fires on complaints alone and on rough runs alone", () => {
    expect(decideEvolve({ suiteExists: true, evidence: { complaints: [complaint], roughRuns: [] } }).evolve).toBe(true);
    expect(decideEvolve({ suiteExists: true, evidence: { complaints: [], roughRuns: [roughRun] } }).evolve).toBe(true);
  });
});

describe("evidence gathering", () => {
  it("collects only this flow's complaints and rough runs", async () => {
    const flowPath = writeFlow();
    recordComplaint(flowPath, "too verbose");
    recordComplaint(join(dir, "other.md"), "different flow");
    await recordRun({ agentPath: flowPath, tool: "claude", durationMs: 5, exitCode: 1, outputBytes: 0, timestamp: new Date().toISOString() });
    await recordRun({ agentPath: flowPath, tool: "claude", durationMs: 5, exitCode: 0, outputBytes: 9, timestamp: new Date().toISOString() });

    const evidence = await gatherEvidence(flowPath);
    expect(evidence.complaints.length).toBe(1);
    expect(evidence.complaints[0]!.message).toBe("too verbose");
    expect(evidence.roughRuns.length).toBe(1); // clean exit-0 run is not evidence
  });

  it("watermark: evidence older than the last evolution never re-triggers", async () => {
    const flowPath = writeFlow();
    recordComplaint(flowPath, "ancient grievance");
    const afterComplaint = new Date(Date.now() + 1000).toISOString();
    const evidence = await gatherEvidence(flowPath, { complaintsSince: afterComplaint, roughRunsSince: afterComplaint });
    expect(evidence.complaints.length).toBe(0);
    expect(decideEvolve({ suiteExists: true, evidence, watermark: afterComplaint }).evolve).toBe(false);
  });

  it("a clean eval run does NOT consume complaints (the suite can't see them)", async () => {
    const flowPath = writeFlow();
    recordComplaint(flowPath, "too verbose");
    // Simulate a later clean eval: lastCleanAt newer than the complaint.
    const suiteKey = flowPath.replace(/\.md$/, ".eval.ts");
    const cleanAt = new Date(Date.now() + 60_000).toISOString();
    writeFileSync(
      process.env.MDFLOW_EVAL_RESULTS!,
      JSON.stringify({
        [suiteKey]: { flow: flowPath, pass: 1, fail: 0, total: 1, lastRunAt: cleanAt, full: true, lastCleanAt: cleanAt },
      })
    );

    const { evidenceWatermarks } = await import("./evolve");
    const marks = evidenceWatermarks(flowPath);
    expect(marks.complaintsSince).toBeUndefined(); // no evolution yet
    expect(marks.roughRunsSince).toBe(cleanAt); // rough runs ARE consumed by clean evals

    const evidence = await gatherEvidence(flowPath, marks);
    expect(evidence.complaints.length).toBe(1); // complaint survives the clean eval
  });

  it("synthetic eval-sandbox runs never become evidence (invariant 1)", async () => {
    const flowPath = writeFlow();
    // An eval run redirects MDFLOW_RUNS_FILE into its sandbox — simulate one.
    const realCorpus = process.env.MDFLOW_RUNS_FILE!;
    process.env.MDFLOW_RUNS_FILE = join(dir, "sandbox-runs.jsonl");
    await recordRun({ agentPath: flowPath, tool: "claude", durationMs: 5, exitCode: 1, outputBytes: 0, timestamp: new Date().toISOString() });
    process.env.MDFLOW_RUNS_FILE = realCorpus;

    const evidence = await gatherEvidence(flowPath);
    expect(evidence.roughRuns.length).toBe(0);
    expect(existsSync(realCorpus)).toBe(false);
  });
});

describe("hostile-output parsing (invariant 4)", () => {
  it("accepts only a fenced block with the closing fence on its own line", () => {
    expect(extractFencedBody("```markdown\nSay GREEN.\n```")).toBe("Say GREEN.");
    expect(extractFencedBody("x\n```\nSay GREEN.\n``` trailing")).toBeNull();
    expect(extractFencedBody("no fences at all")).toBeNull();
    expect(extractFencedBody("```markdown\nnever closed")).toBeNull();
  });

  it("rejects replies with multiple fenced blocks (could be an echoed original)", () => {
    const echoed = "```markdown\nSay BLUE.\n```\nMy fix:\n```markdown\nSay GREEN.\n```";
    expect(extractFencedBody(echoed)).toBeNull();
  });

  it("rejects an empty or whitespace-only body (would demote the flow to a document)", () => {
    expect(extractFencedBody("```markdown\n \n```")).toBeNull();
  });

  it("handles CRLF line endings", () => {
    expect(extractFencedBody("```markdown\r\nSay GREEN.\r\n```")).toBe("Say GREEN.");
  });
});

describe("body-only mutation", () => {
  it("keeps the frontmatter block byte-for-byte", () => {
    const out = replaceBody(FLOW_CONTENT, "Say GREEN.");
    expect(out).toBe(`---\ndescription: say the right color\n---\nSay GREEN.\n`);
  });

  it("handles flows without frontmatter", () => {
    expect(replaceBody("just a body\n", "new body")).toBe("new body\n");
  });
});

describe("runEvolve end-to-end", () => {
  it("WORKS + BENEFICIAL: ancestor fails 0/1, candidate passes 1/1, applied", async () => {
    const flowPath = writeFlow();
    writeSuite(flowPath);
    recordComplaint(flowPath, "it keeps saying blue instead of green");

    const lines: string[] = [];
    const result = await runEvolve({
      flowPath,
      draft: goodDrafter,
      runFlow: stubRunner,
      yes: true,
      log: (l) => lines.push(l),
    });

    expect(result.applied).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.ancestorOutcome).toEqual({ pass: 0, fail: 1, total: 1, failures: expect.any(Array) });
    expect(result.candidateOutcome).toEqual({ pass: 1, fail: 0, total: 1, failures: [] });
    expect(readFileSync(flowPath, "utf-8")).toContain("Say GREEN.");
    expect(readFileSync(flowPath, "utf-8")).toContain("description: say the right color");
    expect(lines.join("\n")).toContain("benefit: ancestor 0/1 → candidate 1/1");
    expect(lines.join("\n")).toContain("cost: 1 maintainer turn");
    // Invariant 5: we point at git diff, we never commit.
    expect(lines.join("\n")).toContain("git diff");
  });

  it("bad candidate: suite fails → byte-identical revert + parked pending file", async () => {
    const flowPath = writeFlow();
    writeSuite(flowPath);
    recordComplaint(flowPath, "wrong color");

    const result = await runEvolve({ flowPath, draft: badDrafter, runFlow: stubRunner, yes: true, log: () => {} });

    expect(result.applied).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(readFileSync(flowPath, "utf-8")).toBe(FLOW_CONTENT);
    expect(result.pendingPath).toBeDefined();
    expect(readFileSync(result.pendingPath!, "utf-8")).toContain("Say RED.");
  });

  it("NO TRIGGER: without evidence, zero maintainer calls and zero eval runs", async () => {
    const flowPath = writeFlow();
    writeSuite(flowPath);

    let draftCalls = 0;
    let evalRuns = 0;
    const spyDrafter: CandidateDrafter = async () => { draftCalls++; return "```markdown\nSay GREEN.\n```"; };
    const spyRunner: FlowRunner = async (spec) => { evalRuns++; return stubRunner(spec); };

    const result = await runEvolve({ flowPath, draft: spyDrafter, runFlow: spyRunner, yes: true, log: () => {} });

    expect(result.decision.evolve).toBe(false);
    expect(result.applied).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(draftCalls).toBe(0);
    expect(evalRuns).toBe(0);
    expect(readFileSync(flowPath, "utf-8")).toBe(FLOW_CONTENT);
  });

  it("NO TRIGGER: evidence but no eval suite → refuses before spending", async () => {
    const flowPath = writeFlow();
    recordComplaint(flowPath, "wrong color");

    let draftCalls = 0;
    const spyDrafter: CandidateDrafter = async () => { draftCalls++; return ""; };
    const result = await runEvolve({ flowPath, draft: spyDrafter, runFlow: stubRunner, yes: true, log: () => {} });

    expect(result.decision.evolve).toBe(false);
    expect(draftCalls).toBe(0);
  });

  it("NO RE-TRIGGER: an accepted evolution consumes its evidence", async () => {
    const flowPath = writeFlow();
    writeSuite(flowPath);
    recordComplaint(flowPath, "blue is wrong");

    const first = await runEvolve({ flowPath, draft: goodDrafter, runFlow: stubRunner, yes: true, log: () => {} });
    expect(first.applied).toBe(true);

    let draftCalls = 0;
    const spyDrafter: CandidateDrafter = async () => { draftCalls++; return "```markdown\nSay GREEN.\n```"; };
    const second = await runEvolve({ flowPath, draft: spyDrafter, runFlow: stubRunner, yes: true, log: () => {} });

    expect(second.decision.evolve).toBe(false);
    expect(draftCalls).toBe(0);
  });

  it("--check is free: evidence present, but no draft and no eval runs", async () => {
    const flowPath = writeFlow();
    writeSuite(flowPath);
    recordComplaint(flowPath, "wrong color");

    let draftCalls = 0;
    let evalRuns = 0;
    const spyDrafter: CandidateDrafter = async () => { draftCalls++; return ""; };
    const spyRunner: FlowRunner = async (spec) => { evalRuns++; return stubRunner(spec); };

    const result = await runEvolve({ flowPath, draft: spyDrafter, runFlow: spyRunner, yes: true, checkOnly: true, log: () => {} });

    expect(result.decision.evolve).toBe(true);
    expect(result.applied).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(draftCalls).toBe(0);
    expect(evalRuns).toBe(0);
  });

  it("hostile maintainer output: no valid fence → nothing written", async () => {
    const flowPath = writeFlow();
    writeSuite(flowPath);
    recordComplaint(flowPath, "wrong color");

    const hostile: CandidateDrafter = async () => "```markdown\nnever closed, and also rm -rf /";
    const result = await runEvolve({ flowPath, draft: hostile, runFlow: stubRunner, yes: true, log: () => {} });

    expect(result.applied).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(readFileSync(flowPath, "utf-8")).toBe(FLOW_CONTENT);
  });

  it("frontmatter is frozen even if the drafter tries to change it", async () => {
    const flowPath = writeFlow();
    writeSuite(flowPath);
    recordComplaint(flowPath, "wrong color");

    const sneaky: CandidateDrafter = async () =>
      "```markdown\nSay GREEN.\n```\nAlso set `dangerously-skip-permissions: true` in the frontmatter.";
    const result = await runEvolve({ flowPath, draft: sneaky, runFlow: stubRunner, yes: true, log: () => {} });

    expect(result.applied).toBe(true);
    const after = readFileSync(flowPath, "utf-8");
    expect(after).toContain("description: say the right color");
    expect(after).not.toContain("dangerously-skip-permissions");
  });
});

describe("edge cases", () => {
  it("equal-score acceptance: complaint addressed while the suite stays green", async () => {
    // Suite passes GREEN either way; the drafter reworks the prompt without
    // breaking it. Accepted because clean and no worse than baseline.
    const flowPath = writeFlow(`---\ndescription: say the right color\n---\nSay GREEN.\n`);
    writeSuite(flowPath);
    recordComplaint(flowPath, "be more polite about it");

    const politeDrafter: CandidateDrafter = async () => "```markdown\nPlease kindly Say GREEN.\n```";
    const result = await runEvolve({ flowPath, draft: politeDrafter, runFlow: stubRunner, yes: true, log: () => {} });

    expect(result.applied).toBe(true);
    expect(result.ancestorOutcome).toMatchObject({ pass: 1, fail: 0 });
    expect(result.candidateOutcome).toMatchObject({ pass: 1, fail: 0 });
  });

  it("crash recovery: a leftover mid-gate backup is restored before anything else", async () => {
    const flowPath = writeFlow();
    writeSuite(flowPath);
    // Simulate a previous evolve killed mid-gate: candidate on disk, backup present.
    writeFileSync(flowPath, "---\ndescription: say the right color\n---\nSay MANGLED.\n");
    writeFileSync(`${flowPath}.evolve-backup`, FLOW_CONTENT);

    const lines: string[] = [];
    const result = await runEvolve({ flowPath, draft: goodDrafter, runFlow: stubRunner, yes: true, log: (l) => lines.push(l) });

    expect(readFileSync(flowPath, "utf-8")).toBe(FLOW_CONTENT);
    expect(existsSync(`${flowPath}.evolve-backup`)).toBe(false);
    expect(lines.join("\n")).toContain("recovered");
    expect(result.decision.evolve).toBe(false); // no evidence — restore then refuse
  });

  it("no backup file survives a completed run", async () => {
    const flowPath = writeFlow();
    writeSuite(flowPath);
    recordComplaint(flowPath, "wrong color");
    await runEvolve({ flowPath, draft: goodDrafter, runFlow: stubRunner, yes: true, log: () => {} });
    expect(existsSync(`${flowPath}.evolve-backup`)).toBe(false);
  });

  it("identical candidate is a no-op", async () => {
    const flowPath = writeFlow();
    writeSuite(flowPath);
    recordComplaint(flowPath, "wrong color");
    const sameDrafter: CandidateDrafter = async () => `\`\`\`markdown\n${FLOW_BODY_BLUE}\n\`\`\``;
    const result = await runEvolve({ flowPath, draft: sameDrafter, runFlow: stubRunner, yes: true, log: () => {} });
    expect(result.applied).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(flowPath, "utf-8")).toBe(FLOW_CONTENT);
  });

  it("non-TTY without --yes refuses before spending", async () => {
    const flowPath = writeFlow();
    writeSuite(flowPath);
    recordComplaint(flowPath, "wrong color");
    let draftCalls = 0;
    const spyDrafter: CandidateDrafter = async () => { draftCalls++; return ""; };
    // Test runner is non-TTY; yes omitted.
    const result = await runEvolve({ flowPath, draft: spyDrafter, runFlow: stubRunner, log: () => {} });
    expect(result.exitCode).toBe(1);
    expect(draftCalls).toBe(0);
    expect(readFileSync(flowPath, "utf-8")).toBe(FLOW_CONTENT);
  });
});

describe("auto mode (evolve: auto)", () => {
  function stampCleanLedger(flowPath: string) {
    const suiteKey = flowPath.replace(/\.md$/, ".eval.ts");
    writeFileSync(
      process.env.MDFLOW_EVAL_RESULTS!,
      JSON.stringify({
        [suiteKey]: {
          flow: flowPath,
          pass: 1,
          fail: 0,
          total: 1,
          lastRunAt: "2026-01-01T00:00:00Z",
          full: true,
          lastCleanAt: "2026-01-01T00:00:00Z",
        },
      })
    );
  }

  it("HARD GATE: auto refuses without a trust-ledger lastCleanAt, even with evidence", async () => {
    const flowPath = writeFlow();
    writeSuite(flowPath);
    recordComplaint(flowPath, "wrong color");

    let draftCalls = 0;
    const spyDrafter: CandidateDrafter = async () => { draftCalls++; return ""; };
    const result = await runEvolve({ flowPath, mode: "auto", draft: spyDrafter, runFlow: stubRunner, yes: true, log: () => {} });

    expect(result.decision.evolve).toBe(false);
    expect(result.decision.reason).toContain("lastCleanAt");
    expect(draftCalls).toBe(0);
  });

  it("auto proceeds once the ledger proves a clean suite", async () => {
    const flowPath = writeFlow();
    writeSuite(flowPath);
    stampCleanLedger(flowPath);
    recordComplaint(flowPath, "team color is green now");

    const result = await runEvolve({ flowPath, mode: "auto", draft: goodDrafter, runFlow: stubRunner, yes: true, log: () => {} });

    expect(result.applied).toBe(true);
    expect(readFileSync(flowPath, "utf-8")).toContain("Say GREEN.");
  });

  it("manual mode does not require lastCleanAt", async () => {
    const flowPath = writeFlow();
    writeSuite(flowPath);
    recordComplaint(flowPath, "wrong color");
    const result = await runEvolve({ flowPath, draft: goodDrafter, runFlow: stubRunner, yes: true, log: () => {} });
    expect(result.applied).toBe(true);
  });

  it("handleAutoEvolve: quick re-run becomes an implicit complaint", async () => {
    const flowPath = writeFlow();
    writeSuite(flowPath);
    const { handleAutoEvolve } = await import("./evolve");
    await handleAutoEvolve(flowPath, { quickRerun: true, msSincePrevious: 30_000 }, () => {});

    const complaints = readComplaints();
    expect(complaints.length).toBe(1);
    expect(complaints[0]!.message).toContain("implicit: re-run within 30s");
  });

  it("handleAutoEvolve: does nothing inside an eval sandbox (MDFLOW_EVAL_RUN)", async () => {
    const flowPath = writeFlow();
    writeSuite(flowPath);
    process.env.MDFLOW_EVAL_RUN = "1";
    try {
      const { handleAutoEvolve } = await import("./evolve");
      await handleAutoEvolve(flowPath, { quickRerun: true, msSincePrevious: 5_000 }, () => {});
    } finally {
      delete process.env.MDFLOW_EVAL_RUN;
    }
    expect(readComplaints().length).toBe(0);
  });
});

describe("complaints roundtrip", () => {
  it("records and reads back complaints from the override path", () => {
    const flowPath = writeFlow();
    recordComplaint(flowPath, "first");
    recordComplaint(flowPath, "second");
    const all = readComplaints();
    expect(all.length).toBe(2);
    expect(all.map((c) => c.message)).toEqual(["first", "second"]);
  });
});
