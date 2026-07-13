/**
 * The shipped example eval suites are teaching artifacts AND a cost
 * contract: every suite must be statically plannable (passive surfaces
 * never import suite code), contain no draft cases, stay within 2-4 cases,
 * and the aggregate paid-invocation count is locked so cost creep is
 * visible in review.
 */
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { inspectEvalSuitePlan, resolveEvalSuitePath } from "./evals";
import { EVAL_DRAFT_MARKER } from "./eval-convention";

const ROOT = join(import.meta.dir, "..");

const SHIPPED_FLOWS = [
  "examples/commit.claude.md",
  "assets/init/catalog/review.md",
  "assets/init/catalog/changelog.md",
  "assets/init/catalog/onboard.md",
  "assets/init/catalog/pr-description.md",
  "assets/init/catalog/fix-tests.md",
  "examples/multi-agent/audit.claude.md",
  "examples/multi-agent/patch.claude.md",
  "examples/logo-grid.claude.md",
];

describe("shipped eval suites", () => {
  it("every shipped flow has a statically plannable, non-draft suite of 2-4 cases", () => {
    for (const flow of SHIPPED_FLOWS) {
      const suite = resolveEvalSuitePath(join(ROOT, flow));
      const plan = inspectEvalSuitePlan(suite);
      expect(plan.cases.length).toBeGreaterThanOrEqual(2);
      expect(plan.cases.length).toBeLessThanOrEqual(4);
      expect(readFileSync(suite, "utf8")).not.toContain(EVAL_DRAFT_MARKER);
      for (const evalCase of plan.cases) {
        expect(evalCase.name.length).toBeGreaterThan(0);
        expect(evalCase.quorum).toBeLessThanOrEqual(evalCase.repetitions);
      }
    }
  });

  it("locks the aggregate cost: 9 suites, 20 cases, 22 paid invocations", () => {
    const plans = SHIPPED_FLOWS.map((flow) =>
      inspectEvalSuitePlan(resolveEvalSuitePath(join(ROOT, flow)))
    );
    const cases = plans.reduce((total, plan) => total + plan.cases.length, 0);
    const invocations = plans.reduce((total, plan) => total + plan.invocations, 0);
    expect(plans.length).toBe(9);
    expect(cases).toBe(20);
    expect(invocations).toBe(22);
  });

  it("no shipped case is a draft (static metadata agrees with the sentinel scan)", () => {
    for (const flow of SHIPPED_FLOWS) {
      const suite = resolveEvalSuitePath(join(ROOT, flow));
      const plan = inspectEvalSuitePlan(suite);
      expect(plan.cases.every((evalCase) => !evalCase.draft)).toBe(true);
    }
  });
});
