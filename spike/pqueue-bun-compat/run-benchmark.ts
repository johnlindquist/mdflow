import { runPQueueCompatibilitySpike, type SpikeRunOptions } from "./pqueue-compat";

interface ScenarioDefinition {
  scenarioId: string;
  options: Omit<SpikeRunOptions, "scenarioId">;
}

interface ScenarioMeasurement {
  scenarioId: string;
  pass: boolean;
  expectedState: "succeeded" | "failed";
  resultState: "succeeded" | "failed";
  elapsedMs: number;
  idealMs: number;
  overheadMs: number;
  throughputTasksPerSec: number;
  maxObservedConcurrency: number;
  startedTaskCount: number;
  completedTaskCount: number;
  failedTaskIndex?: number;
  checks: string[];
}

function toFixedNumber(value: number, decimals: number): number {
  return Number(value.toFixed(decimals));
}

function checkScenario(
  scenario: ScenarioDefinition,
  result: Awaited<ReturnType<typeof runPQueueCompatibilitySpike>>,
): ScenarioMeasurement {
  const checks: string[] = [];
  const expectedState: "succeeded" | "failed" =
    scenario.options.failAtIndex === undefined ? "succeeded" : "failed";

  const idealMs =
    Math.ceil(scenario.options.taskCount / scenario.options.concurrency) *
    scenario.options.taskDurationMs;
  const elapsedMs = result.elapsedMs;
  const overheadMs = elapsedMs - idealMs;

  checks.push(
    result.maxObservedConcurrency <= scenario.options.concurrency
      ? "maxObservedConcurrency<=configured"
      : "maxObservedConcurrency>configured",
  );

  checks.push(
    result.startedTaskCount >= result.completedTaskCount
      ? "startedTaskCount>=completedTaskCount"
      : "startedTaskCount<completedTaskCount",
  );

  if (expectedState === "succeeded") {
    checks.push(
      result.completedTaskCount === scenario.options.taskCount
        ? "allTasksCompleted"
        : "missingCompletedTasks",
    );
  }

  if (
    expectedState === "failed" &&
    scenario.options.failAtIndex !== undefined &&
    scenario.options.stopOnFailure
  ) {
    checks.push(
      result.startedTaskCount === scenario.options.failAtIndex + 1
        ? "stopOnFailurePreventedNewStarts"
        : "stopOnFailureDidNotPreventNewStarts",
    );
  }

  const pass =
    result.state === expectedState &&
    checks.every((check) =>
      [
        "maxObservedConcurrency<=configured",
        "startedTaskCount>=completedTaskCount",
        "allTasksCompleted",
        "stopOnFailurePreventedNewStarts",
      ].includes(check),
    );

  return {
    scenarioId: scenario.scenarioId,
    pass,
    expectedState,
    resultState: result.state,
    elapsedMs,
    idealMs,
    overheadMs,
    throughputTasksPerSec: toFixedNumber(
      scenario.options.taskCount / Math.max(1, elapsedMs / 1000),
      2,
    ),
    maxObservedConcurrency: result.maxObservedConcurrency,
    startedTaskCount: result.startedTaskCount,
    completedTaskCount: result.completedTaskCount,
    failedTaskIndex: result.failedTaskIndex,
    checks,
  };
}

async function main(): Promise<void> {
  const scenarios: ScenarioDefinition[] = [
    {
      scenarioId: "load-256-c8-d6",
      options: {
        taskCount: 256,
        concurrency: 8,
        taskDurationMs: 6,
      },
    },
    {
      scenarioId: "load-512-c16-d4",
      options: {
        taskCount: 512,
        concurrency: 16,
        taskDurationMs: 4,
      },
    },
    {
      scenarioId: "failure-stop-c1",
      options: {
        taskCount: 32,
        concurrency: 1,
        taskDurationMs: 2,
        failAtIndex: 5,
        stopOnFailure: true,
      },
    },
  ];

  const measurements: ScenarioMeasurement[] = [];

  for (const scenario of scenarios) {
    const result = await runPQueueCompatibilitySpike({
      scenarioId: scenario.scenarioId,
      ...scenario.options,
    });

    const measurement = checkScenario(scenario, result);
    measurements.push(measurement);

    console.log(`SPIKE_PQUEUE_SCENARIO ${JSON.stringify(measurement)}`);
  }

  const passCount = measurements.filter((measurement) => measurement.pass).length;
  const summary = {
    totalScenarios: measurements.length,
    passedScenarios: passCount,
    failedScenarios: measurements.length - passCount,
    allPassed: passCount === measurements.length,
  };

  console.log(`SPIKE_PQUEUE_SUMMARY ${JSON.stringify(summary)}`);

  if (!summary.allPassed) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  void main();
}
