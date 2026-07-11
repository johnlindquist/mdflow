import { describe, expect, test } from "bun:test";
import type { KeypressEvent } from "@inquirer/core";
import { PassThrough } from "node:stream";
import type { AgentFile } from "./cli";
import {
  evolveWriteResult,
  getWorkbenchRows,
  hooksAddResult,
  hooksOpenResult,
  isEvolveWriteConfirmationKey,
  newFlowArgs,
  newFlowCommand,
  splitDocsInput,
  workbenchPrompt,
  type WorkbenchConfig,
} from "./workbench";
import type { WorkbenchHooksStatus } from "./workbench-hooks";
import { workbenchInputPrompt } from "./workbench-input";

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
  test("zero-flow projects produce a real empty result set", () => {
    expect(getWorkbenchRows([], "")).toEqual([]);
  });

  test("uses frecency as the default ordering", () => {
    const userFlow = { ...flows[0]!, source: "~/.mdflow", frecency: 999 };
    const projectFlow = { ...flows[1]!, source: "flows", frecency: 0 };
    const rows = getWorkbenchRows([projectFlow, userFlow], "");
    expect(rows[0]?.file.source).toBe("~/.mdflow");
  });

  test("filters names and descriptions without synthetic command rows", () => {
    const rows = getWorkbenchRows(flows, "current branch");
    expect(rows.map((row) => row.kind)).toEqual(["flow"]);
    expect(rows[0]?.file.name).toBe("release-notes.md");
    expect(rows[0]).toMatchObject({
      matchField: "description",
      matchValue: "Draft release notes from the current branch",
    });
    expect(rows[0]?.matchIndices.length).toBeGreaterThan(0);
  });

  test("returns an empty state for an unmatched search", () => {
    expect(getWorkbenchRows(flows, "xyzzy-no-match")).toEqual([]);
  });
});

describe("Flow Workbench composer", () => {
  test("splits comma-separated docs and keeps command spaces intact", () => {
    expect(splitDocsInput(" gog --help , https://example.com/api.md ,, ")).toEqual([
      "gog --help",
      "https://example.com/api.md",
    ]);
    expect(splitDocsInput("")).toEqual([]);
  });

  test("builds the exact md create shell equivalent from a composer spec", () => {
    expect(
      newFlowCommand({
        intent: "Summarize gog output",
        slug: "summarize-gog",
        docs: ["gog --help"],
        engine: "codex",
        model: "gpt-5.5",
        effort: "high",
      }),
    ).toBe(
      "md create 'Summarize gog output' --name summarize-gog --engine codex --model gpt-5.5 --effort high --docs 'gog --help' --project",
    );
    expect(
      newFlowCommand({ intent: "Review changes", slug: "review-changes", docs: [], engine: "codex" }),
    ).toBe("md create 'Review changes' --name review-changes --engine codex --project");
    expect(
      newFlowArgs({
        intent: "Review changes",
        slug: "review-changes",
        docs: [],
        engine: "codex",
        location: "user",
      }),
    ).toEqual([
      "Review changes", "--name", "review-changes", "--engine", "codex", "--global",
    ]);
    expect(
      newFlowArgs({
        intent: "Review changes",
        slug: "review-changes",
        docs: [],
        engine: "codex",
        location: "cwd",
      }).slice(-2),
    ).toEqual(["--location", "cwd"]);
    expect(
      newFlowArgs({
        intent: "Review changes",
        slug: "review-changes",
        docs: [],
        engine: "codex",
        location: "custom",
        customDir: "shared flows",
      }).slice(-2),
    ).toEqual(["--dir", "shared flows"]);
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
    expect(isEvolveWriteConfirmationKey({ name: "c" } as never)).toBe(false);
    expect(isEvolveWriteConfirmationKey({ name: "return" } as never)).toBe(true);
  });
});

