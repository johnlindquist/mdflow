/**
 * `md eval` — management surface for a flow's behavioral eval suite.
 *
 *   md eval <flow.md> [--plan] [--yes]      run the suite (paid; src/evals.ts)
 *   md eval add <flow.md> [recipe…]         scaffold or extend <flow>.eval.ts
 *   md eval list [<flow.md>|<dir>] [--json] verdicts from the trust ledger
 *   md eval remove <flow.md> [id…] [--yes]  remove managed cases (or the file)
 *   md eval coverage [<dir>] [--json]       source-coverage ratchet (CI-safe)
 *
 * Effects are stated consistently: add/remove are LOCAL WRITES that never
 * call an engine; list/coverage are FREE and read-only and never import
 * suite code; only the bare run spends engine invocations (and keeps its
 * existing consent boundary). Mirrors `md hooks` (src/hooks-cli.ts).
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { statSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import {
  EVAL_RECIPES,
  EVAL_RECIPE_DESCRIPTIONS,
  defaultCoverageBaselinePath,
  inferEvalRecipes,
  insertEvalRecipes,
  inspectEvalCoverage,
  inspectEvalStatus,
  inspectEvalSuiteStatic,
  isEvalRecipe,
  listEvalFlows,
  parseManagedEvalCases,
  readEvalCoverageBaseline,
  removeManagedEvalCases,
  renderEvalTemplate,
  type EvalCoverageBaseline,
  type EvalRecipe,
  type EvalStatus,
} from "./eval-convention";
import { EVAL_PROTOCOL_VERSION, readEvalLedger, resolveEvalSuitePath } from "./evals";
import { atomicWriteFile, withAtomicFileLock } from "./evolution-store";

const MANAGEMENT_ACTIONS = new Set(["add", "list", "remove", "coverage"]);
// ONE protocol version for every machine-readable eval.* object — paid and
// management surfaces must never drift apart on separate literals.
const EVAL_LIST_PROTOCOL_VERSION = EVAL_PROTOCOL_VERSION;

export interface EvalsCliRuntime {
  cwd?: string;
  isTTY?: boolean;
  log?: (message: string) => void;
  error?: (message: string) => void;
  /** Injected for tests; defaults to the real inquirer confirm. */
  promptConfirm?: (message: string) => Promise<boolean>;
}

function validRecipesLines(): string {
  return EVAL_RECIPES.map((recipe) => `  ${recipe.padEnd(11)}${EVAL_RECIPE_DESCRIPTIONS[recipe]}`).join("\n");
}

export function evalUsage(): string {
  return `Usage: md eval <flow.md> [--plan] [--yes] [--filter <substring>] [--json]
       md eval <add|list|remove|coverage> …

Run or manage the flow's behavioral eval suite (<flow>.eval.ts — a sibling
TypeScript module discovered by name, export default an EvalCase[]).

Run (PAID — one engine invocation per trial; --plan is free):
  md eval flows/review.md --plan      static plan: cases + paid-call count
  md eval flows/review.md --yes       run every case; records a trust receipt

Manage (LOCAL WRITE — never calls an engine):
  md eval add flows/review.md                 scaffold (recipes inferred)
  md eval add flows/review.md stdin fixture   scaffold/extend with recipes
  md eval remove flows/review.md stdin        remove one managed case
  md eval remove flows/review.md --yes        delete the whole suite file

Inspect (FREE — read-only; never imports suite code):
  md eval list flows/review.md [--json]       verdict for one flow
  md eval list flows [--json]                 verdict table for a directory
  md eval coverage flows [--json]             source-coverage ratchet for CI
    --baseline <path>   shrink-only exemption ledger
                        (default: <dir>/.mdflow-eval-baseline.json)

Verdicts are fail-closed: Verified | Stale | Flaky | Failing | Unverified.
A scaffolded suite is a DRAFT — it cannot spend engine invocations until each
case's ${"MDFLOW_DRAFT_CASE"} assertion is replaced with a real invariant AND
its \`draft: true\` line is deleted.

Recipes:
${validRecipesLines()}`;
}

/** Route `md eval …` between the paid runner and the management surface. */
export async function runEvalCommand(
  args: string[],
  runtime: EvalsCliRuntime = {}
): Promise<number> {
  const firstPositional = args.find((arg) => !arg.startsWith("-"));
  if (firstPositional && MANAGEMENT_ACTIONS.has(firstPositional)) {
    return runEvalManagementCli(args, runtime);
  }
  if (!firstPositional && (args.includes("--help") || args.includes("-h"))) {
    (runtime.log ?? console.log)(evalUsage());
    return 0;
  }
  const { runEvalCli } = await import("./evals");
  return runEvalCli(args, { cwd: runtime.cwd });
}

