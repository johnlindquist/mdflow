import { runCommand } from "./command";
import type { CaptureMode, RunContext, RunResult } from "./command";
import { substituteTemplateVars } from "./template";
import { getCachedResult, setCachedResult } from "./workflow-cache";

export interface WorkflowStep {
  id: string;
  run: string;
  tool?: string;
  needs?: string[];
  vars?: Record<string, string | number | boolean | null>;
  outputs?: Record<string, string>;
  retry?: number;
  when?: string | boolean;
}

export interface WorkflowStepResult {
  id: string;
  prompt: string;
  tool: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  attempts: number;
  fromCache: boolean;
  skipped: boolean;
  outputs: Record<string, string>;
}

export interface WorkflowResult {
  exitCode: number;
  stepOrder: string[];
  steps: Record<string, WorkflowStepResult>;
  templateVars: Record<string, string>;
}

export interface ParsedWorkflow {
  steps: WorkflowStep[];
  batches: WorkflowStep[][];
}

export interface ExecuteWorkflowOptions {
  workflow: ParsedWorkflow;
  defaultTool: string;
  args: string[];
  positionalMappings?: Map<number, string>;
  templateVars?: Record<string, string>;
  env?: Record<string, string>;
  rawOutput?: boolean;
  captureOutput?: boolean | CaptureMode;
  resume?: boolean;
  cacheDir?: string;
  runCommandFn?: (ctx: RunContext) => Promise<RunResult>;
  /** Called just before a non-skipped step executes (or resolves from cache). */
  onStepStart?: (step: WorkflowStep) => void;
  /** Called with the result of every non-skipped step. */
  onStepComplete?: (result: WorkflowStepResult) => void;
}

interface RawWorkflowStep {
  id?: unknown;
  run?: unknown;
  tool?: unknown;
  needs?: unknown;
  vars?: unknown;
  outputs?: unknown;
  retry?: unknown;
  when?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStringArray(value: unknown, field: string, stepId: string): string[] {
  if (value === undefined) return [];
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) {
    throw new Error(`Invalid workflow step '${stepId}': '${field}' must be a string or string[]`);
  }

  const parsed: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new Error(`Invalid workflow step '${stepId}': '${field}' entries must be non-empty strings`);
    }
    parsed.push(entry.trim());
  }
  return parsed;
}

function parseVars(value: unknown, field: "vars" | "outputs", stepId: string): Record<string, string | number | boolean | null> | Record<string, string> {
  if (value === undefined) return {};
  if (!isObject(value)) {
    throw new Error(`Invalid workflow step '${stepId}': '${field}' must be an object`);
  }

  const output: Record<string, string | number | boolean | null> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (field === "outputs") {
      if (typeof raw !== "string") {
        throw new Error(`Invalid workflow step '${stepId}': 'outputs.${key}' must be a string template`);
      }
      output[key] = raw;
      continue;
    }

    if (
      typeof raw === "string" ||
      typeof raw === "number" ||
      typeof raw === "boolean" ||
      raw === null
    ) {
      output[key] = raw;
      continue;
    }

    throw new Error(
      `Invalid workflow step '${stepId}': 'vars.${key}' must be string, number, boolean, or null`
    );
  }

  return output as Record<string, string | number | boolean | null> | Record<string, string>;
}

function normalizeStep(raw: unknown, index: number): WorkflowStep {
  if (!isObject(raw)) {
    throw new Error(`Invalid workflow step at index ${index}: expected an object`);
  }

  const step = raw as RawWorkflowStep;
  if (typeof step.id !== "string" || step.id.trim() === "") {
    throw new Error(`Invalid workflow step at index ${index}: 'id' must be a non-empty string`);
  }
  if (typeof step.run !== "string" || step.run.trim() === "") {
    throw new Error(`Invalid workflow step '${step.id}': 'run' must be a non-empty string`);
  }

  const id = step.id.trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(id)) {
    throw new Error(`Invalid workflow step '${id}': only letters, numbers, '_', '-', and '.' are allowed`);
  }

  if (step.tool !== undefined && (typeof step.tool !== "string" || step.tool.trim() === "")) {
    throw new Error(`Invalid workflow step '${id}': 'tool' must be a non-empty string when provided`);
  }

  if (step.retry !== undefined && (!Number.isInteger(step.retry) || (step.retry as number) < 0)) {
    throw new Error(`Invalid workflow step '${id}': 'retry' must be an integer >= 0`);
  }

  if (step.when !== undefined && typeof step.when !== "string" && typeof step.when !== "boolean") {
    throw new Error(`Invalid workflow step '${id}': 'when' must be a boolean or template string`);
  }

  const needs = parseStringArray(step.needs, "needs", id);
  const vars = parseVars(step.vars, "vars", id) as Record<string, string | number | boolean | null>;
  const outputs = parseVars(step.outputs, "outputs", id) as Record<string, string>;

  return {
    id,
    run: step.run,
    tool: typeof step.tool === "string" ? step.tool.trim() : undefined,
    needs,
    vars,
    outputs,
    retry: typeof step.retry === "number" ? step.retry : undefined,
    when: step.when,
  };
}

