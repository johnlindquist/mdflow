import { expect, test } from "bun:test";
import { runPQueueCompatibilitySpike } from "./pqueue-compat";

function range(length: number): number[] {
  return Array.from({ length }, (_, index) => index);
}

test("test_runPQueueCompatibilitySpike_enforcesConcurrencyCap_whenTasksRunInParallel", async () => {
  const result = await runPQueueCompatibilitySpike({
    scenarioId: "concurrency-cap",
    taskCount: 24,
    concurrency: 4,
    taskDurationMs: 8,
  });

  expect(result.state).toBe("succeeded");
  expect(result.maxObservedConcurrency).toBeLessThanOrEqual(4);
  expect(result.maxObservedConcurrency).toBeGreaterThan(1);
  expect(result.startedTaskCount).toBe(24);
  expect(result.completedTaskCount).toBe(24);
  expect(result.events[0]?.type).toBe("run.started");
  expect(result.events.at(-1)?.type).toBe("run.finished");
});

test("test_runPQueueCompatibilitySpike_preservesInsertionOrder_whenConcurrencyIsOne", async () => {
  const taskCount = 10;
  const expectedOrder = range(taskCount);

  const result = await runPQueueCompatibilitySpike({
    scenarioId: "deterministic-order",
    taskCount,
    concurrency: 1,
    taskDurationMs: 1,
  });

  expect(result.state).toBe("succeeded");
  expect(result.startedTaskIndexes).toEqual(expectedOrder);
  expect(result.completedTaskIndexes).toEqual(expectedOrder);
});

test("test_runPQueueCompatibilitySpike_reportsFailure_whenATaskThrows", async () => {
  const result = await runPQueueCompatibilitySpike({
    scenarioId: "task-failure",
    taskCount: 5,
    concurrency: 1,
    taskDurationMs: 2,
    failAtIndex: 3,
  });

  expect(result.state).toBe("failed");
  expect(result.failedTaskIndex).toBe(3);
  expect(result.startedTaskIndexes).toEqual([0, 1, 2, 3, 4]);
  expect(result.completedTaskIndexes).toEqual([0, 1, 2, 4]);
  expect(result.events.some((event) => event.type === "task.failed")).toBeTrue();
});

test("test_runPQueueCompatibilitySpike_stopsStartingPendingTasks_whenStopOnFailureIsEnabled", async () => {
  const result = await runPQueueCompatibilitySpike({
    scenarioId: "task-failure-stop-on-failure",
    taskCount: 8,
    concurrency: 1,
    taskDurationMs: 2,
    failAtIndex: 3,
    stopOnFailure: true,
  });

  expect(result.state).toBe("failed");
  expect(result.failedTaskIndex).toBe(3);
  expect(result.startedTaskIndexes).toEqual([0, 1, 2, 3]);
  expect(result.completedTaskIndexes).toEqual([0, 1, 2]);
  expect(result.events.some((event) => event.type === "queue.cleared")).toBeTrue();
});

test("test_runPQueueCompatibilitySpike_returnsStructuredError_whenOptionsAreInvalid", async () => {
  const result = await runPQueueCompatibilitySpike({
    scenarioId: "invalid-options",
    taskCount: 0,
    concurrency: 0,
    taskDurationMs: -1,
  });

  expect(result.state).toBe("failed");
  expect(result.error?.code).toBe("SPIKE_PQUEUE_INVALID_OPTIONS");
  expect(result.error?.attempted).toBe("validate p-queue spike options");
});
