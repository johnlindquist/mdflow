import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildMaintainerPrompt,
  decideEvolve,
  extractFencedBody,
  gatherEvidence,
  handleAutoEvolve,
  recordComplaint,
  replaceBody,
  runEvolveCli,
  runFeedbackCli,
  runEvolve,
  type CandidateDrafter,
  type ComplaintRecord,
} from "./evolve";
import {
  acquireFlowLock,
  applyEvolutionRun,
  evidenceFilePath,
  evolutionRunPath,
  pruneEvolutionData,
  readEvidence,
  readEvolutionRun,
  readEvolutionArtifact,
  recoverEvolutionRun,
  recordEvidence,
  rollbackEvolutionRun,
  updateEvidenceStatus,
  updateEvolutionRun,
} from "./evolution-store";
import {
  capabilityManifest,
  diffCapabilities,
  ensureFlowIdentity,
  identifyFlow,
  replaceFlowBody,
  resolveEvolutionPolicy,
} from "./evolution-core";
import { recordRun } from "./telemetry";
import { getEvalLedgerEntry, isVerificationCurrent, readEvalLedger, runEvalSuite, type EvalCase, type FlowRunner } from "./evals";
import { createEvolutionWorkspace } from "./evolution-workspace";

let root: string;
let repo: string;
let state: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "MDFLOW_EVIDENCE_FILE",
  "MDFLOW_COMPLAINTS_FILE",
  "MDFLOW_EVOLUTION_HOME",
  "MDFLOW_RUNS_FILE",
  "MDFLOW_EVAL_RESULTS",
  "MDFLOW_EVAL_RUN",
];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mdflow-evolve-v5-"));
  repo = join(root, "repo");
  state = join(root, "state");
  mkdirSync(repo, { recursive: true });
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.MDFLOW_EVIDENCE_FILE = join(state, "evidence.jsonl");
  process.env.MDFLOW_EVOLUTION_HOME = state;
  process.env.MDFLOW_RUNS_FILE = join(state, "runs.jsonl");
  process.env.MDFLOW_EVAL_RESULTS = join(state, "eval-results.json");
  delete process.env.MDFLOW_EVAL_RUN;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

const BLUE = `---\ndescription: answer with a color\n---\nSay BLUE.\n`;
const GREEN = `---\ndescription: answer with a color\n---\nSay GREEN.\n`;

function writeFlow(content = BLUE): string {
  const path = join(repo, "color.md");
  writeFileSync(path, content);
  return path;
}

function writeSuite(flowPath: string, evidenceId?: string): string {
  const path = flowPath.replace(/\.md$/, ".eval.ts");
  writeFileSync(path, `export default [{
    name: "answers green",
    evidence: ${JSON.stringify(evidenceId ? [evidenceId] : [])},
    check: ({ stdout }) => stdout.includes("GREEN") ? null : "expected GREEN",
  }];\n`);
  return path;
}

const colorRunner: FlowRunner = async ({ flowPath }) => {
  const content = readFileSync(flowPath, "utf8");
  const color = content.match(/Say (GREEN|BLUE|RED)/)?.[1] ?? "UNKNOWN";
  return { stdout: `${color}\n`, stderr: "", exitCode: 0 };
};

const greenDrafter: CandidateDrafter = async () => JSON.stringify({ body: "Say GREEN." });
const redDrafter: CandidateDrafter = async () => JSON.stringify({ body: "Say RED." });

function complaintFixture(): ComplaintRecord {
  return {
    id: "fb_test",
    flowId: "flow_test",
    agentPath: "/tmp/flow.md",
    message: "wrong",
    timestamp: "2026-01-01T00:00:00Z",
    status: "open",
    confidence: "high",
    type: "explicit_feedback",
  };
}