describe("Flow Workbench hooks actions", () => {
  test("keeps the flow path separate from the hooks file and exposes exact shell commands", () => {
    expect(
      hooksAddResult(flows[1]!, ["sessionStart", "stop"], "md", "/repo"),
    ).toMatchObject({
      action: "hooks-add",
      effect: "LOCAL WRITE",
      command: "md hooks add flows/review.md sessionStart stop",
      path: "/repo/flows/review.md",
      hooksPath: "/repo/flows/review.hooks.ts",
      hookEvents: ["sessionStart", "stop"],
    });
    expect(
      hooksOpenResult(flows[1]!, "/repo/flows/review.hooks.ts", "/repo"),
    ).toMatchObject({
      action: "hooks-open",
      effect: "LOCAL WRITE",
      command: "$EDITOR flows/review.hooks.ts",
      path: "/repo/flows/review.md",
      hooksPath: "/repo/flows/review.hooks.ts",
    });
  });
});

interface TestKeypressEvent extends KeypressEvent {
  sequence?: string;
  meta?: boolean;
  shift?: boolean;
}

async function promptHarness(
  testFlows: readonly AgentFile[] = flows,
  overrides: Partial<WorkbenchConfig> = {},
) {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => input });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 100, rows: 30 });
  let transcript = "";
  let checkpoint = 0;
  output.on("data", (chunk) => {
    transcript += chunk.toString();
  });
  const pending = workbenchPrompt(
    { files: testFlows, projectRoot: "/repo", cwd: "/repo", pageSize: 10, ...overrides },
    { input, output, clearPromptOnDone: true },
  );
  await Bun.sleep(0);
  return {
    pending,
    async press(event: TestKeypressEvent) {
      input.emit("keypress", event.sequence ?? "", event);
      await Bun.sleep(0);
    },
    takeOutput() {
      const next = transcript.slice(checkpoint);
      checkpoint = transcript.length;
      return next;
    },
  };
}

const key = (
  name: string,
  sequence = name.length === 1 ? name : undefined,
  options: Partial<TestKeypressEvent> = {},
): TestKeypressEvent => ({ name, sequence, ctrl: false, ...options });

