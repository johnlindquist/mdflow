import { describe, expect, test } from "bun:test";
import { contextualFlowTip, flowCommand } from "./tips";

describe("flowCommand", () => {
  test("uses the extensionless roster shorthand", () => {
    expect(flowCommand("/repo/flows/review.md", "/repo")).toBe("md review");
  });

  test("keeps a project-relative path outside the roster", () => {
    expect(flowCommand("/repo/prompts/review.md", "/repo")).toBe("md prompts/review.md");
  });

  test("quotes display commands that contain spaces", () => {
    expect(flowCommand("/repo/flows/release notes.md", "/repo")).toBe("md 'release notes'");
  });
});

describe("contextualFlowTip", () => {
  test("teaches both direct execution and the workbench after creation", () => {
    expect(contextualFlowTip({ cwd: "/repo", flowPath: "/repo/flows/review.md", created: true }))
      .toContain("md review");
  });

  test("points an unproved first run toward the improve workspace", () => {
    expect(contextualFlowTip({
      cwd: "/repo",
      flowPath: "/repo/flows/review.md",
      firstSuccessfulRun: true,
      hasEval: false,
    })).toContain("press i");
  });
});
