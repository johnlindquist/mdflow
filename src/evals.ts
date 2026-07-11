/**
 * Behavioral evals for flows — `md eval <flow.md>`.
 *
 * Creed: "If a guardrail isn't covered by an eval, it's a wish." A flow's
 * prompt promises behavior; an eval suite is the only proof. Each case runs
 * the flow for real (one paid invocation per trial — cost is printed before
 * anything runs) inside an isolated temp workspace, then a check function asserts on
 * stdout AND the resulting filesystem. Write checks on invariants (files,
 * numbers, names), not exact wording.
 *
 * Suites are colocated with their flow: flows/jq.md → flows/jq.eval.ts,
 * exporting `default` an EvalCase[]. Results land in the trust ledger
 * (~/.mdflow/eval-results.json, override MDFLOW_EVAL_RESULTS) — a full clean
 * run stores a content-bound verification receipt. `lastCleanAt` remains only
 * as compatibility/history metadata; Evolve gates on the exact fingerprint.
 *
 * Eval runs are synthetic, not real usage: the runner points MDFLOW_RUNS_FILE
 * into the sandbox so they never pollute the run-telemetry corpus that
 * learning features feed on.
 */

import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir, homedir } from "os";
import { join, dirname, resolve, basename, relative } from "path";
import { loadFullConfig } from "./config";
import { resolveEngine } from "./command";
import { atomicWriteJson, withAtomicFileLock } from "./evolution-store";
import { canonicalFlowPath, findRepositoryRoot, identifyFlow, resolveEvolutionPolicy, sha256, splitFlowDocument } from "./evolution-core";
import { parseImports } from "./imports-parser";
import { parseFrontmatter } from "./parse";
import { resolveHooksFile } from "./hooks";
import ts from "typescript";

export interface EvalContext {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
  failureClass?: "provider" | "auth" | "environment" | "cancelled" | "unknown";
  /** The isolated temporary workspace the flow ran in. */
  dir: string;
}

export interface EvalCase {
  name: string;
  /** Extra prompt appended to the flow's body (like asking it a question). */
  prompt?: string;
  /** Piped stdin content. */
  stdin?: string;
  /**
   * Where the flow runs. Default: a fresh isolated temp workspace per case.
   * Repo-bound flows (project rosters that inspect the live repository) set
   * this to a path relative to the flow file (e.g. ".." for the repo root);
   * no cleanup happens for an explicit cwd.
   */
  cwd?: string;
  /** Prepare fixtures inside the temporary workspace before the flow runs. */
  setup?: (dir: string) => void | Promise<void>;
  /** Return null on pass, or a human-readable failure reason. */
  check: (ctx: EvalContext) => string | null | Promise<string | null>;
  timeoutMs?: number;
  /** Feedback IDs this case reproduces. Required for verified-improvement claims. */
  evidence?: string[];
  /** Non-zero exit is a harness failure unless a case explicitly opts out. */
  allowNonZero?: boolean;
  kind?: "deterministic" | "stochastic" | "networked" | "repo-mutating";
  /** Independent trials. Defaults to one. */
  repetitions?: number;
  /** Required passing trials. Defaults to repetitions. Mixed results are flagged as flaky. */
  quorum?: number;
}

export interface EvalCasePlan {
  name: string;
  evidence: string[];
  repetitions: number;
  quorum: number;
}

export interface EvalSuitePlan {
  cases: EvalCasePlan[];
  invocations: number;
}