describe("policy and decision", () => {
  it("maps legacy auto to proposal-only and rejects typos", () => {
    expect(resolveEvolutionPolicy("auto").mode).toBe("propose");
    expect(resolveEvolutionPolicy({ mode: "apply", apply: "automatic" }).mode).toBe("apply");
    expect(resolveEvolutionPolicy({ gate: { repetitions: 3 } }).repetitions).toBe(3);
    expect(resolveEvolutionPolicy({ maintainer: { isolated: false } }).isolated).toBe(false);
    expect(() => resolveEvolutionPolicy("autp")).toThrow("Invalid evolve mode");
  });

  it("refuses without a suite, actionable feedback, current auto proof, or budget", () => {
    const evidence = { complaints: [complaintFixture()], roughRuns: [] };
    expect(decideEvolve({ suiteExists: false, evidence }).reasonCode).toBe("NO_SUITE");
    expect(decideEvolve({ suiteExists: true, evidence: { complaints: [], roughRuns: [] } }).reasonCode).toBe("NO_ACTIONABLE_EVIDENCE");
    expect(decideEvolve({ suiteExists: true, evidence, mode: "auto", verificationCurrent: false }).reasonCode).toBe("VERIFICATION_STALE");
    expect(decideEvolve({ suiteExists: true, evidence, mode: "auto", verificationCurrent: true, requireFeedbackEval: true, feedbackCovered: false }).reasonCode).toBe("FEEDBACK_UNCOVERED");
    expect(decideEvolve({ suiteExists: true, evidence, plannedInvocations: 9, maxInvocations: 3 }).reasonCode).toBe("BUDGET_EXCEEDED");
    expect(decideEvolve({ suiteExists: true, evidence, plannedInvocations: 3, maxInvocations: 3 }).reasonCode).toBe("READY");
    expect(decideEvolve({ suiteExists: true, evidence, workflow: true }).reasonCode).toBe("WORKFLOW_UNSUPPORTED");
  });

  it("does not treat metadata-only failed runs as actionable prompt evidence", () => {
    const roughRun = { agentPath: "/x.md", tool: "pi", durationMs: 1, exitCode: 1, outputBytes: 1, timestamp: new Date().toISOString() };
    const decision = decideEvolve({ suiteExists: true, evidence: { complaints: [], roughRuns: [roughRun] } });
    expect(decision.evolve).toBe(false);
    expect(decision.reason).toContain("need classification");
  });
});

describe("flow document and capability boundaries", () => {
  it("embeds a stable flow id that survives rename", () => {
    const first = join(repo, "first.md");
    const second = join(repo, "renamed.md");
    writeFileSync(first, ensureFlowIdentity(BLUE));
    const before = identifyFlow(first);
    renameSync(first, second);
    const after = identifyFlow(second);
    expect(after.id).toBe(before.id);
    expect(after.relativePath).not.toBe(before.relativePath);
  });

  it("preserves BOM, shebang, CRLF frontmatter, and trailing-newline policy", () => {
    const original = "\uFEFF#!/usr/bin/env md\r\n---\r\nengine: claude\r\n---\r\n\r\nOld body\r\n";
    const next = replaceFlowBody(original, "New body");
    expect(next).toBe("\uFEFF#!/usr/bin/env md\r\n---\r\nengine: claude\r\n---\r\n\r\nNew body\r\n");
    expect(replaceBody(original, "New body")).toBe(next);
  });

  it("accepts structured JSON containing markdown fences", () => {
    const body = "Explain with an example:\n```ts\nconst x = 1\n```";
    expect(extractFencedBody(JSON.stringify({ body }))).toBe(body);
    expect(extractFencedBody(JSON.stringify({ body: "x".repeat(1_000_001) }))).toBeNull();
  });

  it("detects added commands, executable fences, URLs, and parent imports", () => {
    const current = capabilityManifest("Plain prompt");
    const proposal = capabilityManifest("!`touch /tmp/x`\n@https://example.com/x\n@../secret\n```sh\n#!/bin/sh\necho x\n```");
    const diff = diffCapabilities(current, proposal);
    expect(diff.safe).toBe(false);
    expect(diff.added.some((entry) => entry.startsWith("command:"))).toBe(true);
    expect(diff.added.some((entry) => entry.startsWith("executable:"))).toBe(true);
    expect(diff.added.some((entry) => entry.startsWith("url:"))).toBe(true);
    expect(diff.added.some((entry) => entry.startsWith("file:parent:"))).toBe(true);
  });

  it("refuses repository symlinks that escape a disposable workspace", () => {
    const flow = writeFlow();
    const outside = join(root, "outside-secret.txt");
    writeFileSync(outside, "secret");
    symlinkSync(outside, join(repo, "escape.txt"));
    expect(() => createEvolutionWorkspace(flow, join(state, "workspace"), BLUE)).toThrow("symlink escaping");
  });

  it("does not copy dotenv credentials directly or through aliases in a fallback snapshot", () => {
    const flow = writeFlow();
    writeFileSync(join(repo, ".env.local"), "TOKEN=test-only");
    symlinkSync(".env.local", join(repo, "public-looking.md"));
    const snapshot = createEvolutionWorkspace(flow, join(state, "workspace"), BLUE);
    expect(readFileSync(snapshot.flowPath, "utf8")).toBe(BLUE);
    expect(existsSync(join(snapshot.root, ".env.local"))).toBe(false);
    expect(existsSync(join(snapshot.root, "public-looking.md"))).toBe(false);
  });

  it("does not send frontmatter secrets to the maintainer", () => {
    const prompt = buildMaintainerPrompt({
      flowContent: "---\n_env:\n  SECRET_TOKEN: should-not-leak\n---\nPublic body\n",
      evidence: { complaints: [complaintFixture()], roughRuns: [] },
    });
    expect(prompt).toContain("Public body");
    expect(prompt).not.toContain("should-not-leak");
  });
});

