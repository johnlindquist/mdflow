/**
 * Run-pipeline integration for lifecycle hooks, exercised through the real
 * CLI entry in a subprocess with --_dry-run so no engine is ever spawned.
 * Covers the discovery/override/failure matrix end to end: convention hit,
 * `_hooks: false`, `--_hooks` overrides, missing explicit files, unsupported
 * engines, and broken hook programs.
 */

import { describe, it, expect, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderHooksTemplate } from "./hooks";

const CLI = join(import.meta.dir, "index.ts");

// Each case boots a real CLI subprocess. Keep the integration contract stable
// when the developer workstation is busy; Bun's 5s unit-test default is too
// tight for process startup under load.
setDefaultTimeout(20_000);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mdflow-hooks-int-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, MDFLOW_EVAL_RUN: "1", NO_COLOR: "1" },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function writeFlow(name = "task.codex.md"): string {
  writeFileSync(join(dir, name), "---\ndescription: hooks integration\n---\nSay ok.\n");
  return name;
}

function writeHooks(events: Parameters<typeof renderHooksTemplate>[0], name = "task.codex.hooks.ts"): string {
  writeFileSync(join(dir, name), renderHooksTemplate(events), { mode: 0o755 });
  return name;
}

describe("hooks in the run pipeline (dry-run)", () => {
  it("convention file: injects the -c hooks override and the trust bypass flag", async () => {
    const flow = writeFlow();
    writeHooks(["sessionStart", "stop"]);
    const result = await runCli([flow, "--_dry-run"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--config hooks={SessionStart=[{hooks=[{type=");
    expect(result.stdout).toContain("--dangerously-bypass-hook-trust");
    expect(result.stderr).toContain("hooks: task.codex.hooks.ts (sessionStart, stop)");
  });

  it("no hooks file: no hook flags, no stderr line", async () => {
    const flow = writeFlow();
    const result = await runCli([flow, "--_dry-run"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("hooks={");
    expect(result.stdout).not.toContain("--dangerously-bypass-hook-trust");
    expect(result.stderr).not.toContain("hooks:");
  });

  it("_hooks: false disables a present convention file", async () => {
    writeFileSync(
      join(dir, "task.codex.md"),
      "---\ndescription: t\n_hooks: false\n---\nSay ok.\n"
    );
    writeHooks(["stop"]);
    const result = await runCli(["task.codex.md", "--_dry-run"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("hooks={");
    expect(result.stdout).not.toContain("--_hooks");
  });

  it("--_hooks false disables from the CLI", async () => {
    const flow = writeFlow();
    writeHooks(["stop"]);
    const result = await runCli([flow, "--_hooks", "false", "--_dry-run"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("hooks={");
  });

  it("--_hooks <path> selects a shared hooks file over the convention", async () => {
    const flow = writeFlow();
    writeHooks(["stop"]);
    writeHooks(["preToolUse"], "shared.hooks.ts");
    const result = await runCli([flow, "--_hooks", join(dir, "shared.hooks.ts"), "--_dry-run"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hooks={PreToolUse=");
    expect(result.stdout).not.toContain("Stop=");
    expect(result.stderr).toContain("shared.hooks.ts (preToolUse)");
  });

  it("frontmatter _hooks path resolves relative to the flow file", async () => {
    writeFileSync(
      join(dir, "task.codex.md"),
      "---\ndescription: t\n_hooks: ./shared.hooks.ts\n---\nSay ok.\n"
    );
    writeHooks(["userPromptSubmit"], "shared.hooks.ts");
    const result = await runCli(["task.codex.md", "--_dry-run"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hooks={UserPromptSubmit=");
  });

  it("a missing explicit hooks file fails the run with guidance", async () => {
    writeFileSync(
      join(dir, "task.codex.md"),
      "---\ndescription: t\n_hooks: ./nope.hooks.ts\n---\nSay ok.\n"
    );
    const result = await runCli(["task.codex.md", "--_dry-run"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Hooks file not found");
    expect(result.stderr).toContain("md hooks add");
  });

  it("an engine without hook support fails when a hooks file exists", async () => {
    writeFileSync(join(dir, "task.droid.md"), "---\ndescription: t\n---\nSay ok.\n");
    writeHooks(["stop"], "task.droid.hooks.ts");
    const result = await runCli(["task.droid.md", "--_dry-run"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("no verified lifecycle-hook mechanism");
    expect(result.stderr).toContain("_hooks: false");
  });

  it("a hooks file with no readable handlers map fails the dry run (without executing it)", async () => {
    const flow = writeFlow();
    writeFileSync(join(dir, "task.codex.hooks.ts"), "#!/usr/bin/env bun\nconsole.log('junk');\n", {
      mode: 0o755,
    });
    const result = await runCli([flow, "--_dry-run"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("no statically readable handlers map");
  });

  it("interactive mode keeps hooks: top-level codex accepts -c and the bypass flag", async () => {
    writeFileSync(join(dir, "task.i.codex.md"), "---\ndescription: t\n---\nSay ok.\n");
    writeHooks(["stop"], "task.i.codex.hooks.ts");
    const result = await runCli(["task.i.codex.md", "--_dry-run"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hooks={Stop=");
    expect(result.stdout).toContain("--dangerously-bypass-hook-trust");
    // exec-only isolation flags must be stripped in interactive mode
    expect(result.stdout).not.toContain("--ignore-user-config");
  });

  it("hook flags never leak into template vars or positional prompts", async () => {
    const flow = writeFlow();
    writeHooks(["stop"]);
    const result = await runCli([flow, "--_dry-run"]);
    expect(result.stdout).not.toContain("--_hooks");
    expect(result.stdout).not.toContain("_hooks:");
  });
});

describe("consent boundaries (audit regressions)", () => {
  /** A hooks file whose top-level code proves execution by writing a sentinel. */
  function writeBoobyTrappedHooks(name: string, sentinel: string, withMarker: boolean): void {
    const marker = withMarker
      ? 'type HookHandler = (p: unknown) => unknown;\nconst handlers: Record<string, HookHandler> = {\n  stop: async (_p) => {\n  },\n};\n'
      : "";
    writeFileSync(
      join(dir, name),
      `#!/usr/bin/env bun\nawait Bun.write(${JSON.stringify(sentinel)}, "executed");\n${marker}`,
      { mode: 0o755 }
    );
  }

  it("md explain never executes the hooks file", async () => {
    const flow = writeFlow();
    const sentinel = join(dir, "explain-executed.txt");
    writeBoobyTrappedHooks("task.codex.hooks.ts", sentinel, true);
    const result = await runCli(["explain", flow]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("LIFECYCLE HOOKS");
    expect(result.stdout).toContain("stop");
    expect(existsSync(sentinel)).toBe(false);
  });

  it("dry-run never executes the hooks file, even when static parsing fails", async () => {
    const flow = writeFlow();
    const sentinel = join(dir, "dryrun-executed.txt");
    writeBoobyTrappedHooks("task.codex.hooks.ts", sentinel, false);
    const result = await runCli([flow, "--_dry-run"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("no statically readable handlers map");
    expect(existsSync(sentinel)).toBe(false);
  });

  it("md hooks list never executes the hooks file", async () => {
    const flow = writeFlow();
    const sentinel = join(dir, "list-executed.txt");
    writeBoobyTrappedHooks("task.codex.hooks.ts", sentinel, true);
    const result = await runCli(["hooks", "list", flow]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(sentinel)).toBe(false);
  });

  it("rejects a _hooks path that escapes the flow's directory", async () => {
    mkdirSync(join(dir, "flows"));
    writeFileSync(
      join(dir, "flows", "task.codex.md"),
      "---\ndescription: t\n_hooks: ../evil.hooks.ts\n---\nSay ok.\n"
    );
    writeHooks(["stop"], "evil.hooks.ts");
    const result = await runCli(["flows/task.codex.md", "--_dry-run"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("escapes the flow's directory");
  });

  it("hooks on codex require isolation: _isolated false + hooks file fails", async () => {
    writeFileSync(
      join(dir, "task.codex.md"),
      "---\ndescription: t\n_isolated: false\n---\nSay ok.\n"
    );
    writeHooks(["stop"]);
    const result = await runCli(["task.codex.md", "--_dry-run"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("require isolation");
  });

  it("real runs get a prepared CODEX_HOME (no ambient hooks can ride the bypass)", async () => {
    const flow = writeFlow();
    writeHooks(["stop"]);
    // Dry-run output shows argv, not env; assert via the unit-level contract
    // instead: the codex adapter returns CODEX_HOME pointing at the prepared
    // home for isolated hooked runs.
    const { codexAdapter } = await import("./adapters/codex");
    const translation = codexAdapter.applyHooks!({
      hooksFile: join(dir, "task.codex.hooks.ts"),
      events: ["stop"],
      isolated: true,
    });
    expect(translation.env?.CODEX_HOME).toBeDefined();
    expect(translation.env!.CODEX_HOME).toContain("codex-hooks-home");
    expect(existsSync(join(translation.env!.CODEX_HOME!, "hooks.json"))).toBe(false);
    void flow;
  });
});

describe("re-audit regressions", () => {
  it("a symlink under the flow directory cannot smuggle in an outside hook program", async () => {
    const { symlinkSync } = await import("node:fs");
    mkdirSync(join(dir, "flows"));
    writeFileSync(
      join(dir, "flows", "task.codex.md"),
      "---\ndescription: t\n_hooks: ./inside.hooks.ts\n---\nSay ok.\n"
    );
    writeHooks(["stop"], "outside.hooks.ts");
    symlinkSync(join(dir, "outside.hooks.ts"), join(dir, "flows", "inside.hooks.ts"));
    const result = await runCli(["flows/task.codex.md", "--_dry-run"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("escapes the flow's directory");
  });

  it("md hooks list reports a rejected escaping declaration even when the target is missing", async () => {
    mkdirSync(join(dir, "flows"));
    writeFileSync(
      join(dir, "flows", "task.codex.md"),
      "---\ndescription: t\n_hooks: ../nope.hooks.ts\n---\nSay ok.\n"
    );
    const result = await runCli(["hooks", "list", "flows/task.codex.md"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("escapes the flow's directory");
    expect(result.stdout).not.toContain("No hooks file");
  });

  it("md explain with hooks never writes the prepared codex home", async () => {
    const fakeHome = join(dir, "fake-home");
    mkdirSync(fakeHome);
    const flow = writeFlow();
    writeHooks(["stop"]);
    const proc = Bun.spawn(["bun", "run", CLI, "explain", flow], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: { ...process.env, HOME: fakeHome, MDFLOW_EVAL_RUN: "1", NO_COLOR: "1" },
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("LIFECYCLE HOOKS");
    expect(existsSync(join(fakeHome, ".mdflow", "codex-hooks-home"))).toBe(false);
  });
});