function unwrapExpression(node: ts.Expression, bindings: Map<string, ts.Expression>): ts.Expression {
  let current = node;
  const seen = new Set<ts.Expression>();
  while (true) {
    if (seen.has(current)) return current;
    seen.add(current);
    if (ts.isIdentifier(current) && bindings.has(current.text)) {
      current = bindings.get(current.text)!;
      continue;
    }
    if (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) || ts.isSatisfiesExpression(current)) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

function propertyKey(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function staticValue(node: ts.Expression): unknown {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map((item) => staticValue(item as ts.Expression));
  return undefined;
}

/** Read eval cost/coverage without executing the suite's top-level code. */
export function inspectEvalSuitePlan(suitePath: string, policyRepetitions = 1): EvalSuitePlan {
  const source = readFileSync(suitePath, "utf8");
  const file = ts.createSourceFile(suitePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const bindings = new Map<string, ts.Expression>();
  let exported: ts.Expression | undefined;
  for (const statement of file.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) bindings.set(declaration.name.text, declaration.initializer);
      }
    } else if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      exported = statement.expression;
    }
  }
  if (!exported) throw new Error(`${suitePath}: static plan requires an export default EvalCase[]`);
  const expression = unwrapExpression(exported, bindings);
  if (!ts.isArrayLiteralExpression(expression)) {
    throw new Error(`${suitePath}: static plan requires export default to resolve to an array literal`);
  }

  const cases = expression.elements.map((element, index): EvalCasePlan => {
    const value = unwrapExpression(element as ts.Expression, bindings);
    if (!ts.isObjectLiteralExpression(value)) {
      throw new Error(`${suitePath}: case ${index + 1} must be an object literal for safe planning`);
    }
    const properties = new Map<string, ts.Expression>();
    for (const property of value.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const key = propertyKey(property.name);
      if (key) properties.set(key, property.initializer);
    }
    const name = properties.has("name") ? staticValue(properties.get("name")!) : undefined;
    if (typeof name !== "string" || !name.trim()) {
      throw new Error(`${suitePath}: case ${index + 1} needs a static string name for safe planning`);
    }
    const repetitionsValue = properties.has("repetitions") ? staticValue(properties.get("repetitions")!) : policyRepetitions;
    const repetitions = typeof repetitionsValue === "number" ? repetitionsValue : Number.NaN;
    const quorumValue = properties.has("quorum") ? staticValue(properties.get("quorum")!) : repetitions;
    const quorum = typeof quorumValue === "number" ? quorumValue : Number.NaN;
    if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 100) {
      throw new Error(`${suitePath}: ${name} repetitions must be a static integer from 1 to 100`);
    }
    if (!Number.isInteger(quorum) || quorum < 1 || quorum > repetitions) {
      throw new Error(`${suitePath}: ${name} quorum must be a static integer from 1 to repetitions`);
    }
    const evidenceValue = properties.has("evidence") ? staticValue(properties.get("evidence")!) : [];
    if (!Array.isArray(evidenceValue) || !evidenceValue.every((item) => typeof item === "string")) {
      throw new Error(`${suitePath}: ${name} evidence must be a static string array for safe planning`);
    }
    return { name, evidence: evidenceValue as string[], repetitions, quorum };
  });
  if (cases.length === 0) throw new Error(`${suitePath} has no cases (export default an EvalCase[])`);
  return { cases, invocations: cases.reduce((total, item) => total + item.repetitions, 0) };
}

export interface FlowRunSpec {
  flowPath: string;
  prompt?: string;
  stdin?: string;
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string>;
}

export type FlowRunner = (spec: FlowRunSpec) => Promise<Omit<EvalContext, "dir">>;

export interface EvalSuiteOutcome {
  pass: number;
  fail: number;
  total: number;
  failures: string[];
  inconclusive: number;
  flaky: number;
  invocations: number;
  cases: EvalCaseOutcome[];
}

export interface EvalTrialOutcome {
  trial: number;
  status: "pass" | "fail" | "inconclusive";
  reason?: string;
  exitCode?: number;
  timedOut?: boolean;
  failureClass?: EvalContext["failureClass"];
}

export interface EvalCaseOutcome {
  name: string;
  status: "pass" | "fail" | "inconclusive";
  reason?: string;
  exitCode?: number;
  timedOut?: boolean;
  evidence: string[];
  repetitions: number;
  quorum: number;
  passCount: number;
  flaky: boolean;
  trials: EvalTrialOutcome[];
}

export interface VerificationFingerprint {
  fingerprint: string;
  flowHash: string;
  suiteHash: string;
  configHash: string;
  mdflowVersion: string;
  engine: string;
  engineSource: string;
  model?: string;
  caseIds: string[];
  createdAt: string;
}

export type VerificationEnvironmentFingerprint = Omit<VerificationFingerprint, "fingerprint" | "caseIds" | "createdAt">;

