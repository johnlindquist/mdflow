import PQueue from "p-queue";

export type SpikeRunState = "succeeded" | "failed";

export type SpikeEventType =
  | "run.started"
  | "task.started"
  | "task.succeeded"
  | "task.failed"
  | "queue.cleared"
  | "run.finished";

export type SpikeErrorCode =
  | "SPIKE_PQUEUE_TASK_FAILED"
  | "SPIKE_PQUEUE_INVALID_OPTIONS";

export interface SpikeRunOptions {
  scenarioId: string;
  runId?: string;
  taskCount: number;
  concurrency: number;
  taskDurationMs: number;
  failAtIndex?: number;
  stopOnFailure?: boolean;
}

export interface SpikeStateEvent {
  type: SpikeEventType;
  runId: string;
  scenarioId: string;
  ts: string;
  activeCount: number;
  taskIndex?: number;
  note?: string;
}

export interface SpikeStructuredError {
  code: SpikeErrorCode;
  runId: string;
  scenarioId: string;
  attempted: string;
  message: string;
  taskIndex?: number;
}

export interface SpikeRunResult {
  runId: string;
  scenarioId: string;
  state: SpikeRunState;
  taskCount: number;
  startedTaskCount: number;
  completedTaskCount: number;
  failedTaskIndex?: number;
  maxObservedConcurrency: number;
  elapsedMs: number;
  startedTaskIndexes: number[];
  completedTaskIndexes: number[];
  events: SpikeStateEvent[];
  error?: SpikeStructuredError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createRunId(): string {
  return `spike_${Date.now().toString(36)}`;
}

function isStructuredError(error: unknown): error is SpikeStructuredError {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  return (
    "code" in error &&
    "attempted" in error &&
    "message" in error &&
    "runId" in error &&
    "scenarioId" in error
  );
}

function validateOptions(options: SpikeRunOptions): SpikeStructuredError | undefined {
  const attempted = "validate p-queue spike options";
  const runId = options.runId ?? createRunId();

  if (!Number.isInteger(options.taskCount) || options.taskCount <= 0) {
    return {
      code: "SPIKE_PQUEUE_INVALID_OPTIONS",
      runId,
      scenarioId: options.scenarioId,
      attempted,
      message: "taskCount must be a positive integer",
    };
  }

  if (!Number.isInteger(options.concurrency) || options.concurrency <= 0) {
    return {
      code: "SPIKE_PQUEUE_INVALID_OPTIONS",
      runId,
      scenarioId: options.scenarioId,
      attempted,
      message: "concurrency must be a positive integer",
    };
  }

  if (options.failAtIndex !== undefined) {
    if (!Number.isInteger(options.failAtIndex)) {
      return {
        code: "SPIKE_PQUEUE_INVALID_OPTIONS",
        runId,
        scenarioId: options.scenarioId,
        attempted,
        message: "failAtIndex must be an integer when provided",
      };
    }

    if (options.failAtIndex < 0 || options.failAtIndex >= options.taskCount) {
      return {
        code: "SPIKE_PQUEUE_INVALID_OPTIONS",
        runId,
        scenarioId: options.scenarioId,
        attempted,
        message: "failAtIndex must reference an existing task",
      };
    }
  }

  if (!Number.isInteger(options.taskDurationMs) || options.taskDurationMs < 0) {
    return {
      code: "SPIKE_PQUEUE_INVALID_OPTIONS",
      runId,
      scenarioId: options.scenarioId,
      attempted,
      message: "taskDurationMs must be a non-negative integer",
    };
  }

  return undefined;
}

export async function runPQueueCompatibilitySpike(
  options: SpikeRunOptions,
): Promise<SpikeRunResult> {
  const validationError = validateOptions(options);
  if (validationError) {
    return {
      runId: validationError.runId,
      scenarioId: options.scenarioId,
      state: "failed",
      taskCount: options.taskCount,
      startedTaskCount: 0,
      completedTaskCount: 0,
      maxObservedConcurrency: 0,
      elapsedMs: 0,
      startedTaskIndexes: [],
      completedTaskIndexes: [],
      events: [],
      error: validationError,
    };
  }

  const runId = options.runId ?? createRunId();
  const queue = new PQueue({ concurrency: options.concurrency });
  const events: SpikeStateEvent[] = [];
  const startedTaskIndexes: number[] = [];
  const completedTaskIndexes: number[] = [];

  let activeCount = 0;
  let maxObservedConcurrency = 0;
  let failure: SpikeStructuredError | undefined;
  let queueClearedEventEmitted = false;

  const startedAt = performance.now();

  const emit = (
    type: SpikeEventType,
    taskIndex?: number,
    note?: string,
    activeCountOverride?: number,
  ): void => {
    events.push({
      type,
      runId,
      scenarioId: options.scenarioId,
      ts: new Date().toISOString(),
      activeCount: activeCountOverride ?? activeCount,
      taskIndex,
      note,
    });
  };

  emit("run.started", undefined, `tasks=${options.taskCount} concurrency=${options.concurrency}`);

  const taskPromises: Array<Promise<void>> = [];

  for (let index = 0; index < options.taskCount; index += 1) {
    const taskIndex = index;

    const taskPromise = queue.add(async () => {
      // Keep queue populated for deterministic insertion order, but skip
      // unstarted work after first failure when fail-fast is enabled.
      if (options.stopOnFailure && failure) {
        return;
      }

      activeCount += 1;
      if (activeCount > maxObservedConcurrency) {
        maxObservedConcurrency = activeCount;
      }

      startedTaskIndexes.push(taskIndex);
      emit("task.started", taskIndex);

      try {
        await sleep(options.taskDurationMs);

        if (options.failAtIndex === taskIndex) {
          throw {
            code: "SPIKE_PQUEUE_TASK_FAILED",
            runId,
            scenarioId: options.scenarioId,
            attempted: "execute queued task",
            message: `Injected failure for task ${taskIndex}`,
            taskIndex,
          } satisfies SpikeStructuredError;
        }

        completedTaskIndexes.push(taskIndex);
        emit("task.succeeded", taskIndex);
      } catch (error) {
        const taskError: SpikeStructuredError = isStructuredError(error)
          ? error
          : {
              code: "SPIKE_PQUEUE_TASK_FAILED",
              runId,
              scenarioId: options.scenarioId,
              attempted: "execute queued task",
              message: String(error),
              taskIndex,
            };

        if (!failure) {
          failure = taskError;

          if (options.stopOnFailure && !queueClearedEventEmitted) {
            queueClearedEventEmitted = true;
            emit(
              "queue.cleared",
              taskIndex,
              `stopOnFailure enabled; skipping pending tasks after failure at task ${taskIndex}`,
            );
          }
        }

        emit("task.failed", taskIndex, taskError.message);
        throw taskError;
      } finally {
        activeCount -= 1;
      }
    });

    taskPromises.push(taskPromise);
  }

  const settled = await Promise.allSettled(taskPromises);

  if (!failure) {
    for (const settledPromise of settled) {
      if (settledPromise.status !== "rejected") {
        continue;
      }

      if (isStructuredError(settledPromise.reason)) {
        failure = settledPromise.reason;
        break;
      }

      failure = {
        code: "SPIKE_PQUEUE_TASK_FAILED",
        runId,
        scenarioId: options.scenarioId,
        attempted: "await queued task promises",
        message: String(settledPromise.reason),
      };
      break;
    }
  }

  await queue.onIdle();

  const elapsedMs = Math.round(performance.now() - startedAt);
  const state: SpikeRunState = failure ? "failed" : "succeeded";

  emit("run.finished", undefined, state, activeCount);

  return {
    runId,
    scenarioId: options.scenarioId,
    state,
    taskCount: options.taskCount,
    startedTaskCount: startedTaskIndexes.length,
    completedTaskCount: completedTaskIndexes.length,
    failedTaskIndex: failure?.taskIndex,
    maxObservedConcurrency,
    elapsedMs,
    startedTaskIndexes,
    completedTaskIndexes,
    events,
    error: failure,
  };
}