function evaluateWhen(when: WorkflowStep["when"], context: Record<string, unknown>): boolean {
  if (when === undefined) return true;
  if (typeof when === "boolean") return when;

  const evaluated = substituteTemplateVars(String(when), context).trim().toLowerCase();
  if (evaluated === "" || evaluated === "0") return false;
  if (["false", "no", "off", "null", "undefined"].includes(evaluated)) return false;
  return true;
}

function buildBatches(steps: WorkflowStep[]): WorkflowStep[][] {
  const orderIndex = new Map<string, number>();
  const stepById = new Map<string, WorkflowStep>();

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step) continue;

    if (stepById.has(step.id)) {
      throw new Error(`Duplicate workflow step id '${step.id}'`);
    }

    stepById.set(step.id, step);
    orderIndex.set(step.id, i);
  }

  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const step of steps) {
    indegree.set(step.id, step.needs?.length ?? 0);

    for (const dep of step.needs ?? []) {
      if (!stepById.has(dep)) {
        throw new Error(`Workflow step '${step.id}' depends on unknown step '${dep}'`);
      }
      if (dep === step.id) {
        throw new Error(`Workflow step '${step.id}' cannot depend on itself`);
      }

      const list = dependents.get(dep) ?? [];
      list.push(step.id);
      dependents.set(dep, list);
    }
  }

  const ready = steps
    .filter((step) => (indegree.get(step.id) ?? 0) === 0)
    .map((step) => step.id);

  const batches: WorkflowStep[][] = [];
  let processed = 0;
  let frontier = ready;

  while (frontier.length > 0) {
    frontier.sort((a, b) => (orderIndex.get(a) ?? 0) - (orderIndex.get(b) ?? 0));

    const batchIds = [...frontier];
    const batch: WorkflowStep[] = [];
    const nextFrontier: string[] = [];
    frontier = [];

    for (const id of batchIds) {
      const step = stepById.get(id);
      if (!step) continue;
      batch.push(step);
      processed++;

      const nextSteps = dependents.get(id) ?? [];
      for (const dependentId of nextSteps) {
        const next = (indegree.get(dependentId) ?? 0) - 1;
        indegree.set(dependentId, next);
        if (next === 0) nextFrontier.push(dependentId);
      }
    }

    batches.push(batch);
    frontier = nextFrontier;
  }

  if (processed !== steps.length) {
    throw new Error("Workflow contains a dependency cycle and cannot be executed");
  }

  return batches;
}

export function parseWorkflow(rawSteps: unknown): ParsedWorkflow {
  if (!Array.isArray(rawSteps)) {
    throw new Error("Invalid workflow: '_steps' must be an array of step definitions");
  }

  const steps = rawSteps.map((step, index) => normalizeStep(step, index));
  const batches = buildBatches(steps);
  return { steps, batches };
}

function flattenTemplateVars(context: Record<string, unknown>): Record<string, string> {
  const output: Record<string, string> = {};

  function walk(value: unknown, prefix: string): void {
    if (value === undefined) return;

    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
      output[prefix] = String(value);
      return;
    }

    if (!isObject(value)) return;

    for (const [key, next] of Object.entries(value)) {
      const nextPrefix = prefix ? `${prefix}.${key}` : key;
      walk(next, nextPrefix);
    }
  }

  for (const [key, value] of Object.entries(context)) {
    walk(value, key);
  }

  return output;
}

function toWorkflowStepResult(
  step: WorkflowStep,
  prompt: string,
  tool: string,
  runResult: Pick<RunResult, "stdout" | "stderr" | "exitCode">,
  attempts: number,
  fromCache: boolean,
  skipped: boolean,
  outputs: Record<string, string>
): WorkflowStepResult {
  return {
    id: step.id,
    prompt,
    tool,
    stdout: runResult.stdout,
    stderr: runResult.stderr,
    exitCode: runResult.exitCode,
    attempts,
    fromCache,
    skipped,
    outputs,
  };
}

function buildOutputContext(stepResult: WorkflowStepResult): Record<string, unknown> {
  const context: Record<string, unknown> = {
    stdout: stepResult.stdout,
    stderr: stepResult.stderr,
    exitCode: stepResult.exitCode,
    attempts: stepResult.attempts,
    fromCache: stepResult.fromCache,
    skipped: stepResult.skipped,
  };

  for (const [key, value] of Object.entries(stepResult.outputs)) {
    context[key] = value;
  }

  return context;
}