export interface EvalLedgerEntry {
  flow: string;
  /** Stable identity used to find this receipt after a checkout moves. */
  flowId?: string;
  pass: number;
  fail: number;
  total: number;
  lastRunAt: string;
  /** True when the run covered every case in the suite (no --filter). */
  full: boolean;
  /** Last time a FULL run of this suite passed every case. */
  lastCleanAt?: string;
  /** True only when the most recent full result for this exact fingerprint is clean. */
  currentClean?: boolean;
  verification?: VerificationFingerprint;
  lastRunFingerprint?: string;
  inconclusive?: number;
  flaky?: number;
  cases?: EvalCaseOutcome[];
}

const DEFAULT_TIMEOUT_MS = 180_000;

/** flows/jq.md → flows/jq.eval.ts (any .md flow, engine-suffixed or bare). */
export function resolveEvalSuitePath(flowPath: string): string {
  return flowPath.replace(/\.md$/i, ".eval.ts");
}

export function evalLedgerPath(): string {
  const override = process.env.MDFLOW_EVAL_RESULTS?.trim();
  return override ? override : join(homedir(), ".mdflow", "eval-results.json");
}

export function readEvalLedger(path = evalLedgerPath()): Record<string, EvalLedgerEntry> {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

export function getEvalLedgerEntry(
  suitePath: string,
  ledger = readEvalLedger()
): EvalLedgerEntry | undefined {
  const flowPath = suitePath.replace(/\.eval\.ts$/i, ".md");
  const flowId = identifyFlow(flowPath).id;
  if (ledger[`flow:${flowId}`]) return ledger[`flow:${flowId}`];
  const canonical = canonicalFlowPath(suitePath);
  if (ledger[canonical]) return ledger[canonical];
  const absolute = resolve(suitePath);
  if (ledger[absolute]) return ledger[absolute];
  for (const [key, entry] of Object.entries(ledger)) {
    if (canonicalFlowPath(key) === canonical) return entry;
  }
  return undefined;
}

function packageVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { version: string }).version;
  } catch {
    return "unknown";
  }
}

function logicalPath(root: string, path: string): string {
  return relative(root, path).split("\\").join("/") || basename(path);
}

