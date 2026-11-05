import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import type { RunContext, RunResult } from "./command";
import { executeWorkflow, parseWorkflow } from "./workflow";

function toRunResult(stdout: string, stderr = "", exitCode = 0): RunResult {
  return {
    stdout,
    stderr,
    exitCode,
    output: stdout,
    process: null as unknown as ReturnType<typeof Bun.spawn>,
  };
}

const tempDirs: string[] = [];
async function cacheDirFixture() { const dir = await mkdtemp(join(tmpdir(), "workflow-test-")); tempDirs.push(dir); return dir; }

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

describe("parseWorkflow", () => {
  test("test_parseWorkflow_builds_dag_batches_when_dependencies_are_valid", () => {
    const parsed = parseWorkflow([
      { id: "draft", run: "draft" },
      { id: "research", run: "research" },
      { id: "finalize", run: "final", needs: ["draft", "research"] },
    ]);

    expect(parsed.batches).toHaveLength(2);
    expect(parsed.batches[0]?.map((step) => step.id)).toEqual(["draft", "research"]);
    expect(parsed.batches[1]?.map((step) => step.id)).toEqual(["finalize"]);
  });

  test("test_parseWorkflow_throws_when_dependency_references_unknown_step", () => {
    expect(() =>
      parseWorkflow([
        { id: "only", run: "echo" },
        { id: "bad", run: "echo", needs: ["missing"] },
      ])
    ).toThrow("depends on unknown step");
  });

  test("test_parseWorkflow_throws_when_workflow_contains_cycle", () => {
    expect(() =>
      parseWorkflow([
        { id: "a", run: "echo", needs: ["b"] },
        { id: "b", run: "echo", needs: ["a"] },
      ])
    ).toThrow("dependency cycle");
  });
});

describe("executeWorkflow", () => {
  test("test_executeWorkflow_runs_steps_in_topological_order_and_parallel_batches", async () => {
    const parsed = parseWorkflow([
      { id: "a", run: "A" },
      { id: "b", run: "B" },
      { id: "c", run: "C", needs: ["a", "b"] },
    ]);

    const events: string[] = [];

    const runCommandFn = async (ctx: RunContext): Promise<RunResult> => {
      const prompt = ctx.positionals[0] ?? "";
      events.push(`start:${prompt}`);

      if (prompt === "A" || prompt === "B") {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      events.push(`end:${prompt}`);
      return toRunResult(`stdout:${prompt}`);
    };

    const result = await executeWorkflow({
      workflow: parsed,
      defaultTool: "echo",
      args: ["--model", "test"],
      cacheDir: await cacheDirFixture(),
      runCommandFn,
      captureOutput: "capture",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stepOrder).toEqual(["a", "b", "c"]);

    const startA = events.indexOf("start:A");
    const startB = events.indexOf("start:B");
    const endA = events.indexOf("end:A");
    const endB = events.indexOf("end:B");
    const startC = events.indexOf("start:C");

    expect(startA).toBeGreaterThanOrEqual(0);
    expect(startB).toBeGreaterThanOrEqual(0);
    expect(endA).toBeGreaterThanOrEqual(0);
    expect(endB).toBeGreaterThanOrEqual(0);
    expect(startC).toBeGreaterThan(endA);
    expect(startC).toBeGreaterThan(endB);

    const firstEnd = Math.min(endA, endB);
    expect(startA).toBeLessThan(firstEnd);
    expect(startB).toBeLessThan(firstEnd);
  });

  test("test_executeWorkflow_passes_step_stdout_into_following_steps_via_template_vars", async () => {
    const parsed = parseWorkflow([
      { id: "fetch", run: "initial" },
      { id: "transform", run: "saw {{ steps.fetch.stdout }}", needs: ["fetch"] },
    ]);

    const prompts: string[] = [];

    const runCommandFn = async (ctx: RunContext): Promise<RunResult> => {
      const prompt = ctx.positionals[0] ?? "";
      prompts.push(prompt);
      return toRunResult(`out:${prompt}`);
    };

    const result = await executeWorkflow({
      workflow: parsed,
      defaultTool: "echo",
      args: [],
      cacheDir: await cacheDirFixture(),
      runCommandFn,
      captureOutput: "capture",
    });

    expect(result.exitCode).toBe(0);
    expect(prompts).toEqual(["initial", "saw out:initial"]);
    expect(result.steps.transform?.prompt).toBe("saw out:initial");
    expect(result.templateVars["steps.fetch.stdout"]).toBe("out:initial");
    expect(result.templateVars["steps.transform.stdout"]).toBe("out:saw out:initial");
  });

  test("test_executeWorkflow_uses_cache_on_resume_for_matching_step_inputs", async () => {
    const parsed = parseWorkflow([{ id: "cached", run: "cache me" }]);
    const cacheDir = await mkdtemp(join(tmpdir(), "mdflow-workflow-cache-"));
    tempDirs.push(cacheDir);

    let runCount = 0;

    const runCommandFn = async (_ctx: RunContext): Promise<RunResult> => {
      runCount++;
      return toRunResult("cached-stdout");
    };

    const first = await executeWorkflow({
      workflow: parsed,
      defaultTool: "echo",
      args: ["--model", "test"],
      resume: true,
      cacheDir,
      runCommandFn,
      captureOutput: "capture",
    });

    expect(first.exitCode).toBe(0);
    expect(first.steps.cached?.fromCache).toBe(false);
    expect(runCount).toBe(1);

    const second = await executeWorkflow({
      workflow: parsed,
      defaultTool: "echo",
      args: ["--model", "test"],
      resume: true,
      cacheDir,
      runCommandFn,
      captureOutput: "capture",
    });

    expect(second.exitCode).toBe(0);
    expect(second.steps.cached?.fromCache).toBe(true);
    expect(second.steps.cached?.stdout).toBe("cached-stdout");
    expect(runCount).toBe(1);
  });
});