describe("durable evidence", () => {
  it("assigns IDs, preserves unresolved feedback, and supports explicit status changes", async () => {
    const flow = writeFlow();
    const feedback = recordComplaint(flow, "too verbose");
    expect(feedback.id).toStartWith("fb_");
    expect((await gatherEvidence(flow)).complaints.map((item) => item.id)).toEqual([feedback.id]);
    updateEvidenceStatus(feedback.id, "dismissed");
    expect((await gatherEvidence(flow)).complaints).toHaveLength(0);
    updateEvidenceStatus(feedback.id, "open");
    expect((await gatherEvidence(flow)).complaints).toHaveLength(1);
  });

  it("distills feedback into a private, deliberately untrusted eval draft", () => {
    const flow = writeFlow();
    const feedback = recordComplaint(flow, "must cite the exact file and line");
    const prior = console.log;
    console.log = () => {};
    try {
      expect(runFeedbackCli(["distill", feedback.id])).toBe(0);
    } finally {
      console.log = prior;
    }
    const draftPath = join(state, "drafts", `${feedback.id}.eval-case.ts`);
    const draft = readFileSync(draftPath, "utf8");
    expect(draft).toContain(`evidence: ["${feedback.id}"]`);
    expect(draft).toContain("DRAFT_ONLY");
    expect(readEvidence().find((item) => item.id === feedback.id)?.status).toBe("open");
  });

  it("supports explicit privacy deletion without affecting other evidence", () => {
    const flow = writeFlow();
    const forgotten = recordComplaint(flow, "contains private context");
    const kept = recordComplaint(flow, "keep this report");
    const prior = console.log;
    console.log = () => {};
    try {
      expect(runFeedbackCli(["distill", forgotten.id])).toBe(0);
      expect(runFeedbackCli(["forget", forgotten.id])).toBe(1);
      expect(readEvidence().some((item) => item.id === forgotten.id)).toBe(true);
      expect(runFeedbackCli(["forget", forgotten.id, "--yes"])).toBe(0);
    } finally {
      console.log = prior;
    }
    expect(readEvidence().map((item) => item.id)).toEqual([kept.id]);
    expect(readFileSync(evidenceFilePath(), "utf8")).not.toContain(forgotten.message);
    expect(existsSync(join(state, "drafts", `${forgotten.id}.eval-case.ts`))).toBe(false);
  });

  it("canonicalizes relative telemetry paths", async () => {
    const flow = writeFlow();
    const prior = process.cwd();
    process.chdir(repo);
    try {
      await recordRun({ agentPath: "color.md", tool: "pi", durationMs: 2, exitCode: 1, outputBytes: 0, timestamp: new Date().toISOString() });
      expect((await gatherEvidence(flow)).roughRuns).toHaveLength(1);
    } finally {
      process.chdir(prior);
    }
  });

  it("treats only explicitly classified behavior failures as actionable failure evidence", async () => {
    const flow = writeFlow();
    const behavior = recordEvidence({ flowPath: flow, type: "run_failure", confidence: "high", failureClass: "behavior", message: "missed required output" });
    recordEvidence({ flowPath: flow, type: "run_failure", confidence: "high", failureClass: "provider", message: "provider unavailable" });
    expect((await gatherEvidence(flow, {}, ["classified-failure"])).complaints.map((item) => item.id)).toEqual([behavior.id]);
    expect((await gatherEvidence(flow, {}, ["explicit-feedback"])).complaints).toHaveLength(0);
  });

  it("quick reruns become low-confidence observations and never spend", async () => {
    const flow = writeFlow(`---\ndescription: answer with a color\nevolve:\n  mode: suggest\n  triggers: [quick-rerun]\n---\nSay BLUE.\n`);
    writeSuite(flow);
    const lines: string[] = [];
    await handleAutoEvolve(flow, { quickRerun: true, msSincePrevious: 30_000 }, (line) => lines.push(line));
    const items = readEvidence();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "quick_rerun", confidence: "low", status: "open" });
    expect(lines.join("\n")).toContain("intent is unknown");
    expect(existsSync(join(state, "runs"))).toBe(false);
  });

  it("honors project-level suggest policy without flow frontmatter opt-in", async () => {
    const flow = writeFlow();
    writeFileSync(join(repo, ".mdflow.yaml"), "evolve:\n  mode: suggest\n");
    recordComplaint(flow, "answer should include the exact color");
    const lines: string[] = [];
    await handleAutoEvolve(flow, { quickRerun: false, msSincePrevious: null }, (line) => lines.push(line));
    expect(lines.join("\n")).toContain("feedback item(s) ready");
    expect(lines.join("\n")).toContain("md evolve plan");
  });

  it("proposal policy queues off-path work only after printing a current, bounded plan", async () => {
    const flow = writeFlow(`---\ndescription: answer with a color\nevolve: propose\n---\nSay GREEN.\n`);
    const feedback = recordComplaint(flow, "answer should be more direct");
    const suite = writeSuite(flow, feedback.id);
    const cases = (await import(`${suite}?queue=${Date.now()}`)).default as EvalCase[];
    await runEvalSuite({
      flowPath: flow,
      cases,
      runFlow: colorRunner,
      suiteKey: suite,
      ledgerPath: process.env.MDFLOW_EVAL_RESULTS,
      log: () => {},
    });
    const lines: string[] = [];
    let queued = false;
    await handleAutoEvolve(flow, { quickRerun: false, msSincePrevious: null }, (line) => lines.push(line), (path) => {
      queued = true;
      return {
        schemaVersion: 1,
        id: "evj_test",
        flow: identifyFlow(path),
        status: "queued",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        logPath: join(state, "jobs", "evj_test.log"),
      };
    });
    expect(queued).toBe(true);
    expect(lines.findIndex((line) => line.startsWith("cost:"))).toBeLessThan(lines.findIndex((line) => line.includes("queued proposal job")));
    expect(readFileSync(flow, "utf8")).toContain("Say GREEN.");
  });
});