function hashLocalModuleGraph(entryPath: string, seen = new Set<string>(), graphRoot = dirname(resolve(entryPath))): string {
  const absolute = resolve(entryPath);
  if (seen.has(absolute) || !existsSync(absolute)) return "";
  seen.add(absolute);
  const content = readFileSync(absolute, "utf8");
  const pieces = [`${logicalPath(graphRoot, absolute)}:${sha256(content)}`];
  for (const match of content.matchAll(/(?:from\s+|import\s*\(|require\s*\()?["'](\.{1,2}\/[^"']+)["']/g)) {
    const specifier = match[1];
    if (!specifier) continue;
    const base = resolve(dirname(absolute), specifier);
    const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, join(base, "index.ts"), join(base, "index.js")];
    const dependency = candidates.find((candidate) => existsSync(candidate));
    if (dependency) pieces.push(hashLocalModuleGraph(dependency, seen, graphRoot));
  }
  return pieces.join("\n");
}

function hashFlowGraph(
  flowPath: string,
  seen = new Set<string>(),
  graphRoot = findRepositoryRoot(flowPath) ?? dirname(canonicalFlowPath(flowPath))
): string {
  const absolute = canonicalFlowPath(flowPath);
  if (seen.has(absolute) || !existsSync(absolute)) return "";
  seen.add(absolute);
  const content = readFileSync(absolute, "utf8");
  const pieces = [`${logicalPath(graphRoot, absolute)}:${sha256(content)}`];
  // Lifecycle hooks are part of the flow's behavior: a changed hook program
  // must invalidate eval receipts exactly like a changed body would.
  try {
    const hooksResolved = resolveHooksFile({
      flowPath: absolute,
      frontmatterValue: (parseFrontmatter(content).frontmatter as Record<string, unknown>)?.["_hooks"],
    });
    if (hooksResolved.kind === "file" && !hooksResolved.missing && !hooksResolved.rejected) {
      pieces.push(
        `${logicalPath(graphRoot, canonicalFlowPath(hooksResolved.path))}:${sha256(readFileSync(hooksResolved.path))}`
      );
    }
  } catch {
    // Unparseable frontmatter: the flow hash above already covers the bytes.
  }
  for (const action of parseImports(splitFlowDocument(content).body)) {
    if (action.type === "file" || action.type === "symbol") {
      const path = resolve(dirname(absolute), action.path);
      if (!existsSync(path)) continue;
      if (/\.md(?:own)?$/i.test(path)) pieces.push(hashFlowGraph(path, seen, graphRoot));
      else pieces.push(`${logicalPath(graphRoot, canonicalFlowPath(path))}:${sha256(readFileSync(path))}`);
    } else if (action.type === "glob") {
      const glob = new Bun.Glob(action.pattern);
      for (const file of [...glob.scanSync({ cwd: dirname(absolute), absolute: true })].sort()) {
        if (existsSync(file)) pieces.push(`${logicalPath(graphRoot, canonicalFlowPath(file))}:${sha256(readFileSync(file))}`);
      }
    }
  }
  return pieces.join("\n");
}

export async function buildVerificationEnvironmentFingerprint(
  flowPath: string,
  suitePath: string
): Promise<VerificationEnvironmentFingerprint> {
  const flow = canonicalFlowPath(flowPath);
  const suite = canonicalFlowPath(suitePath);
  const config = await loadFullConfig(dirname(flow));
  const frontmatter = parseFrontmatter(readFileSync(flow, "utf8")).frontmatter;
  const resolvedEngine = resolveEngine(flow, frontmatter, { configEngine: config.engine });
  const configuredModel = frontmatter.model ?? config.commands?.[resolvedEngine.engine]?.model;
  const flowHash = sha256(hashFlowGraph(flow));
  const suiteHash = sha256(hashLocalModuleGraph(suite));
  const configHash = sha256(JSON.stringify(config));
  const mdflowVersion = packageVersion();
  const engine = resolvedEngine.engine;
  const engineSource = resolvedEngine.source;
  const model = typeof configuredModel === "string" ? configuredModel : undefined;
  return {
    flowHash,
    suiteHash,
    configHash,
    mdflowVersion,
    engine,
    engineSource,
    model,
  };
}

export async function buildVerificationFingerprint(
  flowPath: string,
  suitePath: string,
  cases: Array<EvalCase | EvalCasePlan>
): Promise<VerificationFingerprint> {
  const environment = await buildVerificationEnvironmentFingerprint(flowPath, suitePath);
  const caseIds = cases.map((item) => sha256(JSON.stringify({
    name: item.name,
    evidence: item.evidence ?? [],
    repetitions: item.repetitions ?? 1,
    quorum: item.quorum ?? item.repetitions ?? 1,
  })).slice(0, 20));
  return {
    ...environment,
    fingerprint: sha256(JSON.stringify({ ...environment, caseIds })),
    caseIds,
    createdAt: new Date().toISOString(),
  };
}

export async function isVerificationCurrent(
  flowPath: string,
  suitePath: string,
  cases: EvalCase[],
  entry = getEvalLedgerEntry(suitePath)
): Promise<boolean> {
  if (!entry?.currentClean || !entry.verification) return false;
  const current = await buildVerificationFingerprint(flowPath, suitePath, cases);
  return current.fingerprint === entry.verification.fingerprint;
}

export function recordEvalResult(
  suite: string,
  result: Omit<EvalLedgerEntry, "lastCleanAt">,
  path = evalLedgerPath()
): void {
  withAtomicFileLock(path, () => {
    const all = readEvalLedger(path);
    const flowId = identifyFlow(result.flow).id;
    const prev = all[`flow:${flowId}`] ?? all[suite];
    const clean = result.full && result.fail === 0 && result.total > 0 && Boolean(result.verification);
    const lastCleanAt = clean ? result.lastRunAt : prev?.lastCleanAt;
    const entry = {
      ...result,
      flowId,
      currentClean: clean && Boolean(result.verification),
      verification: result.verification ?? prev?.verification,
      ...(lastCleanAt ? { lastCleanAt } : {}),
    };
    all[suite] = entry;
    all[`flow:${flowId}`] = entry;
    atomicWriteJson(path, all);
  });
}

/**
 * Default runner: spawn the md CLI on the flow inside the sandbox.
 * MDFLOW_RUNS_FILE is redirected into the sandbox so synthetic eval runs
 * never enter the real telemetry corpus.
 */
export function makeCliFlowRunner(cliPath: string): FlowRunner {
  return async ({ flowPath, prompt, stdin, cwd, timeoutMs, env }) => {
    const args = [cliPath, resolve(flowPath)];
    if (prompt) args.push(prompt);

    const proc = Bun.spawn(["bun", "run", ...args], {
      cwd,
      stdin: stdin !== undefined ? new TextEncoder().encode(stdin) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        ...env,
        MDFLOW_RUNS_FILE: join(cwd, ".mdflow-eval-runs.jsonl"),
        MDFLOW_EVAL_RUN: "1",
      },
      detached: process.platform !== "win32",
    });

    const killTree = (signal: NodeJS.Signals) => {
      if (process.platform !== "win32") {
        try { process.kill(-proc.pid, signal); return; } catch {}
      }
      try { proc.kill(signal); } catch {}
    };

    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        killTree("SIGTERM");
        killTimer = setTimeout(() => {
          killTree("SIGKILL");
        }, 2_000);
      } catch {}
    }, timeoutMs);

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);

    const failureText = `${stderr}\n${stdout}`;
    const failureClass: EvalContext["failureClass"] = timedOut
      ? undefined
      : /(?:unauthori[sz]ed|authentication|invalid api key|missing api key|\b401\b|\b403\b)/i.test(failureText)
        ? "auth"
        : /(?:rate.?limit|too many requests|overloaded|service unavailable|\b429\b|ECONN|network error)/i.test(failureText)
          ? "provider"
          : exitCode === 127 || /(?:command not found|module not found|dependency)/i.test(failureText)
            ? "environment"
            : exitCode === 130 ? "cancelled"
            : exitCode === 0 ? undefined : "unknown";
    return { stdout, stderr, exitCode, timedOut, failureClass };
  };
}