async function defaultPromptConfirm(message: string): Promise<boolean> {
  const { confirm } = await import("@inquirer/prompts");
  return confirm({ message, default: false });
}

function shortHash(value: string | undefined): string {
  return value ? `${value.slice(0, 12)}…` : "—";
}

function relativeTo(cwd: string, path: string): string {
  const rel = relative(cwd, path);
  return rel && !rel.startsWith("..") ? rel : path;
}

function nextCommand(status: EvalStatus, flowArg: string): string {
  if (!status.exists) return `md eval add ${flowArg}`;
  if (status.draft) return `edit ${basename(status.suitePath)} (replace draft assertions, delete draft: true), then md eval ${flowArg} --plan`;
  if (status.verdict === "Verified") return `md eval ${flowArg} --plan (receipt is current)`;
  return `md eval ${flowArg} --plan`;
}

export async function runEvalManagementCli(
  args: string[],
  runtime: EvalsCliRuntime = {}
): Promise<number> {
  const log = runtime.log ?? ((m: string) => console.log(m));
  const error = runtime.error ?? ((m: string) => console.error(m));
  const isTTY = runtime.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const cwd = runtime.cwd ?? process.cwd();

  // Strict grammar, first error wins — but scanning continues so a later
  // --json still shapes how that error is reported (mirrors the paid parser).
  const positionals: string[] = [];
  let yes = false;
  let yesSeen = false;
  let json = false;
  let baselinePath: string | undefined;
  let baselineSeen = false;
  let parseError: { code: string; message: string } | undefined;
  const recordError = (code: string, message: string) => {
    parseError ??= { code, message };
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--yes" || arg === "-y") {
      yes = true;
      yesSeen = true;
    } else if (arg === "--json") json = true;
    else if (arg === "--baseline" || arg.startsWith("--baseline=")) {
      baselineSeen = true;
      let value: string | undefined;
      if (arg.startsWith("--baseline=")) {
        value = arg.slice("--baseline=".length);
      } else {
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          value = next;
          i++;
        }
      }
      if (!value) {
        recordError("BASELINE_VALUE_REQUIRED", "--baseline requires a value: --baseline <path> or --baseline=<path>");
      } else {
        baselinePath = value;
      }
    } else if (arg === "--help" || arg === "-h") {
      log(evalUsage());
      return 0;
    } else if (arg.startsWith("-")) {
      recordError("UNKNOWN_OPTION", `Unknown option for md eval management: ${arg}\n\n${evalUsage()}`);
    } else positionals.push(arg);
  }

  const [action, target, ...rest] = positionals;

  const fail = (reasonCode: string, message: string): number => {
    if (json) log(JSON.stringify({ type: "eval.error", protocolVersion: EVAL_LIST_PROTOCOL_VERSION, reasonCode, message }));
    else error(message);
    return 1;
  };

  if (!action || !MANAGEMENT_ACTIONS.has(action)) {
    return fail("USAGE", evalUsage());
  }
  if (parseError) return fail(parseError.code, parseError.message);
  // Per-action applicability: a flag that does not apply to the selected
  // action is a hard error, never silently ignored.
  if (baselineSeen && action !== "coverage") {
    return fail("UNKNOWN_OPTION", `--baseline only applies to md eval coverage\n\n${evalUsage()}`);
  }
  if (yesSeen && action !== "remove") {
    return fail("UNKNOWN_OPTION", `--yes only applies to md eval remove\n\n${evalUsage()}`);
  }
  if ((action === "coverage" || action === "list") && rest.length > 0) {
    return fail(
      "UNEXPECTED_ARGUMENT",
      `unexpected argument(s): ${rest.join(" ")} — md eval ${action} takes at most one target\n\n${evalUsage()}`
    );
  }

  // Bare `md eval list` / `md eval coverage` default to the project flow
  // roster when one exists — the cwd fallback would otherwise scan docs and
  // unrelated trees.
  const defaultScanDir = (): string =>
    existsSync(resolve(cwd, "flows")) ? resolve(cwd, "flows") : resolve(cwd, ".");

  if (action === "coverage") {
    const rootDir = target ? resolve(cwd, target) : defaultScanDir();
    if (!existsSync(rootDir)) return fail("DIR_NOT_FOUND", `directory not found: ${rootDir}`);
    let baseline: EvalCoverageBaseline = { schemaVersion: 1, uncovered: {} };
    const resolvedBaseline = baselinePath
      ? resolve(cwd, baselinePath)
      : defaultCoverageBaselinePath(rootDir);
    if (existsSync(resolvedBaseline)) {
      try {
        baseline = readEvalCoverageBaseline(resolvedBaseline);
      } catch (err) {
        return fail("BASELINE_INVALID", err instanceof Error ? err.message : String(err));
      }
    } else if (baselinePath) {
      return fail("BASELINE_NOT_FOUND", `baseline not found: ${resolvedBaseline}`);
    }
    const report = await inspectEvalCoverage(rootDir, baseline);
    if (json) {
      log(JSON.stringify({ type: "eval.coverage", protocolVersion: EVAL_LIST_PROTOCOL_VERSION, ...report }));
      return report.ok ? 0 : 1;
    }
    log(
      `Scanned ${report.scanned} flow${report.scanned === 1 ? "" : "s"} under ${relativeTo(cwd, report.root)}: ` +
        `${report.covered.length} covered, ${report.uncovered.length} uncovered` +
        `${report.baselined.length > 0 ? ` (${report.baselined.length} baselined)` : ""}.`
    );
    for (const failure of report.failures) log(`  ✗ ${failure}`);
    if (report.ok) log("Coverage ratchet holds.");
    return report.ok ? 0 : 1;
  }

  if (action === "list") {
    const targetPath = target ? resolve(cwd, target) : defaultScanDir();
    if (!existsSync(targetPath)) return fail("TARGET_NOT_FOUND", `not found: ${targetPath}`);
    let ledger: ReturnType<typeof readEvalLedger>;
    try {
      ledger = readEvalLedger();
    } catch (err) {
      // Fail-closed: a corrupt trust ledger is surfaced, never treated as
      // "no receipts" (which would silently demote every verdict).
      return fail("LEDGER_UNREADABLE", err instanceof Error ? err.message : String(err));
    }

    if (statSync(targetPath).isDirectory()) {
      const flows = listEvalFlows(targetPath);
      const statuses: EvalStatus[] = [];
      for (const flow of flows) statuses.push(await inspectEvalStatus(flow, { ledger }));
      if (json) {
        log(
          JSON.stringify({
            type: "eval.list",
            protocolVersion: EVAL_LIST_PROTOCOL_VERSION,
            root: targetPath,
            scanned: statuses.length,
            returned: statuses.length,
            truncated: false,
            flows: statuses,
          })
        );
        return 0;
      }
      if (statuses.length === 0) {
        log(`No flows found under ${relativeTo(cwd, targetPath)}.`);
        return 0;
      }
      log(`${"VERDICT".padEnd(11)}${"CASES".padEnd(7)}${"CALLS".padEnd(7)}${"LAST FULL RUN".padEnd(22)}FLOW`);
      for (const status of statuses) {
        const lastFull = status.lastFullRunAt ?? status.lastRunAt;
        const lastRun = lastFull ? lastFull.replace("T", " ").slice(0, 16) : "never";
        log(
          `${status.verdict.padEnd(11)}${String(status.cases ?? "—").padEnd(7)}` +
            `${String(status.plannedInvocations ?? "—").padEnd(7)}${lastRun.padEnd(22)}` +
            relativeTo(cwd, status.flowPath)
        );
      }
      log(`Scanned ${statuses.length}/${statuses.length} flows. No result cap.`);
      return 0;
    }

    if (!/\.md$/i.test(targetPath)) {
      return fail("NOT_A_FLOW", `not a markdown flow file or directory: ${targetPath}`);
    }
    const status = await inspectEvalStatus(targetPath, { ledger });
    if (json) {
      log(JSON.stringify({ type: "eval.status", protocolVersion: EVAL_LIST_PROTOCOL_VERSION, ...status }));
      return 0;
    }
    log(`Flow: ${relativeTo(cwd, status.flowPath)}`);
    log(`Suite: ${relativeTo(cwd, status.suitePath)}${status.exists ? "" : " (missing)"}`);
    log(`Verdict: ${status.verdict}`);
    log(`Reason: ${status.reason}`);
    if (status.cases !== undefined) {
      log(`Cases: ${status.cases}${status.draft ? ` (draft: ${status.draftCaseIds.join(", ")})` : ""}`);
      log(`Paid calls: ${status.plannedInvocations}`);
    }
    if (status.lastRunAt) log(`Last run: ${status.lastRunAt}`);
    if (status.lastCleanAt) log(`Last clean: ${status.lastCleanAt}`);
    if (status.receiptFingerprint || status.currentFingerprint) {
      log(`Receipt: ${shortHash(status.receiptFingerprint)}`);
      log(`Current: ${shortHash(status.currentFingerprint)}`);
    }
    log(`Next: ${nextCommand(status, target ?? relativeTo(cwd, status.flowPath))}`);
    return 0;
  }

  // add / remove need an existing markdown flow target.
  if (!target) {
    error(`md eval ${action}: missing <flow.md> argument.\n\n${evalUsage()}`);
    return 1;
  }
  const flowPath = resolve(cwd, target);
  if (!existsSync(flowPath)) {
    error(`Flow file not found: ${flowPath}`);
    return 1;
  }
  if (!/\.md$/i.test(flowPath)) {
    error(`Not a markdown flow file: ${flowPath}`);
    return 1;
  }
  const suitePath = resolveEvalSuitePath(flowPath);

  if (action === "add") {
    const requested: EvalRecipe[] = [];
    for (const recipeArg of rest) {
      if (!isEvalRecipe(recipeArg)) {
        error(`Unknown eval recipe "${recipeArg}". Valid recipes:\n${validRecipesLines()}`);
        return 1;
      }
      requested.push(recipeArg);
    }
    const recipes = requested.length > 0
      ? [...new Set(requested)]
      : inferEvalRecipes(readFileSync(flowPath, "utf8"));

    if (!existsSync(suitePath)) {
      try {
        // "wx" (O_EXCL) never follows symlinks: a dangling symlink planted at
        // the suite path cannot redirect this write somewhere else.
        writeFileSync(suitePath, renderEvalTemplate(recipes), { flag: "wx" });
      } catch (err) {
        error(
          `Cannot create ${suitePath}: ${err instanceof Error ? err.message : String(err)} ` +
            `(something already occupies that path — remove it first)`
        );
        return 1;
      }
      log(`Created ${suitePath}`);
      log(`Cases: ${recipes.join(", ")}${requested.length === 0 ? " (inferred from the flow body)" : ""}`);
      log(`The suite is a fail-closed DRAFT — it cannot spend engine invocations until each`);
      log(`case's MDFLOW_DRAFT_CASE assertion is a real invariant and its draft: true line is deleted.`);
      log(`Next: edit ${basename(suitePath)}, then md eval ${target} --plan`);
      return 0;
    }

    // Read-modify-write under the suite's lock: concurrent edits must never
    // silently discard each other's cases.
    let result: { updated: string; added: EvalRecipe[] };
    try {
      result = withAtomicFileLock(suitePath, () => {
        const source = readFileSync(suitePath, "utf8");
        const transformed = insertEvalRecipes(source, recipes);
        if (transformed.added.length > 0) atomicWriteFile(suitePath, transformed.updated, 0o644);
        return transformed;
      });
    } catch (err) {
      error(
        `Cannot extend ${suitePath}: ${err instanceof Error ? err.message : String(err)}\n` +
          `Fix the file (or delete it with md eval remove ${target} --yes and re-run md eval add).`
      );
      return 1;
    }
    if (result.added.length === 0) {
      log(`${basename(suitePath)} already has managed case(s): ${recipes.join(", ")}. Nothing to do.`);
      return 0;
    }
    const remaining = parseManagedEvalCases(result.updated).blocks.map((block) => block.id);
    log(`Extended ${basename(suitePath)} with: ${result.added.join(", ")}`);
    log(`Managed cases: ${remaining.join(", ")}`);
    log(`Next: edit ${basename(suitePath)}, then md eval ${target} --plan`);
    return 0;
  }

  // action === "remove"
  if (!existsSync(suitePath)) {
    log(`No eval suite for ${basename(flowPath)} (${suitePath}); nothing to remove.`);
    return 0;
  }

  if (rest.length === 0) {
    if (!yes) {
      if (!isTTY) {
        error(`md eval remove: deleting the whole suite needs --yes when not on a TTY.`);
        return 1;
      }
      const confirmed = await (runtime.promptConfirm ?? defaultPromptConfirm)(
        `Delete ${suitePath}?`
      );
      if (!confirmed) {
        log("Cancelled.");
        return 1;
      }
    }
    // Ledger history stays: a deleted suite classifies Unverified mechanically.
    unlinkSync(suitePath);
    log(`Deleted ${suitePath}`);
    return 0;
  }

  try {
    withAtomicFileLock(suitePath, () => {
      const source = readFileSync(suitePath, "utf8");
      atomicWriteFile(suitePath, removeManagedEvalCases(source, rest), 0o644);
    });
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  const inspection = inspectEvalSuiteStatic(flowPath);
  log(`Removed ${rest.join(", ")} from ${basename(suitePath)}`);
  if (inspection.managedCaseIds.length > 0) {
    log(`Managed cases remaining: ${inspection.managedCaseIds.join(", ")}`);
  } else {
    log(`No managed cases remain — delete the file with: md eval remove ${target} --yes`);
  }
  return 0;
}
