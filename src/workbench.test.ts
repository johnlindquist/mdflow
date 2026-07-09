import { describe, expect, test } from "bun:test";
import type { AgentFile } from "./cli";
import {
  evolveWriteResult,
  getWorkbenchRows,
  isEvolveWriteConfirmationKey,
} from "./workbench";

const flows: AgentFile[] = [
  {
    name: "release-notes.md",
    path: "/repo/flows/release-notes.md",
    source: "flows",
    description: "Draft release notes from the current branch",
  },
  {
    name: "review.md",
    path: "/repo/flows/review.md",
    source: "flows",
    description: "Review staged changes",
  },
];

describe("Flow Workbench rows", () => {
  test("zero-flow projects still offer the synthetic Create row", () => {
    expect(getWorkbenchRows([], "")).toEqual([{ kind: "create", score: -1 }]);
  });

  test("preserves discovery priority until the user searches", () => {
    const userFlow = { ...flows[0]!, source: "~/.mdflow", frecency: 999 };
    const projectFlow = { ...flows[1]!, source: "flows", frecency: 0 };
    const rows = getWorkbenchRows([projectFlow, userFlow], "");
    expect(rows[0]?.kind === "flow" ? rows[0].file.source : undefined).toBe("flows");
  });

  test("filters names and descriptions while retaining Create for the intent", () => {
    const rows = getWorkbenchRows(flows, "current branch");
    expect(rows.map((row) => row.kind)).toEqual(["flow", "create"]);
    expect(rows[0]?.kind === "flow" ? rows[0].file.name : undefined).toBe("release-notes.md");
  });

  test("an unmatched search becomes a one-step creation path", () => {
    expect(getWorkbenchRows(flows, "triage production incidents")).toEqual([
      { kind: "create", score: -1 },
    ]);
  });
});

describe("Flow Workbench local-write confirmation", () => {
  test("builds exact apply and rollback commands without losing the selected run", () => {
    expect(evolveWriteResult("evolve-apply", flows[1]!, "run with spaces", "md")).toMatchObject({
      action: "evolve-apply",
      effect: "LOCAL WRITE",
      command: "md evolve apply 'run with spaces'",
      path: "/repo/flows/review.md",
      runId: "run with spaces",
    });
    expect(evolveWriteResult("evolve-rollback", flows[1]!, "run-123", "mdflow")).toMatchObject({
      action: "evolve-rollback",
      effect: "LOCAL WRITE",
      command: "mdflow evolve rollback run-123",
      runId: "run-123",
    });
  });

  test("does not treat the first apply or rollback key as confirmation", () => {
    expect(isEvolveWriteConfirmationKey({ name: "a" } as never)).toBe(false);
    expect(isEvolveWriteConfirmationKey({ name: "r" } as never)).toBe(false);
    expect(isEvolveWriteConfirmationKey({ name: "c", ctrl: true } as never)).toBe(false);
    expect(isEvolveWriteConfirmationKey({ name: "c", meta: true } as never)).toBe(false);
    expect(isEvolveWriteConfirmationKey({ name: "c" } as never)).toBe(true);
    expect(isEvolveWriteConfirmationKey({ name: "return" } as never)).toBe(true);
  });
});