export interface RunEvalSuiteOptions {
  flowPath: string;
  cases: EvalCase[];
  runFlow: FlowRunner;
  filter?: string;
  log?: (line: string) => void;
  suiteKey?: string;
  ledgerPath?: string;
  /** Skip ledger writes entirely (used by unit tests). */
  noLedger?: boolean;
  env?: Record<string, string>;
}

export function applyPolicyRepetitions(cases: EvalCase[], repetitions: number): EvalCase[] {
  return cases.map((item) => item.repetitions === undefined
    ? { ...item, repetitions, quorum: item.quorum ?? repetitions }
    : item);
}

function trialPlan(evalCase: EvalCase): { repetitions: number; quorum: number } {
  const repetitions = evalCase.repetitions ?? 1;
  const quorum = evalCase.quorum ?? repetitions;
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 100) {
    throw new Error(`${evalCase.name}: repetitions must be an integer from 1 to 100`);
  }
  if (!Number.isInteger(quorum) || quorum < 1 || quorum > repetitions) {
    throw new Error(`${evalCase.name}: quorum must be an integer from 1 to repetitions`);
  }
  return { repetitions, quorum };
}

export function evalInvocationCount(cases: EvalCase[]): number {
  return cases.reduce((total, item) => total + trialPlan(item).repetitions, 0);
}

