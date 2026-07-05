/**
 * Behavioral evals for flows — `md eval <flow.md>`.
 *
 * Creed: "If a guardrail isn't covered by an eval, it's a wish." A flow's
 * prompt promises behavior; an eval suite is the only proof. Each case runs
 * the flow for real (one engine turn per case — cost is printed before
 * anything runs) inside a hermetic temp dir, then a check function asserts on
 * stdout AND the resulting filesystem. Write checks on invariants (files,
 * numbers, names), not exact wording.
 *
 * Suites are colocated with their flow: flows/jq.md → flows/jq.eval.ts,
 * exporting `default` an EvalCase[]. Results land in the trust ledger
 * (~/.mdflow/eval-results.json, override MDFLOW_EVAL_RESULTS) — a full clean
 * run stamps `lastCleanAt`, which is what future tooling (evolve, tournament)
 * gates on.
 *
 * Eval runs are synthetic, not real usage: the runner points MDFLOW_RUNS_FILE
 * into the sandbox so they never pollute the run-telemetry corpus that
 * learning features feed on.
 */

import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir, homedir } from "os";
import { join, dirname, resolve, basename } from "path";

export interface EvalContext {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** The hermetic sandbox dir the flow ran in. */
  dir: string;
}

export interface EvalCase {
  name: string;
  /** Extra prompt appended to the flow's body (like asking it a question). */
  prompt?: string;
  /** Piped stdin content. */
  stdin?: string;
  /**
   * Where the flow runs. Default: a fresh hermetic temp dir per case.
   * Repo-bound flows (project rosters that inspect the live repository) set
   * this to a path relative to the flow file (e.g. ".." for the repo root);
   * no cleanup happens for an explicit cwd.
   */
  cwd?: string;
  /** Prepare fixtures inside the sandbox before the flow runs. */
  setup?: (dir: string) => void | Promise<void>;
  /** Return null on pass, or a human-readable failure reason. */
  check: (ctx: EvalContext) => string | null | Promise<string | null>;
  timeoutMs?: number;
}

export interface FlowRunSpec {
  flowPath: string;
  prompt?: string;
  stdin?: string;
  cwd: string;
  timeoutMs: number;
}

export type FlowRunner = (spec: FlowRunSpec) => Promise<Omit<EvalContext, "dir">>;

export interface EvalSuiteOutcome {
  pass: number;
  fail: number;
  total: number;
  failures: string[];
}