describe("proposal-first run", () => {
  it("distinguishes a missing flow from a missing eval suite", async () => {
    const result = await runEvolve({ flowPath: join(root, "missing.md"), checkOnly: true });
    expect(result.exitCode).toBe(1);
    expect(result.decision.reasonCode).toBe("FLOW_NOT_FOUND");
  });

  it("automatic proposal requires a content-current receipt and configured feedback coverage", async () => {
    const flow = writeFlow(GREEN);
    const feedback = recordComplaint(flow, "be more polite");
    const suite = writeSuite(flow);
    const cases: EvalCase[] = [{ name: "answers green", evidence: [], check: ({ stdout }) => stdout.includes("GREEN") ? null : "expected GREEN" }];
    let drafts = 0;
    const stale = await runEvolve({ flowPath: flow, mode: "auto", draft: async () => { drafts++; return ""; }, runFlow: colorRunner, yes: true, log: () => {} });
    expect(stale.decision.reasonCode).toBe("VERIFICATION_STALE");
    expect(drafts).toBe(0);

    await runEvalSuite({
      flowPath: flow,
      cases,
      runFlow: colorRunner,
      suiteKey: suite,
      ledgerPath: process.env.MDFLOW_EVAL_RESULTS,
      log: () => {},
    });
    expect(await isVerificationCurrent(flow, suite, cases, getEvalLedgerEntry(suite, readEvalLedger()))).toBe(true);
    const importedCases = (await import(`${suite}?debug=${Date.now()}`)).default as EvalCase[];
    expect(await isVerificationCurrent(flow, suite, importedCases, getEvalLedgerEntry(suite, readEvalLedger()))).toBe(true);
    const polite: CandidateDrafter = async () => { drafts++; return JSON.stringify({ body: "Please Say GREEN." }); };
    const uncovered = await runEvolve({ flowPath: flow, mode: "auto", draft: polite, runFlow: colorRunner, yes: true, log: () => {} });
    expect(uncovered.decision.reasonCode).toBe("FEEDBACK_UNCOVERED");
    expect(drafts).toBe(0);
    const current = await runEvolve({
      flowPath: flow,
      mode: "auto",
      policy: resolveEvolutionPolicy({ mode: "propose", gate: { "require-feedback-eval": false } }),
      draft: polite,
      runFlow: colorRunner,
      yes: true,
      log: () => {},
    });
    expect(current.status).toBe("regression_safe");
    expect(current.applied).toBe(false);
    expect(readFileSync(flow, "utf8")).toBe(GREEN);
    expect(readEvidence().find((item) => item.id === feedback.id)?.status).toBe("targeted");
  });

  it("creates a verified-improvement receipt without changing source", async () => {
    const flow = writeFlow();
    const feedback = recordComplaint(flow, "blue is wrong");
    writeSuite(flow, feedback.id);
    const result = await runEvolve({ flowPath: flow, draft: greenDrafter, runFlow: colorRunner, yes: true, log: () => {} });

    expect(result.status).toBe("verified_improvement");
    expect(result.applied).toBe(false);
    expect(readFileSync(flow, "utf8")).toBe(BLUE);
    expect(readFileSync(result.proposalPath!, "utf8")).toBe(GREEN);
    expect(readEvolutionRun(result.runId!).targetEvidenceIds).toEqual([feedback.id]);
    expect(existsSync(join(repo, "color.pending.md"))).toBe(false);
    expect(existsSync(join(repo, ".mdflow-evolve-gate.json"))).toBe(false);
  });

  it("allows automatic comparative proof when every current failure is feedback-linked", async () => {
    const flow = writeFlow(`---\ndescription: answer with a color\nevolve: propose\n---\nSay BLUE.\n`);
    const feedback = recordComplaint(flow, "blue is wrong");
    const suite = writeSuite(flow, feedback.id);
    const cases = (await import(`${suite}?known-failure=${Date.now()}`)).default as EvalCase[];
    const baseline = await runEvalSuite({
      flowPath: flow,
      cases,
      runFlow: colorRunner,
      suiteKey: suite,
      ledgerPath: process.env.MDFLOW_EVAL_RESULTS,
      log: () => {},
    });
    expect(baseline.fail).toBe(1);
    expect(getEvalLedgerEntry(suite, readEvalLedger())?.currentClean).toBe(false);

    const result = await runEvolve({ flowPath: flow, mode: "auto", draft: greenDrafter, runFlow: colorRunner, yes: true, log: () => {} });
    expect(result.status).toBe("verified_improvement");
    expect(result.applied).toBe(false);
    expect(readFileSync(flow, "utf8")).toContain("Say BLUE.");
  });

  it("classifies equal green scores as regression-safe, not improvement", async () => {
    const flow = writeFlow(GREEN);
    recordComplaint(flow, "be more polite");
    writeSuite(flow);
    const drafter: CandidateDrafter = async () => JSON.stringify({ body: "Please Say GREEN." });
    const result = await runEvolve({ flowPath: flow, draft: drafter, runFlow: colorRunner, yes: true, log: () => {} });
    expect(result.status).toBe("regression_safe");
    expect(readEvolutionRun(result.runId!).resultReason).toContain("not measured");
    expect(readFileSync(flow, "utf8")).toBe(GREEN);
  });

  it("rejects a regression while retaining feedback for retry", async () => {
    const flow = writeFlow();
    const feedback = recordComplaint(flow, "wrong color");
    writeSuite(flow, feedback.id);
    const result = await runEvolve({ flowPath: flow, draft: redDrafter, runFlow: colorRunner, yes: true, log: () => {} });
    expect(result.status).toBe("rejected");
    expect(readFileSync(flow, "utf8")).toBe(BLUE);
    expect((await gatherEvidence(flow)).complaints.map((item) => item.id)).toContain(feedback.id);
    expect(readEvidence().find((item) => item.id === feedback.id)?.status).toBe("open");
  });

  it("blocks a new inline command before candidate evaluation", async () => {
    const flow = writeFlow();
    const feedback = recordComplaint(flow, "wrong color");
    writeSuite(flow, feedback.id);
    let evalRuns = 0;
    const runner: FlowRunner = async (spec) => { evalRuns++; return colorRunner(spec); };
    const hostile: CandidateDrafter = async () => JSON.stringify({ body: "!`touch /tmp/mdflow-should-not-run`\nSay GREEN." });
    const result = await runEvolve({ flowPath: flow, draft: hostile, runFlow: runner, yes: true, log: () => {} });
    expect(result.status).toBe("capability_rejected");
    expect(evalRuns).toBe(1);
    expect(existsSync("/tmp/mdflow-should-not-run")).toBe(false);
    expect(readFileSync(flow, "utf8")).toBe(BLUE);
    expect(readEvidence().find((item) => item.id === feedback.id)?.status).toBe("open");
  });

  it("plan mode is free and does not create a run", async () => {
    const flow = writeFlow();
    const feedback = recordComplaint(flow, "wrong color");
    writeSuite(flow, feedback.id);
    let drafts = 0;
    const result = await runEvolve({
      flowPath: flow,
      checkOnly: true,
      yes: true,
      draft: async () => { drafts++; return ""; },
      runFlow: colorRunner,
      log: () => {},
    });
    expect(result.decision.evolve).toBe(true);
    expect(drafts).toBe(0);
    expect(existsSync(join(state, "runs"))).toBe(false);
  });

  it("plan mode statically inspects an eval suite without executing top-level code", async () => {
    const flow = writeFlow();
    recordComplaint(flow, "wrong color");
    const marker = join(root, "suite-imported.txt");
    writeFileSync(flow.replace(/\.md$/, ".eval.ts"), `
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(marker)}, "executed");
      export default [{ name: "answers green", check: () => null }];
    `);
    const result = await runEvolve({ flowPath: flow, checkOnly: true, log: () => {} });
    expect(result.exitCode).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it("captures workflow feedback but explicitly refuses unattributed workflow proposals", async () => {
    const flow = writeFlow(`---\ndescription: workflow\n_steps:\n  - id: answer\n    flow: ./child.md\n---\nWorkflow body.\n`);
    const feedback = recordComplaint(flow, "the answer step was wrong");
    writeSuite(flow, feedback.id);
    let drafts = 0;
    const result = await runEvolve({ flowPath: flow, draft: async () => { drafts++; return JSON.stringify({ body: "changed" }); }, runFlow: colorRunner, yes: true, log: () => {} });
    expect(result.decision.reasonCode).toBe("WORKFLOW_UNSUPPORTED");
    expect(drafts).toBe(0);
    expect(readEvidence().find((item) => item.id === feedback.id)?.status).toBe("open");
  });

  it("does not spend without --yes in a non-TTY", async () => {
    const flow = writeFlow();
    const feedback = recordComplaint(flow, "wrong color");
    writeSuite(flow, feedback.id);
    let drafts = 0;
    const result = await runEvolve({ flowPath: flow, draft: async () => { drafts++; return ""; }, runFlow: colorRunner, log: () => {} });
    expect(result.exitCode).toBe(1);
    expect(drafts).toBe(0);
  });
});

describe("transactional apply and rollback", () => {
  async function verifiedRun() {
    const flow = writeFlow();
    const feedback = recordComplaint(flow, "wrong color");
    writeSuite(flow, feedback.id);
    const result = await runEvolve({ flowPath: flow, draft: greenDrafter, runFlow: colorRunner, yes: true, log: () => {} });
    return { flow, feedback, result };
  }

  it("applies with compare-and-swap and rolls back with lineage", async () => {
    const { flow, result } = await verifiedRun();
    const applied = await applyEvolutionRun(result.runId!);
    expect(applied.status).toBe("applied");
    expect(readFileSync(flow, "utf8")).toBe(GREEN);
    expect(readEvidence()[0]!.status).toBe("resolved");
    const rolledBack = rollbackEvolutionRun(result.runId!);
    expect(rolledBack.status).toBe("rolled_back");
    expect(readFileSync(flow, "utf8")).toBe(BLUE);
    expect(readEvidence()[0]!.status).toBe("open");
  });

  it("does not turn a proposed body into executable configuration", () => {
    for (const candidate of ["---\nengine: sh\n---\nhello", "---   \n_env: { FOO: bar }\n---\nhello", "#!/usr/bin/env sh\nhello"]) {
      expect(() => replaceFlowBody("hello", candidate)).toThrow(/Body-only/);
    }
  });

  it("refuses altered proposal AND rollback artifacts without changing source or evidence", async () => {
    const { flow, result } = await verifiedRun();
    const id = result.runId!;
    const proposal = join(evolutionRunPath(id), "proposal.md");
    const originalProposal = readFileSync(proposal, "utf8");
    writeFileSync(proposal, "Not the verified proposal");
    await expect(applyEvolutionRun(id)).rejects.toThrow("hash mismatch");
    expect(readFileSync(flow, "utf8")).toBe(BLUE);
    expect(readEvidence()[0]!.status).toBe("targeted");
    writeFileSync(proposal, originalProposal);
    await applyEvolutionRun(id);
    writeFileSync(join(evolutionRunPath(id), "current.md"), "Not the original");
    expect(() => rollbackEvolutionRun(id)).toThrow("hash mismatch");
    expect(readFileSync(flow, "utf8")).toBe(GREEN);
    expect(readEvidence()[0]!.status).toBe("resolved");
  });

  it("refuses to overwrite a human edit made after proposal creation", async () => {
    const { flow, result } = await verifiedRun();
    writeFileSync(flow, `${BLUE}\nHuman edit\n`);
    await expect(applyEvolutionRun(result.runId!)).rejects.toThrow("changed");
    expect(readFileSync(flow, "utf8")).toContain("Human edit");
  });

  it("refuses stale proof when the suite changes after proposal verification", async () => {
    const { flow, result } = await verifiedRun();
    const suite = flow.replace(/\.md$/, ".eval.ts");
    writeFileSync(suite, `${readFileSync(suite, "utf8")}\n// human changed the proof\n`);
    await expect(applyEvolutionRun(result.runId!)).rejects.toThrow("suiteHash");
    expect(readFileSync(flow, "utf8")).toBe(BLUE);
  });

  it("rolls the flow back if evidence persistence fails after the proposal write", async () => {
    const { flow, result } = await verifiedRun();
    const evidencePath = evidenceFilePath();
    const backup = `${evidencePath}.bak`;
    renameSync(evidencePath, backup);
    mkdirSync(evidencePath);
    await expect(applyEvolutionRun(result.runId!)).rejects.toThrow();
    expect(readFileSync(flow, "utf8")).toBe(BLUE);
    rmSync(evidencePath, { recursive: true, force: true });
    renameSync(backup, evidencePath);
  });

  it("uses a per-flow lock and rejects concurrent attempts", () => {
    const flow = writeFlow();
    const first = acquireFlowLock(flow);
    try {
      expect(() => acquireFlowLock(flow)).toThrow("already running");
    } finally {
      first.release();
    }
    const second = acquireFlowLock(flow);
    second.release();
  });

  it("stores every proposal under a unique private run id", async () => {
    const { result } = await verifiedRun();
    expect(result.runId).toStartWith("evr_");
    expect(result.proposalPath).toStartWith(evolutionRunPath(result.runId!));
    expect(existsSync(result.proposalPath!)).toBe(true);
    expect(readEvolutionArtifact(result.runId!, "proposal.diff")).toContain("proposal.md");
  });

  it("prune derives owned job log paths instead of deleting a recorded absolute path", () => {
    const outside = join(repo, "important.txt"); writeFileSync(outside, "KEEP");
    const jobs = join(state, "jobs"); mkdirSync(jobs, { recursive: true });
    writeFileSync(join(jobs, "evj_test.json"), JSON.stringify({ id: "evj_test", status: "completed", updatedAt: "2000-01-01", logPath: outside }));
    writeFileSync(join(jobs, "evj_test.log"), "old log");
    expect(pruneEvolutionData(0).jobs).toBe(1); expect(readFileSync(outside, "utf8")).toBe("KEEP");
    expect(existsSync(join(jobs, "evj_test.log"))).toBe(false);
  });

  it("prunes old private proposals but retains applied rollback lineage", async () => {
    const first = await verifiedRun();
    expect(pruneEvolutionData(0).runs).toBe(1);
    expect(existsSync(evolutionRunPath(first.result.runId!))).toBe(false);

    const second = await verifiedRun();
    await applyEvolutionRun(second.result.runId!);
    expect(pruneEvolutionData(0).runs).toBe(0);
    expect(existsSync(evolutionRunPath(second.result.runId!))).toBe(true);
  });

  it("recovers an interrupted apply from durable state and content hashes", async () => {
    const { flow, result } = await verifiedRun();
    const runId = result.runId!;
    updateEvolutionRun(runId, { status: "applying" });
    writeFileSync(flow, readEvolutionArtifact(runId, "proposal.md"));
    const recovered = recoverEvolutionRun(runId);
    expect(recovered.status).toBe("applied");
    expect(readFileSync(flow, "utf8")).toBe(GREEN);
  });
});

describe("CLI lifecycle", () => {
  it("supports successful subcommand help", async () => {
    const output: string[] = [];
    const prior = console.log;
    console.log = (...args: unknown[]) => output.push(args.join(" "));
    try {
      expect(runFeedbackCli(["--help"])).toBe(0);
      expect(await runEvolveCli(["--help"])).toBe(0);
    } finally {
      console.log = prior;
    }
    expect(output.join("\n")).toContain("md evolve plan");
  });

  it("emits one JSON plan object for agents and CI", async () => {
    const flow = writeFlow();
    const feedback = recordComplaint(flow, "wrong color");
    writeSuite(flow, feedback.id);
    const output: string[] = [];
    const prior = console.log;
    console.log = (...args: unknown[]) => output.push(args.join(" "));
    try {
      expect(await runEvolveCli(["plan", flow, "--json"])).toBe(0);
    } finally {
      console.log = prior;
    }
    expect(output).toHaveLength(1);
    const parsed = JSON.parse(output[0]!) as { events: Array<{ type: string }>; result: { applied: boolean } };
    expect(parsed.events.map((item) => item.type)).toContain("evolve.plan");
    expect(parsed.result.applied).toBe(false);
  });

  it("emits one structured JSON error when a lifecycle command fails", async () => {
    const output: string[] = [];
    const prior = console.log;
    console.log = (...args: unknown[]) => output.push(args.join(" "));
    try {
      expect(await runEvolveCli(["show", "evr_missing", "--json"])).toBe(1);
    } finally {
      console.log = prior;
    }
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!)).toMatchObject({ error: { reasonCode: "EVOLVE_COMMAND_FAILED" } });
  });

  it("keeps usage failures machine-readable in JSON mode", async () => {
    const output: string[] = [];
    const prior = console.log;
    console.log = (...args: unknown[]) => output.push(args.join(" "));
    try {
      expect(await runEvolveCli(["show", "--json"])).toBe(1);
      expect(runFeedbackCli(["show", "--json"])).toBe(1);
    } finally {
      console.log = prior;
    }
    expect(output).toHaveLength(2);
    expect(output.map((line) => JSON.parse(line).error.reasonCode)).toEqual(["USAGE", "USAGE"]);
  });
});