export async function runEvalSuite(options: RunEvalSuiteOptions): Promise<EvalSuiteOutcome> {
  const { flowPath, runFlow, filter } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  const selected = filter
    ? options.cases.filter((c) => c.name.toLowerCase().includes(filter.toLowerCase()))
    : options.cases;

  const outcome: EvalSuiteOutcome = {
    pass: 0,
    fail: 0,
    inconclusive: 0,
    flaky: 0,
    invocations: 0,
    total: selected.length,
    failures: [],
    cases: [],
  };

  for (const evalCase of selected) {
    let plan: { repetitions: number; quorum: number };
    try {
      plan = trialPlan(evalCase);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      outcome.fail++;
      outcome.failures.push(reason);
      outcome.cases.push({
        name: evalCase.name,
        status: "fail",
        reason,
        evidence: evalCase.evidence ?? [],
        repetitions: 0,
        quorum: 0,
        passCount: 0,
        flaky: false,
        trials: [],
      });
      log(`  ✗ ${reason}`);
      continue;
    }

    const trials: EvalTrialOutcome[] = [];
    for (let trial = 1; trial <= plan.repetitions; trial++) {
      const usingSandbox = !evalCase.cwd;
      const dir = usingSandbox
        ? mkdtempSync(join(tmpdir(), "mdflow-eval-"))
        : resolve(dirname(resolve(flowPath)), evalCase.cwd!);
      outcome.invocations++;
      try {
        await evalCase.setup?.(dir);
        const run = await runFlow({
          flowPath,
          prompt: evalCase.prompt,
          stdin: evalCase.stdin,
          cwd: dir,
          timeoutMs: evalCase.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          env: options.env,
        });
        if (run.timedOut) {
          trials.push({ trial, status: "inconclusive", reason: `timed out after ${evalCase.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`, exitCode: run.exitCode, timedOut: true });
        } else if (run.exitCode !== 0 && run.failureClass && run.failureClass !== "unknown" && !evalCase.allowNonZero) {
          trials.push({ trial, status: "inconclusive", reason: `${run.failureClass} failure (exit ${run.exitCode})`, exitCode: run.exitCode, failureClass: run.failureClass });
        } else if (run.exitCode !== 0 && !evalCase.allowNonZero) {
          trials.push({ trial, status: "fail", reason: `flow exited ${run.exitCode}`, exitCode: run.exitCode });
        } else {
          const verdict = await evalCase.check({ ...run, dir });
          trials.push(verdict === null
            ? { trial, status: "pass", exitCode: run.exitCode }
            : { trial, status: "fail", reason: verdict, exitCode: run.exitCode });
        }
      } catch (err) {
        trials.push({ trial, status: "fail", reason: err instanceof Error ? err.message : String(err) });
      } finally {
        // Only ever delete dirs this run created. An explicit cwd is the
        // user's real directory and must never be cleaned up.
        if (usingSandbox) {
          try { rmSync(dir, { recursive: true, force: true }); } catch {}
        }
      }
    }

    const passCount = trials.filter((item) => item.status === "pass").length;
    const failCount = trials.filter((item) => item.status === "fail").length;
    const inconclusiveCount = trials.filter((item) => item.status === "inconclusive").length;
    const flaky = passCount > 0 && failCount > 0;
    if (flaky) outcome.flaky++;
    let status: EvalCaseOutcome["status"];
    let reason: string | undefined;
    if (inconclusiveCount > 0) {
      status = "inconclusive";
      reason = `${inconclusiveCount}/${plan.repetitions} trial(s) inconclusive`;
      outcome.inconclusive++;
    } else if (passCount >= plan.quorum) {
      status = "pass";
      outcome.pass++;
      if (flaky) reason = `quorum met (${passCount}/${plan.repetitions}) but results were flaky`;
    } else {
      status = "fail";
      reason = plan.repetitions === 1
        ? trials[0]?.reason ?? "case failed"
        : `quorum missed (${passCount}/${plan.repetitions}, needed ${plan.quorum})`;
      outcome.fail++;
    }
    const representative = trials.find((item) => item.status !== "pass");
    const caseOutcome: EvalCaseOutcome = {
      name: evalCase.name,
      status,
      reason,
      exitCode: representative?.exitCode,
      timedOut: representative?.timedOut,
      evidence: evalCase.evidence ?? [],
      repetitions: plan.repetitions,
      quorum: plan.quorum,
      passCount,
      flaky,
      trials,
    };
    outcome.cases.push(caseOutcome);
    for (const trial of trials) {
      if (trial.status !== "pass" && trial.reason) {
        outcome.failures.push(plan.repetitions === 1
          ? `${evalCase.name}: ${trial.reason}`
          : `${evalCase.name} [trial ${trial.trial}]: ${trial.reason}`);
      }
    }
    const symbol = status === "pass" && !flaky ? "✓" : status === "fail" ? "✗" : "?";
    log(`  ${symbol} ${evalCase.name}${plan.repetitions > 1 ? `: ${passCount}/${plan.repetitions} passed (quorum ${plan.quorum})` : reason ? `: ${reason}` : ""}${flaky ? " — FLAKY" : ""}`);
  }

  if (!options.noLedger) {
    const suitePath = canonicalFlowPath(options.suiteKey ?? resolveEvalSuitePath(resolve(flowPath)));
    const verification = !filter && outcome.inconclusive === 0 && outcome.flaky === 0 && outcome.total > 0
      ? await buildVerificationFingerprint(flowPath, suitePath, options.cases)
      : undefined;
    recordEvalResult(
      suitePath,
      {
        flow: resolve(flowPath),
        pass: outcome.pass,
        fail: outcome.fail,
        total: outcome.total,
        lastRunAt: new Date().toISOString(),
        full: !filter,
        currentClean: Boolean(verification) && outcome.fail === 0,
        verification,
        lastRunFingerprint: verification?.fingerprint,
        inconclusive: outcome.inconclusive,
        flaky: outcome.flaky,
        cases: outcome.cases,
      },
      options.ledgerPath
    );
  }

  return outcome;
}