export async function executeWorkflow(options: ExecuteWorkflowOptions): Promise<WorkflowResult> {
  const {
    workflow,
    defaultTool,
    args,
    positionalMappings = new Map<number, string>(),
    templateVars = {},
    env,
    rawOutput = false,
    captureOutput = "tee",
    resume = false,
    cacheDir,
    runCommandFn = runCommand,
    onStepStart,
    onStepComplete,
  } = options;

  const context: Record<string, unknown> = {
    ...templateVars,
    steps: {},
  };
  const stepResults: Record<string, WorkflowStepResult> = {};
  let workflowExitCode = 0;

  for (const batch of workflow.batches) {
    const batchResults = await Promise.all(
      batch.map(async (step): Promise<WorkflowStepResult> => {
        const stepContext = { ...context };

        if (step.vars) {
          for (const [varName, rawValue] of Object.entries(step.vars)) {
            stepContext[varName] = substituteTemplateVars(String(rawValue), context);
          }
        }

        const tool = (step.tool ?? defaultTool).trim();

        if (!evaluateWhen(step.when, stepContext)) {
          return toWorkflowStepResult(
            step,
            "",
            tool,
            { stdout: "", stderr: "", exitCode: 0 },
            0,
            false,
            true,
            {}
          );
        }

        const resolvedPrompt = substituteTemplateVars(step.run, stepContext);

        onStepStart?.(step);

        if (resume) {
          const cached = await getCachedResult({
            prompt: resolvedPrompt,
            args,
            tool,
            cacheDir,
          });

          if (cached.hit && cached.result) {
            const cachedResult = toWorkflowStepResult(
              step,
              resolvedPrompt,
              tool,
              cached.result,
              0,
              true,
              false,
              {}
            );
            onStepComplete?.(cachedResult);
            return cachedResult;
          }
        }

        const maxAttempts = (step.retry ?? 0) + 1;
        let attempt = 0;
        let lastRun: Pick<RunResult, "stdout" | "stderr" | "exitCode"> = {
          stdout: "",
          stderr: "",
          exitCode: 1,
        };

        while (attempt < maxAttempts) {
          attempt++;

          const runResult = await runCommandFn({
            command: tool,
            args,
            positionals: [resolvedPrompt],
            positionalMappings,
            captureOutput,
            captureStderr: true,
            env,
            rawOutput,
          });

          lastRun = runResult;
          if (runResult.exitCode === 0) break;
        }

        if (lastRun.exitCode === 0) {
          await setCachedResult(
            {
              prompt: resolvedPrompt,
              args,
              tool,
              cacheDir,
            },
            {
              stdout: lastRun.stdout,
              stderr: lastRun.stderr,
              exitCode: lastRun.exitCode,
            }
          );
        }

        const executedResult = toWorkflowStepResult(
          step,
          resolvedPrompt,
          tool,
          lastRun,
          attempt,
          false,
          false,
          {}
        );
        onStepComplete?.(executedResult);
        return executedResult;
      })
    );

    for (let i = 0; i < batch.length; i++) {
      const step = batch[i];
      const result = batchResults[i];
      if (!step || !result) continue;

      if (Object.keys(step.outputs ?? {}).length > 0) {
        const outputVars: Record<string, string> = {};
        const outputContext = {
          ...context,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        };

        for (const [key, template] of Object.entries(step.outputs ?? {})) {
          outputVars[key] = substituteTemplateVars(template, outputContext);
        }

        result.outputs = outputVars;
      }

      stepResults[step.id] = result;

      const stepsContext = context.steps as Record<string, unknown>;
      stepsContext[step.id] = buildOutputContext(result);

      if (result.exitCode !== 0 && !result.skipped && workflowExitCode === 0) {
        workflowExitCode = result.exitCode;
      }
    }

    if (workflowExitCode !== 0) {
      break;
    }
  }

  const stepOrder = workflow.batches.flatMap((batch) => batch.map((step) => step.id));

  if (workflowExitCode !== 0) {
    for (const stepId of stepOrder) {
      if (stepResults[stepId]) continue;
      stepResults[stepId] = {
        id: stepId,
        prompt: "",
        tool: defaultTool,
        stdout: "",
        stderr: "Skipped because a dependency failed in an earlier batch",
        exitCode: 0,
        attempts: 0,
        fromCache: false,
        skipped: true,
        outputs: {},
      };
    }
  }

  return {
    exitCode: workflowExitCode,
    stepOrder,
    steps: stepResults,
    templateVars: flattenTemplateVars(context),
  };
}
