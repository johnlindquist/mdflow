/**
 * Hooks tests use only executable fixtures in per-test temp directories.
 * Generated hooks are exercised as real standalone Bun programs so imports,
 * shebang execution, stdin handling, and stdout decision protocols cannot be
 * accidentally satisfied by in-process mocks.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  CANONICAL_HOOK_EVENTS,
  CLAUDE_HOOK_EVENT_NAMES,
  CODEX_HOOK_EVENT_NAMES,
  buildCodexHooksConfig,
  formatHooksStderrLine,
  hooksFileForFlow,
  listHandledEvents,
  listHandledEventsStatic,
  renderHooksTemplate,
  resolveHooksFile,
  buildCodexHooksOverride,
  applyHooksToFrontmatter,
} from "./hooks";
import { codexAdapter } from "./adapters/codex";
import { claudeAdapter } from "./adapters/claude";
import type { AgentFrontmatter } from "./types";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mdflow-hooks-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeExecutable(name: string, source: string): string {
  const path = join(tempDir, name);
  writeFileSync(path, source);
  chmodSync(path, 0o755);
  return path;
}

function errorFrom(
  result: Awaited<ReturnType<typeof listHandledEvents>>
): string {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected hook event discovery to fail");
  return result.error;
}

async function runExecutable(
  path: string,
  opts: { args?: string[]; stdin?: string } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([path, ...(opts.args ?? [])], {
    stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function hookPayload(hookEventName: string): string {
  return JSON.stringify({
    session_id: "session-1",
    transcript_path: join(tempDir, "transcript.jsonl"),
    cwd: tempDir,
    hook_event_name: hookEventName,
    model: "gpt-test",
    turn_id: "turn-1",
  });
}

describe("canonical hook events", () => {
  it("exports the canonical order and Codex event mapping", () => {
    expect(CANONICAL_HOOK_EVENTS).toEqual([
      "sessionStart",
      "userPromptSubmit",
      "preToolUse",
      "postToolUse",
      "permissionRequest",
      "preCompact",
      "postCompact",
      "subagentStart",
      "subagentStop",
      "stop",
      "sessionEnd",
    ]);
    expect(CODEX_HOOK_EVENT_NAMES).toEqual({
      sessionStart: "SessionStart",
      userPromptSubmit: "UserPromptSubmit",
      preToolUse: "PreToolUse",
      postToolUse: "PostToolUse",
      permissionRequest: "PermissionRequest",
      preCompact: "PreCompact",
      postCompact: "PostCompact",
      subagentStart: "SubagentStart",
      subagentStop: "SubagentStop",
      stop: "Stop",
      sessionEnd: "SessionEnd",
    });
  });
});

describe("hooksFileForFlow", () => {
  it("preserves paths, spaces, and markers while replacing a final .md", () => {
    expect(hooksFileForFlow("review.codex.md")).toBe("review.codex.hooks.ts");
    expect(hooksFileForFlow("flows/review.i.codex.md")).toBe(
      "flows/review.i.codex.hooks.ts"
    );
    expect(hooksFileForFlow("../flows/my review.codex.MD")).toBe(
      "../flows/my review.codex.hooks.ts"
    );
    expect(hooksFileForFlow("/tmp/flow space/review.codex.md")).toBe(
      "/tmp/flow space/review.codex.hooks.ts"
    );
    expect(hooksFileForFlow("review.codex")).toBe("review.codex.hooks.ts");
  });
});

describe("resolveHooksFile", () => {
  it("lets CLI false disable hooks ahead of every other source", () => {
    const flowPath = join(tempDir, "review.codex.md");
    writeFileSync(hooksFileForFlow(flowPath), "");

    expect(
      resolveHooksFile({
        flowPath,
        frontmatterValue: "frontmatter.hooks.ts",
        cliValue: "false",
      })
    ).toEqual({ kind: "disabled" });
  });

  it("resolves a CLI path against cwd and flags it when missing", () => {
    const cliValue = join("missing-hook-fixtures", basename(tempDir), "cli hooks.ts");
    expect(
      resolveHooksFile({
        flowPath: join(tempDir, "review.codex.md"),
        frontmatterValue: false,
        cliValue,
      })
    ).toEqual({
      kind: "file",
      path: resolve(cliValue),
      source: "cli",
      missing: true,
    });
  });

  it("lets frontmatter false disable convention discovery", () => {
    const flowPath = join(tempDir, "review.codex.md");
    writeFileSync(hooksFileForFlow(flowPath), "");

    expect(resolveHooksFile({ flowPath, frontmatterValue: false })).toEqual({
      kind: "disabled",
    });
  });

  it("resolves a frontmatter path against the flow directory", () => {
    const flowPath = join(tempDir, "flows", "review.codex.md");
    const hooksPath = join(dirname(flowPath), "support", "custom hooks.ts");
    mkdirSync(dirname(hooksPath), { recursive: true });

    expect(
      resolveHooksFile({ flowPath, frontmatterValue: "support/custom hooks.ts" })
    ).toEqual({
      kind: "file",
      path: hooksPath,
      source: "frontmatter",
      missing: true,
    });

    writeFileSync(hooksPath, "");
    expect(
      resolveHooksFile({ flowPath, frontmatterValue: "support/custom hooks.ts" })
    ).toEqual({
      kind: "file",
      path: hooksPath,
      source: "frontmatter",
      missing: false,
    });
  });

  it("discovers an existing convention file", () => {
    const flowPath = join(tempDir, "review.i.codex.md");
    const hooksPath = hooksFileForFlow(flowPath);
    writeFileSync(hooksPath, "");

    expect(resolveHooksFile({ flowPath })).toEqual({
      kind: "file",
      path: hooksPath,
      source: "convention",
      missing: false,
    });
  });

  it("returns none when optional convention discovery misses", () => {
    expect(resolveHooksFile({ flowPath: join(tempDir, "review.codex.md") })).toEqual({
      kind: "none",
    });
  });

  it("keeps a forced convention result when its file is missing", () => {
    const flowPath = join(tempDir, "review.codex.md");
    const expected = {
      kind: "file",
      path: hooksFileForFlow(flowPath),
      source: "convention",
      missing: true,
    } as const;

    expect(resolveHooksFile({ flowPath, frontmatterValue: true })).toEqual(expected);
    expect(resolveHooksFile({ flowPath, frontmatterValue: { enabled: true } })).toEqual(
      expected
    );
  });
});

describe("listHandledEvents", () => {
  it("reads events from a real generated hook program", async () => {
    const hooksPath = writeExecutable(
      "review.codex.hooks.ts",
      renderHooksTemplate(["sessionStart", "preToolUse", "stop"])
    );
    const result = await listHandledEvents(hooksPath);

    expect(result).toEqual({
      ok: true,
      events: ["sessionStart", "preToolUse", "stop"],
    });
  });

  it("rejects an unknown event and lists every valid event", async () => {
    const hooksPath = writeExecutable(
      "unknown.hooks.ts",
      '#!/usr/bin/env bun\nprocess.stdout.write(JSON.stringify(["sessionStart", "sideQuest"]));\n'
    );
    const error = errorFrom(await listHandledEvents(hooksPath));

    expect(error).toContain('"sideQuest"');
    expect(error).toContain(CANONICAL_HOOK_EVENTS.join(", "));
  });

  it("rejects an empty event list", async () => {
    const hooksPath = writeExecutable(
      "empty.hooks.ts",
      "#!/usr/bin/env bun\nprocess.stdout.write(JSON.stringify([]));\n"
    );
    const error = errorFrom(await listHandledEvents(hooksPath));

    expect(error.toLowerCase()).toContain("hooks file handles no events");
  });

  it("rejects non-JSON stdout with contract guidance", async () => {
    const hooksPath = writeExecutable(
      "not-json.hooks.ts",
      '#!/usr/bin/env bun\nprocess.stdout.write("not json");\n'
    );
    const error = errorFrom(await listHandledEvents(hooksPath));

    expect(error).toContain("JSON array");
    expect(error).toContain("md hooks add");
    expect(error).toContain("--mdflow-list-events");
  });

  it("reports a non-zero exit with stderr and contract guidance", async () => {
    const hooksPath = writeExecutable(
      "failure.hooks.ts",
      '#!/usr/bin/env bun\nconsole.error("fixture failed");\nprocess.exitCode = 1;\n'
    );
    const error = errorFrom(await listHandledEvents(hooksPath));

    expect(error).toContain("exited with code 1");
    expect(error).toContain("fixture failed");
    expect(error).toContain("md hooks add");
  });

  it("kills and reports a hook event query that times out", async () => {
    const hooksPath = writeExecutable(
      "slow.hooks.ts",
      '#!/usr/bin/env bun\nawait Bun.sleep(10_000);\nprocess.stdout.write("[]");\n'
    );
    const error = errorFrom(
      await listHandledEvents(hooksPath, { timeoutMs: 50 })
    );

    expect(error).toContain("timed out after 50ms");
    expect(error).toContain("--mdflow-list-events");
  });

  it("reports a hooks file that does not exist", async () => {
    const hooksPath = join(tempDir, "missing.hooks.ts");
    const error = errorFrom(await listHandledEvents(hooksPath));

    expect(error).toContain(hooksPath);
    expect(error).toContain("exited with code 1");
    expect(error).toContain("md hooks add");
  });
});

describe("buildCodexHooksConfig", () => {
  it("builds the exact Codex JSON shape for two events", () => {
    expect(
      buildCodexHooksConfig({
        hooksFile: "/tmp/review codex.hooks.ts",
        events: ["sessionStart", "stop"],
        runtime: "/opt/bun",
      })
    ).toEqual({
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: "'/opt/bun' '/tmp/review codex.hooks.ts'",
                timeout: 60,
                statusMessage: "mdflow hook: sessionStart",
              },
            ],
          },
        ],
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: "'/opt/bun' '/tmp/review codex.hooks.ts'",
                timeout: 60,
                statusMessage: "mdflow hook: stop",
              },
            ],
          },
        ],
      },
    });
  });

  it("single-quotes spaces and embedded quotes in both command arguments", () => {
    const runtime = "/opt/Bun Runner's/bin/bun";
    const hooksPath = join(tempDir, "flow dir's", "review codex.hooks.ts");
    const config = buildCodexHooksConfig({
      hooksFile: hooksPath,
      events: ["preToolUse"],
      runtime,
      timeoutSeconds: 7,
    });
    const expectedRuntime = "'/opt/Bun Runner'\\''s/bin/bun'";
    const expectedPath =
      "'" + resolve(hooksPath).replaceAll("'", "'\\''") + "'";

    expect(config.hooks.PreToolUse?.[0]?.hooks[0]).toEqual({
      type: "command",
      command: `${expectedRuntime} ${expectedPath}`,
      timeout: 7,
      statusMessage: "mdflow hook: preToolUse",
    });
  });
});

describe("renderHooksTemplate", () => {
  it("renders an import-free executable scaffold with only requested handlers", () => {
    const template = renderHooksTemplate(["stop", "sessionStart", "stop"]);

    expect(template.split("\n")[0]).toBe("#!/usr/bin/env bun");
    expect(template).not.toMatch(/^import\s/m);
    expect(template).toContain(
      "type HookPayload = { session_id: string; transcript_path: string; cwd: string; hook_event_name: string; model?: string; turn_id?: string; [key: string]: unknown };"
    );
    expect(template).toContain(
      "type HookResult = void | string | Record<string, unknown>;"
    );
    // Handlers render as `<event>: async (...)`; the fail-closed guard map
    // that always follows uses `<event>: (reason) =>`, so match on `async`
    // to test the handler set specifically.
    expect(template.match(/^  stop: async/gm)).toHaveLength(1);
    expect(template).toContain("  sessionStart: async");
    expect(template).not.toMatch(/^  preToolUse: async/m);
    expect(template).toContain('{ decision: "block", reason: "…" }');
  });

  it("fails closed for guard events whose handler throws, open otherwise", async () => {
    const template = renderHooksTemplate([
      "userPromptSubmit",
      "preToolUse",
      "postToolUse",
    ]);
    const boom = 'const x = null; (x as any).nope();';
    const source = template
      .replace(
        'userPromptSubmit: async (_payload: HookPayload): Promise<HookResult> => {',
        `userPromptSubmit: async (_payload: HookPayload): Promise<HookResult> => { ${boom}`
      )
      .replace(
        'preToolUse: async (_payload: HookPayload): Promise<HookResult> => {',
        `preToolUse: async (_payload: HookPayload): Promise<HookResult> => { ${boom}`
      )
      .replace(
        'postToolUse: async (_payload: HookPayload): Promise<HookResult> => {',
        `postToolUse: async (_payload: HookPayload): Promise<HookResult> => { ${boom}`
      );
    const hooksPath = writeExecutable("throwing.hooks.ts", source);

    const ups = await runExecutable(hooksPath, { stdin: hookPayload("user_prompt_submit") });
    expect(ups.exitCode).toBe(0);
    expect(JSON.parse(ups.stdout)).toMatchObject({ decision: "block" });

    const pre = await runExecutable(hooksPath, { stdin: hookPayload("pre_tool_use") });
    expect(pre.exitCode).toBe(0);
    expect(JSON.parse(pre.stdout).hookSpecificOutput.permissionDecision).toBe("deny");

    // Observational event: a throw fails open (empty stdout, no block).
    const post = await runExecutable(hooksPath, { stdin: hookPayload("post_tool_use") });
    expect(post.exitCode).toBe(0);
    expect(post.stdout).toBe("");
  });

  it("runs listing, string, object, void, unknown, and malformed-input protocols", async () => {
    const template = renderHooksTemplate([
      "userPromptSubmit",
      "subagentStop",
      "sessionEnd",
    ]);
    const source = template.replace(
      "async function main(): Promise<void> {",
      `handlers.userPromptSubmit = () => "injected context";
handlers.subagentStop = () => ({ decision: "block", reason: "continue" });

async function main(): Promise<void> {`
    );
    const hooksPath = writeExecutable("protocol.hooks.ts", source);

    const listing = await runExecutable(hooksPath, {
      args: ["--mdflow-list-events"],
    });
    expect(listing).toEqual({
      stdout: JSON.stringify(["userPromptSubmit", "subagentStop", "sessionEnd"]),
      stderr: "",
      exitCode: 0,
    });

    const stringResult = await runExecutable(hooksPath, {
      stdin: hookPayload("user_prompt_submit"),
    });
    expect(stringResult).toEqual({
      stdout: "injected context",
      stderr: "",
      exitCode: 0,
    });

    const objectResult = await runExecutable(hooksPath, {
      stdin: hookPayload("SubagentStop"),
    });
    expect(objectResult).toEqual({
      stdout: JSON.stringify({ decision: "block", reason: "continue" }),
      stderr: "",
      exitCode: 0,
    });

    const voidResult = await runExecutable(hooksPath, {
      stdin: hookPayload("SessionEnd"),
    });
    expect(voidResult).toEqual({ stdout: "", stderr: "", exitCode: 0 });

    const unknownResult = await runExecutable(hooksPath, {
      stdin: hookPayload("PostToolUse"),
    });
    expect(unknownResult).toEqual({ stdout: "", stderr: "", exitCode: 0 });

    const malformedResult = await runExecutable(hooksPath, { stdin: "{" });
    expect(malformedResult).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  });
});

describe("formatHooksStderrLine", () => {
  it("formats a basename and ordered event list without terminal codes", () => {
    expect(
      formatHooksStderrLine("/tmp/flow space/review.codex.hooks.ts", [
        "sessionStart",
        "stop",
      ])
    ).toBe("hooks: review.codex.hooks.ts (sessionStart, stop)");
  });
});

describe("buildCodexHooksOverride", () => {
  it("serializes one inline TOML override with mandatory nesting and PascalCase keys", () => {
    const config = buildCodexHooksConfig({
      hooksFile: "/tmp/flow/review.codex.hooks.ts",
      events: ["sessionStart", "stop"],
      runtime: "/usr/local/bin/bun",
      timeoutSeconds: 45,
    });
    expect(buildCodexHooksOverride(config)).toBe(
      'hooks={SessionStart=[{hooks=[{type="command",' +
        "command=\"'/usr/local/bin/bun' '/tmp/flow/review.codex.hooks.ts'\"," +
        'timeout=45,statusMessage="mdflow hook: sessionStart"}]}],' +
        'Stop=[{hooks=[{type="command",' +
        "command=\"'/usr/local/bin/bun' '/tmp/flow/review.codex.hooks.ts'\"," +
        'timeout=45,statusMessage="mdflow hook: stop"}]}]}'
    );
  });

  it("escapes TOML-hostile characters in the shell command", () => {
    const config = buildCodexHooksConfig({
      hooksFile: '/tmp/we"ird\\dir/x.hooks.ts',
      events: ["stop"],
      runtime: "/bin/bun",
    });
    const override = buildCodexHooksOverride(config);
    expect(override).toContain('\\"');
    expect(override).toContain("\\\\");
  });
});

describe("applyHooksToFrontmatter", () => {
  const spec = { hooksFile: "/tmp/f/review.codex.hooks.ts", events: ["stop"], isolated: true };

  it("fails loudly for engines without a hook translation", () => {
    const adapter = { name: "droid", getDefaults: () => ({}), applyInteractiveMode: (f: AgentFrontmatter) => f };
    expect(() => applyHooksToFrontmatter(adapter, "droid", {}, spec)).toThrow(
      /no verified lifecycle-hook mechanism/
    );
  });

  it("merges the codex translation: config concats, bypass flag set, _hooks consumed", () => {
    const frontmatter: AgentFrontmatter = {
      _hooks: true,
      config: ["project_doc_max_bytes=0"],
    };
    const { frontmatter: result } = applyHooksToFrontmatter(codexAdapter, "codex", frontmatter, spec);
    expect(result._hooks).toBeUndefined();
    expect(result["dangerously-bypass-hook-trust"]).toBe(true);
    const configs = result.config as string[];
    expect(configs[0]).toBe("project_doc_max_bytes=0");
    expect(configs[1]).toStartWith("hooks={Stop=[{hooks=[{type=");
  });

  it("claude translation: injects inline --settings, excludes ambient sources, drops safe-mode, discloses", () => {
    const { frontmatter: result, warnings } = applyHooksToFrontmatter(
      claudeAdapter,
      "claude",
      { _hooks: true, "safe-mode": true, "no-session-persistence": true },
      { hooksFile: "/tmp/f/review.claude.hooks.ts", events: ["userPromptSubmit", "stop"], isolated: true }
    );
    expect(result._hooks).toBeUndefined();
    expect(result["safe-mode"]).toBe(false);
    expect(result["setting-sources"]).toBe("");
    const settings = JSON.parse(result.settings as string);
    expect(Object.keys(settings.hooks)).toEqual(["UserPromptSubmit", "Stop"]);
    expect(settings.hooks.UserPromptSubmit[0].matcher).toBe("");
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].type).toBe("command");
    expect(warnings.join("\n")).toContain("HOOKS_ISOLATION_REDUCED");
  });

  it("claude hooks require isolation", () => {
    expect(() =>
      applyHooksToFrontmatter(claudeAdapter, "claude", {}, {
        hooksFile: "/tmp/f/x.claude.hooks.ts",
        events: ["stop"],
        isolated: false,
      })
    ).toThrow(/require isolation/);
  });

  it("claude hard-fails when the flow already sets native settings:", () => {
    expect(() =>
      applyHooksToFrontmatter(claudeAdapter, "claude", { settings: "./mine.json" }, {
        hooksFile: "/tmp/f/x.claude.hooks.ts",
        events: ["stop"],
        isolated: true,
      })
    ).toThrow(/own the `settings` setting/);
  });
});

describe("engine event-registry parity", () => {
  /**
   * One hook set must mean the same thing on every engine. Both registries
   * are derived here (PascalCase of the canonical name) rather than copied,
   * so an event added to CANONICAL_HOOK_EVENTS without both translations —
   * or a translation that quietly diverges between engines — fails.
   */
  it("codex and claude registries cover the canonical set with identical PascalCase names", () => {
    const pascal = (event: string) => event.charAt(0).toUpperCase() + event.slice(1);
    expect(Object.keys(CODEX_HOOK_EVENT_NAMES).sort()).toEqual([...CANONICAL_HOOK_EVENTS].sort());
    expect(Object.keys(CLAUDE_HOOK_EVENT_NAMES).sort()).toEqual([...CANONICAL_HOOK_EVENTS].sort());
    for (const event of CANONICAL_HOOK_EVENTS) {
      expect(CODEX_HOOK_EVENT_NAMES[event]).toBe(pascal(event));
      expect(CLAUDE_HOOK_EVENT_NAMES[event]).toBe(CODEX_HOOK_EVENT_NAMES[event]);
    }
  });
});