/** `md eval <flow.md> [--plan] [--yes] [--filter <substr>] [--json]` */
export async function runEvalCli(args: string[], cliPath?: string): Promise<number> {
  const yes = args.includes("--yes") || args.includes("-y");
  const planOnly = args.includes("--plan");
  const json = args.includes("--json");
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage: md eval <flow.md> [--plan] [--yes] [--filter <substring>] [--json]

Run the flow's behavioral eval suite. The suite is a colocated TypeScript
file: <flow>.md is paired with <flow>.eval.ts (flows/review.md ->
flows/review.eval.ts) that default-exports an EvalCase[]:

  export default [
    {
      name: "answers with a number",
      prompt: "What is 2+2?",
      check: (output) => /4/.test(output),
    },
  ];

Steps and cost:
  md eval flow.md --plan   FREE - static plan only: case names and the paid
                           invocation count; never imports executable suite code
  md eval flow.md          PAID - runs each case against the engine; prints the
                           cost first and asks for confirmation in a TTY

Options:
  --yes, -y                Skip the confirmation (REQUIRED when stdin is not a
                           TTY - agents and CI must pass --yes to spend)
  --filter <substring>     Run only cases whose name contains the substring
  --json                   Machine-readable plan/results on stdout

Example (agent-safe sequence):
  md eval flows/review.md --plan
  md eval flows/review.md --yes --json`);
    return 0;
  }
  const fail = (reasonCode: string, message: string): number => {
    if (json) console.log(JSON.stringify({ type: "eval.error", reasonCode, message }));
    else console.error(message);
    return 1;
  };
  const filterIdx = args.indexOf("--filter");
  const filter = filterIdx !== -1 ? args[filterIdx + 1] : undefined;
  const positional = args.filter(
    (a, i) => !a.startsWith("-") && !(filterIdx !== -1 && i === filterIdx + 1)
  );
  const flowPath = positional[0];

  if (!flowPath) {
    return fail("FLOW_REQUIRED", "Usage: md eval <flow.md> [--plan] [--yes] [--filter <substring>] [--json]");
  }
  if (!existsSync(flowPath)) {
    return fail("FLOW_NOT_FOUND", `flow not found: ${flowPath}`);
  }

  const suitePath = resolveEvalSuitePath(flowPath);
  if (!existsSync(suitePath)) {
    return fail("SUITE_NOT_FOUND", `no eval suite for ${flowPath}; expected: ${suitePath} (export default an EvalCase[])`);
  }

  const parsed = parseFrontmatter(readFileSync(flowPath, "utf8"));
  const config = await loadFullConfig(dirname(resolve(flowPath)));
  const policy = resolveEvolutionPolicy(parsed.frontmatter.evolve ?? config.evolve);
  let staticPlan: EvalSuitePlan;
  try {
    staticPlan = inspectEvalSuitePlan(suitePath, policy.repetitions);
  } catch (error) {
    return fail("UNSAFE_DYNAMIC_SUITE", error instanceof Error ? error.message : String(error));
  }
  const selectedPlan = filter
    ? staticPlan.cases.filter((item) => item.name.toLowerCase().includes(filter.toLowerCase()))
    : staticPlan.cases;
  const selectedCount = selectedPlan.length;
  if (selectedCount === 0) {
    return fail("FILTER_EMPTY", `no cases match --filter "${filter}" (suite has: ${staticPlan.cases.map((c) => c.name).join(", ")})`);
  }
  const plannedInvocations = selectedPlan.reduce((total, item) => total + item.repetitions, 0);
  if (!json) {
    console.log(
      `${basename(flowPath)}: ${selectedCount} case${selectedCount === 1 ? "" : "s"}, ${plannedInvocations} paid invocation${plannedInvocations === 1 ? "" : "s"} including repetitions`
    );
  }
  if (planOnly) {
    if (json) console.log(JSON.stringify({ type: "eval.plan", flowPath: resolve(flowPath), suitePath: resolve(suitePath), selectedCount, plannedInvocations }));
    return 0;
  }
  if (!yes) {
    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (json || !interactive) {
      if (json) console.log(JSON.stringify({ type: "eval.refused", reasonCode: "CONSENT_REQUIRED", plannedInvocations }));
      else console.error("refusing paid eval work without --yes in a non-interactive session.");
      return 1;
    }
    const { confirm } = await import("@inquirer/prompts");
    if (!(await confirm({ message: "Run this executable eval suite?", default: false }))) {
      if (json) console.log(JSON.stringify({ type: "eval.cancelled", plannedInvocations }));
      else console.log("cancelled. No flow invocations spent.");
      return 0;
    }
  }

  // Import only after consent: eval modules are executable TypeScript.
  let mod: Record<string, unknown>;
  try {
    mod = await import(`${resolve(suitePath)}?eval=${Date.now()}-${Math.random().toString(36).slice(2)}`);
  } catch (error) {
    return fail("SUITE_IMPORT_FAILED", error instanceof Error ? error.message : String(error));
  }
  const rawCases = mod.default as EvalCase[];
  if (!Array.isArray(rawCases) || rawCases.length === 0) {
    return fail("SUITE_EMPTY", `${suitePath} has no cases (export default an EvalCase[])`);
  }
  const cases = applyPolicyRepetitions(rawCases, policy.repetitions);
  const runtimeSelected = filter
    ? cases.filter((item) => item.name.toLowerCase().includes(filter.toLowerCase()))
    : cases;
  const runtimePlan = runtimeSelected.map((item) => ({
    name: item.name,
    evidence: item.evidence ?? [],
    repetitions: item.repetitions ?? 1,
    quorum: item.quorum ?? item.repetitions ?? 1,
  }));
  if (JSON.stringify(runtimePlan) !== JSON.stringify(selectedPlan)) {
    return fail("SUITE_PLAN_CHANGED", "eval suite runtime metadata differs from the announced static plan; refusing flow invocations");
  }

  const runFlow = makeCliFlowRunner(cliPath ?? join(import.meta.dir, "index.ts"));
  const outcome = await runEvalSuite({ flowPath, cases, runFlow, filter, log: json ? () => {} : undefined });

  if (json) {
    console.log(JSON.stringify({ type: "eval.result", plannedInvocations, outcome }));
    return outcome.fail === 0 && outcome.inconclusive === 0 && outcome.flaky === 0 ? 0 : 1;
  }

  console.log(
    `${outcome.pass}/${outcome.total} passed${outcome.fail ? ` — ${outcome.fail} failed` : ""}`
  );
  if (outcome.fail === 0 && outcome.inconclusive === 0 && outcome.flaky === 0 && !filter && outcome.total > 0) {
    console.log(`clean run recorded in trust ledger: ${evalLedgerPath()}`);
  }
  return outcome.fail === 0 && outcome.inconclusive === 0 && outcome.flaky === 0 ? 0 : 1;
}