export interface EvalLedgerEntry {
  flow: string;
  pass: number;
  fail: number;
  total: number;
  lastRunAt: string;
  /** True when the run covered every case in the suite (no --filter). */
  full: boolean;
  /** Last time a FULL run of this suite passed every case. */
  lastCleanAt?: string;
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

export function recordEvalResult(
  suite: string,
  result: Omit<EvalLedgerEntry, "lastCleanAt">,
  path = evalLedgerPath()
): void {
  const all = readEvalLedger(path);
  const prev = all[suite];
  const clean = result.full && result.fail === 0 && result.total > 0;
  const lastCleanAt = clean ? result.lastRunAt : prev?.lastCleanAt;
  all[suite] = { ...result, ...(lastCleanAt ? { lastCleanAt } : {}) };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(all, null, 2)}\n`);
}

/**
 * Default runner: spawn the md CLI on the flow inside the sandbox.
 * MDFLOW_RUNS_FILE is redirected into the sandbox so synthetic eval runs
 * never enter the real telemetry corpus.
 */
export function makeCliFlowRunner(cliPath: string): FlowRunner {
  return async ({ flowPath, prompt, stdin, cwd, timeoutMs }) => {
    const args = [cliPath, resolve(flowPath)];
    if (prompt) args.push(prompt);

    const proc = Bun.spawn(["bun", "run", ...args], {
      cwd,
      stdin: stdin !== undefined ? new TextEncoder().encode(stdin) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        MDFLOW_RUNS_FILE: join(cwd, ".mdflow-eval-runs.jsonl"),
        MDFLOW_EVAL_RUN: "1",
      },
    });

    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {}
    }, timeoutMs);

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);

    return { stdout, stderr, exitCode };
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
}

export async function runEvalSuite(options: RunEvalSuiteOptions): Promise<EvalSuiteOutcome> {
  const { flowPath, runFlow, filter } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  const selected = filter
    ? options.cases.filter((c) => c.name.toLowerCase().includes(filter.toLowerCase()))
    : options.cases;

  const outcome: EvalSuiteOutcome = { pass: 0, fail: 0, total: selected.length, failures: [] };

  for (const evalCase of selected) {
    const usingSandbox = !evalCase.cwd;
    const dir = usingSandbox
      ? mkdtempSync(join(tmpdir(), "mdflow-eval-"))
      : resolve(dirname(resolve(flowPath)), evalCase.cwd!);
    try {
      await evalCase.setup?.(dir);
      const run = await runFlow({
        flowPath,
        prompt: evalCase.prompt,
        stdin: evalCase.stdin,
        cwd: dir,
        timeoutMs: evalCase.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      const verdict = await evalCase.check({ ...run, dir });
      if (verdict === null) {
        outcome.pass++;
        log(`  ✓ ${evalCase.name}`);
      } else {
        outcome.fail++;
        outcome.failures.push(`${evalCase.name}: ${verdict}`);
        log(`  ✗ ${evalCase.name}: ${verdict}`);
      }
    } catch (err) {
      outcome.fail++;
      const message = err instanceof Error ? err.message : String(err);
      outcome.failures.push(`${evalCase.name}: ${message}`);
      log(`  ✗ ${evalCase.name}: ${message}`);
    } finally {
      // Only ever delete dirs this run created. An explicit cwd is the
      // user's real directory and must never be cleaned up.
      if (usingSandbox) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {}
      }
    }
  }

  if (!options.noLedger) {
    recordEvalResult(
      options.suiteKey ?? resolveEvalSuitePath(resolve(flowPath)),
      {
        flow: resolve(flowPath),
        pass: outcome.pass,
        fail: outcome.fail,
        total: outcome.total,
        lastRunAt: new Date().toISOString(),
        full: !filter,
      },
      options.ledgerPath
    );
  }

  return outcome;
}

/** `md eval <flow.md> [--filter <substr>]` */
export async function runEvalCli(args: string[], cliPath?: string): Promise<number> {
  const filterIdx = args.indexOf("--filter");
  const filter = filterIdx !== -1 ? args[filterIdx + 1] : undefined;
  const positional = args.filter(
    (a, i) => !a.startsWith("--") && !(filterIdx !== -1 && i === filterIdx + 1)
  );
  const flowPath = positional[0];

  if (!flowPath) {
    console.error("Usage: md eval <flow.md> [--filter <substring>]");
    return 1;
  }
  if (!existsSync(flowPath)) {
    console.error(`flow not found: ${flowPath}`);
    return 1;
  }

  const suitePath = resolveEvalSuitePath(flowPath);
  if (!existsSync(suitePath)) {
    console.error(`no eval suite for ${flowPath}`);
    console.error(`expected: ${suitePath} (export default an EvalCase[])`);
    return 1;
  }

  const mod = await import(resolve(suitePath));
  const cases: EvalCase[] = mod.default;
  if (!Array.isArray(cases) || cases.length === 0) {
    console.error(`${suitePath} has no cases (export default an EvalCase[])`);
    return 1;
  }

  const selectedCount = filter
    ? cases.filter((c) => c.name.toLowerCase().includes(filter.toLowerCase())).length
    : cases.length;
  if (selectedCount === 0) {
    console.error(`no cases match --filter "${filter}" (suite has: ${cases.map((c) => c.name).join(", ")})`);
    return 1;
  }
  console.log(
    `${basename(flowPath)}: ${selectedCount} case${selectedCount === 1 ? "" : "s"} × 1 flow run each = ${selectedCount} engine turn${selectedCount === 1 ? "" : "s"}`
  );

  const runFlow = makeCliFlowRunner(cliPath ?? join(import.meta.dir, "index.ts"));
  const outcome = await runEvalSuite({ flowPath, cases, runFlow, filter });

  console.log(
    `${outcome.pass}/${outcome.total} passed${outcome.fail ? ` — ${outcome.fail} failed` : ""}`
  );
  if (outcome.fail === 0 && !filter && outcome.total > 0) {
    console.log(`clean run recorded in trust ledger: ${evalLedgerPath()}`);
  }
  return outcome.fail === 0 ? 0 : 1;
}