describe("Flow Workbench keypress path", () => {
  test("typing immediately filters and bare shortcut letters remain search text", async () => {
    const prompt = await promptHarness();
    prompt.takeOutput();
    await prompt.press(key("n"));
    const rendered = prompt.takeOutput();
    expect(rendered).toContain("Find:");
    expect(rendered).toContain("n");
    expect(rendered).not.toContain("Compose a new flow");
    await prompt.press(key("enter"));
    expect(await prompt.pending).toMatchObject({ action: "run", path: flows[0]!.path });
  });

  test("description matches show and highlight the field that caused the result", async () => {
    const prompt = await promptHarness();
    for (const character of "current branch") await prompt.press(key(character));
    const rendered = prompt.takeOutput();
    expect(rendered).toContain("description:");
    expect(rendered).toContain("\x1b[1;36mc");
    await prompt.press(key("enter"));
    expect(await prompt.pending).toMatchObject({ path: flows[0]!.path });
  });

  test("every former bare shortcut and a Unicode printable character enter search", async () => {
    const prompt = await promptHarness();
    let settled = false;
    void prompt.pending.then(() => { settled = true; });
    for (const character of ["q", "n", "d", "e", "i", "f", "/"]) {
      await prompt.press(key(character));
      expect(settled).toBe(false);
    }
    expect(prompt.takeOutput()).toContain("qndeif/");
    await prompt.press(key("escape"));
    await prompt.press(key("🙂", "🙂"));
    expect(prompt.takeOutput()).toContain("🙂");
    await prompt.press(key("escape"));
    await prompt.press(key("escape"));
    expect(await prompt.pending).toMatchObject({ action: "cancel" });
  });

  test("Tab opens Actions and never enters the query buffer", async () => {
    const prompt = await promptHarness();
    await prompt.press(key("r"));
    await prompt.press(key("tab", "\t"));
    const actions = prompt.takeOutput();
    expect(actions).toContain("ACTIONS");
    for (const label of [
      "Run flow",
      "Preview dry-run",
      "Edit flow",
      "Add hooks",
      "Add feedback",
      "Plan evolution readiness",
      "Create evolution proposal",
      "Apply verified proposal",
      "Roll back applied proposal",
    ]) expect(actions).toContain(label);
    await prompt.press(key("tab", "\t"));
    const home = prompt.takeOutput();
    expect(home).toContain("Find:");
    expect(home).not.toContain("\t");
    await prompt.press(key("escape"));
    await prompt.press(key("escape"));
    expect(await prompt.pending).toMatchObject({ action: "cancel" });
  });

  test("Add hooks opens a Tab-safe canonical-event picker", async () => {
    const prompt = await promptHarness();
    expect(prompt.takeOutput()).toContain("no hooks");
    await prompt.press(key("tab", "\t"));
    await prompt.press(key("down"));
    await prompt.press(key("down"));
    await prompt.press(key("down"));
    await prompt.press(key("enter"));
    expect(prompt.takeOutput()).toContain("CANONICAL EVENTS");

    await prompt.press(key("tab", "\t"));
    await prompt.press(key("tab", "\x1b[Z", { shift: true }));
    await prompt.press(key("space", " "));
    await prompt.press(key("tab", "\t"));
    await prompt.press(key("space", " "));
    await prompt.press(key("enter"));

    expect(await prompt.pending).toMatchObject({
      action: "hooks-add",
      effect: "LOCAL WRITE",
      command: "md hooks add flows/release-notes.md sessionStart userPromptSubmit",
      path: flows[0]!.path,
      hooksPath: "/repo/flows/release-notes.hooks.ts",
      hookEvents: ["sessionStart", "userPromptSubmit"],
    });
  });

  test("Esc cancels hook selection back to Actions without settling the prompt", async () => {
    const prompt = await promptHarness();
    let settled = false;
    void prompt.pending.then(() => { settled = true; });
    await prompt.press(key("tab", "\t"));
    for (let index = 0; index < 3; index += 1) await prompt.press(key("down"));
    await prompt.press(key("enter"));
    await prompt.press(key("escape"));
    expect(settled).toBe(false);
    expect(prompt.takeOutput()).toContain("ACTIONS");
    await prompt.press(key("tab", "\t"));
    await prompt.press(key("escape"));
    expect(await prompt.pending).toMatchObject({ action: "cancel" });
  });

  test("existing hooks paint loading first, hydrate event names, and open instead of scaffold", async () => {
    const file = flows[1]!;
    const hooksPath = "/repo/flows/review.hooks.ts";
    let hooksStatus: WorkbenchHooksStatus = {
      state: "loading",
      path: hooksPath,
      mtimeMs: 1,
    };
    const prompt = await promptHarness([file], {
      hooksStatusFor: () => hooksStatus,
      hydrateHooksStatus: async () => {
        await Bun.sleep(20);
        hooksStatus = {
          state: "ready",
          path: hooksPath,
          mtimeMs: 1,
          events: ["sessionStart", "stop"],
        };
        return hooksStatus;
      },
    });
    expect(prompt.takeOutput()).toContain("loading events…");

    let hydrated = "";
    for (let attempt = 0; attempt < 100 && !hydrated.includes("2 events"); attempt += 1) {
      await Bun.sleep(5);
      hydrated += prompt.takeOutput();
    }
    expect(hydrated).toContain("2 events (sessionStart, stop)");

    await prompt.press(key("tab", "\t"));
    const actions = prompt.takeOutput();
    expect(actions).toContain("Open hooks file (2 events)");
    for (let index = 0; index < 3; index += 1) await prompt.press(key("down"));
    await prompt.press(key("enter"));
    expect(await prompt.pending).toMatchObject({
      action: "hooks-open",
      effect: "LOCAL WRITE",
      command: "$EDITOR flows/review.hooks.ts",
      path: file.path,
      hooksPath,
    });
  });

  test("Ctrl+N remains next-selection navigation", async () => {
    const prompt = await promptHarness();
    await prompt.press(key("n", "\x0e", { ctrl: true }));
    await prompt.press(key("enter"));
    expect(await prompt.pending).toMatchObject({ action: "run", path: flows[1]!.path });
  });

  test("Actions navigation dispatches the highlighted capability", async () => {
    const prompt = await promptHarness();
    await prompt.press(key("tab", "\t"));
    await prompt.press(key("down"));
    await prompt.press(key("enter"));
    expect(await prompt.pending).toMatchObject({
      action: "dry-run",
      effect: "FREE",
      path: flows[0]!.path,
    });
  });

  test("Esc clears the query first and exits only when it is already empty", async () => {
    const prompt = await promptHarness();
    let settled = false;
    void prompt.pending.then(() => { settled = true; });
    await prompt.press(key("x"));
    expect(prompt.takeOutput()).toContain("No flows match");
    await prompt.press(key("escape"));
    expect(settled).toBe(false);
    expect(prompt.takeOutput()).toContain("2 flows");
    await prompt.press(key("escape"));
    expect(await prompt.pending).toMatchObject({ action: "cancel" });
  });

  test("Ctrl+O opens a scope-first composer and Tab keeps its intent clean", async () => {
    const prompt = await promptHarness();
    await prompt.press(key("o", "\x0f", { ctrl: true }));
    expect(prompt.takeOutput()).toContain("Creating in THIS PROJECT");
    await prompt.press(key("right"));
    expect(prompt.takeOutput()).toContain("Creating in CURRENT DIRECTORY");
    await prompt.press(key("right"));
    const globalScope = prompt.takeOutput();
    expect(globalScope).toContain("Creating GLOBALLY");
    expect(globalScope).toContain("(available from");
    expect(globalScope).toContain("any directory as md new-flow)");
    await prompt.press(key("tab", "\t"));
    await prompt.press(key("r"));
    await prompt.press(key("tab", "\t"));
    await prompt.press(key("enter"));
    const result = await prompt.pending;
    expect(result).toMatchObject({ action: "create", intent: "r" });
    expect(result.createArgs).toContain("--global");
    expect(result.intent).not.toContain("\t");
    expect(result.createArgs?.join("")).not.toContain("\t");
  });

  test("a configured noncanonical flows directory is handed off as the visible custom scope", async () => {
    const prompt = await promptHarness(flows, { flowsDirectory: "/repo/automation" });
    await prompt.press(key("o", "\x0f", { ctrl: true }));
    const scope = prompt.takeOutput();
    expect(scope).toContain("Creating in CUSTOM DIRECTORY");
    expect(scope).toContain("./automation/new-flow.md");
    await prompt.press(key("tab", "\t"));
    await prompt.press(key("tab", "\t"));
    await prompt.press(key("r"));
    await prompt.press(key("enter"));
    const result = await prompt.pending;
    expect(result.path).toBe("/repo/automation/r.md");
    expect(result.createArgs).toContain("--dir");
    expect(result.createArgs).toContain("/repo/automation");
  });

  test("reachable text prompts explicitly discard Tab", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const pending = workbenchInputPrompt(
      { message: "Intent" },
      { input, output, clearPromptOnDone: true },
    );
    await Bun.sleep(0);
    input.emit("keypress", "a", key("a"));
    input.emit("keypress", "\t", key("tab", "\t"));
    input.emit("keypress", "b", key("b"));
    input.emit("keypress", "\x1b[Z", key("tab", "\x1b[Z", { shift: true }));
    input.emit("keypress", "c", key("c"));
    input.emit("keypress", "", key("enter"));
    expect(await pending).toBe("abc");
  });

  test("Tab-safe history input keeps and accepts its default", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const pending = workbenchInputPrompt(
      { message: "Variable", default: "previous" },
      { input, output, clearPromptOnDone: true },
    );
    await Bun.sleep(0);
    input.emit("keypress", "\t", key("tab", "\t"));
    input.emit("keypress", "", key("enter"));
    expect(await pending).toBe("previous");
  });
});