describe("remote flows and _hooks consent", () => {
  /**
   * Paired A/B on one bit: the identical, fully-contained declaration is
   * accepted for a local flow and rejected for a remote one, so the rejection
   * is provably the remote policy and not a containment side effect. The
   * local arm doubles as the non-strawman check.
   */
  it("rejects a remote flow's _hooks path that a local flow would be allowed", () => {
    const flowPath = join(tempDir, "review.codex.md");
    writeFileSync(flowPath, "---\n_hooks: ./guard.hooks.ts\n---\nBody.\n");
    writeFileSync(join(tempDir, "guard.hooks.ts"), renderHooksTemplate(["stop"]), { mode: 0o755 });

    const local = resolveHooksFile({ flowPath, frontmatterValue: "./guard.hooks.ts" });
    const remote = resolveHooksFile({
      flowPath,
      frontmatterValue: "./guard.hooks.ts",
      isRemote: true,
    });

    if (local.kind !== "file") throw new Error("expected a file result for the local arm");
    expect(local.rejected).toBeUndefined();
    if (remote.kind !== "file") throw new Error("expected a file result for the remote arm");
    expect(remote.rejected).toContain("remote flows cannot declare a _hooks path");
  });
});

describe("unreadable hooks files fail loudly", () => {
  it("static discovery reports a read failure instead of silently dropping declared behavior", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root ignores modes
    const hooksFile = join(tempDir, "review.codex.hooks.ts");
    writeFileSync(hooksFile, renderHooksTemplate(["stop"]), { mode: 0o755 });
    chmodSync(hooksFile, 0o000);
    try {
      const result = listHandledEventsStatic(hooksFile);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected a failure result");
      expect(result.error).toContain("Could not read hooks file");
    } finally {
      chmodSync(hooksFile, 0o755);
    }
  });
});
