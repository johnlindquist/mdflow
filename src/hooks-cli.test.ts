import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHooksCli, hooksUsage } from "./hooks-cli";
import { CANONICAL_HOOK_EVENTS, listHandledEvents, renderHooksTemplate } from "./hooks";

let dir: string;
let out: string[];
let err: string[];

const runtime = (over: Record<string, unknown> = {}) => ({
  cwd: dir,
  isTTY: false,
  log: (m: string) => out.push(m),
  error: (m: string) => err.push(m),
  ...over,
});

const flow = () => {
  writeFileSync(join(dir, "task.codex.md"), "---\ndescription: t\n---\nhi\n");
  return "task.codex.md";
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mdflow-hooks-cli-"));
  out = [];
  err = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("md hooks usage/validation", () => {
  it("prints usage and fails on unknown action", async () => {
    expect(await runHooksCli(["frobnicate", "x.md"], runtime())).toBe(1);
    expect(err.join("\n")).toContain("Usage: md hooks");
  });

  it("prints usage on --help and exits 0", async () => {
    expect(await runHooksCli(["--help"], runtime())).toBe(0);
    expect(out.join("\n")).toBe(hooksUsage());
  });

  it("fails when the flow file does not exist", async () => {
    expect(await runHooksCli(["add", "nope.codex.md", "stop"], runtime())).toBe(1);
    expect(err.join("\n")).toContain("Flow file not found");
  });

  it("fails on a non-markdown target", async () => {
    writeFileSync(join(dir, "task.txt"), "x");
    expect(await runHooksCli(["add", "task.txt", "stop"], runtime())).toBe(1);
    expect(err.join("\n")).toContain("Not a markdown flow file");
  });

  it("rejects unknown event names, listing valid ones", async () => {
    const f = flow();
    expect(await runHooksCli(["add", f, "onStop"], runtime())).toBe(1);
    expect(err.join("\n")).toContain('Unknown hook event "onStop"');
    expect(err.join("\n")).toContain("stop");
  });
});

describe("md hooks add", () => {
  it("scaffolds an executable hooks file for the requested events", async () => {
    const f = flow();
    expect(await runHooksCli(["add", f, "stop", "userPromptSubmit"], runtime())).toBe(0);
    const hooksPath = join(dir, "task.codex.hooks.ts");
    expect(existsSync(hooksPath)).toBe(true);
    expect(statSync(hooksPath).mode & 0o111).toBeGreaterThan(0);
    const listed = await listHandledEvents(hooksPath);
    expect(listed).toEqual({ ok: true, events: ["stop", "userPromptSubmit"] });
  });

  it("warns about engines with no hook mechanism", async () => {
    writeFileSync(join(dir, "task.claude.md"), "---\ndescription: t\n---\nhi\n");
    expect(await runHooksCli(["add", "task.claude.md", "stop"], runtime())).toBe(0);
    expect(out.join("\n")).toContain('engine "claude" has no verified hook mechanism');
  });

  it("dedupes events and reports no-op when already handled", async () => {
    const f = flow();
    await runHooksCli(["add", f, "stop"], runtime());
    out = [];
    expect(await runHooksCli(["add", f, "stop", "stop"], runtime())).toBe(0);
    expect(out.join("\n")).toContain("already handles");
  });

  it("extends an existing template file with only the new events", async () => {
    const f = flow();
    await runHooksCli(["add", f, "stop"], runtime());
    expect(await runHooksCli(["add", f, "sessionStart", "stop"], runtime())).toBe(0);
    const listed = await listHandledEvents(join(dir, "task.codex.hooks.ts"));
    if (!listed.ok) throw new Error(listed.error);
    expect(listed.events.sort()).toEqual(["sessionStart", "stop"]);
  });

  it("refuses to extend a file missing the template marker (static, no execution)", async () => {
    const f = flow();
    writeFileSync(
      join(dir, "task.codex.hooks.ts"),
      '#!/usr/bin/env bun\nif (process.argv.includes("--mdflow-list-events")) console.log(JSON.stringify(["stop"]));\n',
      { mode: 0o755 }
    );
    expect(await runHooksCli(["add", f, "sessionStart"], runtime())).toBe(1);
    expect(err.join("\n")).toContain("no statically readable handlers map");
  });

  it("without events and no TTY: fails with the valid-event list", async () => {
    const f = flow();
    expect(await runHooksCli(["add", f], runtime())).toBe(1);
    expect(err.join("\n")).toContain("no events given and no TTY");
  });

  it("without events on a TTY: uses the event picker", async () => {
    const f = flow();
    expect(
      await runHooksCli(
        ["add", f],
        runtime({ isTTY: true, promptEvents: async () => ["preToolUse"] })
      )
    ).toBe(0);
    const listed = await listHandledEvents(join(dir, "task.codex.hooks.ts"));
    expect(listed).toEqual({ ok: true, events: ["preToolUse"] });
  });
});

describe("md hooks list", () => {
  it("reports absence with the expected path and next step", async () => {
    const f = flow();
    expect(await runHooksCli(["list", f], runtime())).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("No hooks file");
    expect(text).toContain("task.codex.hooks.ts");
    expect(text).toContain("md hooks add");
  });

  it("lists events with their codex mapping", async () => {
    const f = flow();
    await runHooksCli(["add", f, "stop", "preToolUse"], runtime());
    out = [];
    expect(await runHooksCli(["list", f], runtime())).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("stop → codex Stop");
    expect(text).toContain("preToolUse → codex PreToolUse");
  });

  it("fails loudly when the hooks file is not statically inspectable", async () => {
    const f = flow();
    writeFileSync(join(dir, "task.codex.hooks.ts"), "#!/usr/bin/env bun\nprocess.exit(3);\n", {
      mode: 0o755,
    });
    expect(await runHooksCli(["list", f], runtime())).toBe(1);
    expect(err.join("\n")).toContain("not statically inspectable");
  });
});

describe("md hooks remove", () => {
  it("removes a single handler and keeps the rest", async () => {
    const f = flow();
    await runHooksCli(["add", f, "stop", "sessionStart"], runtime());
    expect(await runHooksCli(["remove", f, "stop"], runtime())).toBe(0);
    const listed = await listHandledEvents(join(dir, "task.codex.hooks.ts"));
    expect(listed).toEqual({ ok: true, events: ["sessionStart"] });
  });

  it("is a no-op success when no hooks file exists", async () => {
    const f = flow();
    expect(await runHooksCli(["remove", f, "stop"], runtime())).toBe(0);
    expect(out.join("\n")).toContain("nothing to remove");
  });

  it("fails when the named handler is not present", async () => {
    const f = flow();
    await runHooksCli(["add", f, "stop"], runtime());
    expect(await runHooksCli(["remove", f, "preCompact"], runtime())).toBe(1);
    expect(err.join("\n")).toContain("No removable handler");
  });

  it("deleting the whole file requires --yes off-TTY", async () => {
    const f = flow();
    await runHooksCli(["add", f, "stop"], runtime());
    expect(await runHooksCli(["remove", f], runtime())).toBe(1);
    expect(existsSync(join(dir, "task.codex.hooks.ts"))).toBe(true);
    expect(await runHooksCli(["remove", f, "--yes"], runtime())).toBe(0);
    expect(existsSync(join(dir, "task.codex.hooks.ts"))).toBe(false);
  });

  it("on a TTY, a declined confirm cancels deletion", async () => {
    const f = flow();
    await runHooksCli(["add", f, "stop"], runtime());
    expect(
      await runHooksCli(
        ["remove", f],
        runtime({ isTTY: true, promptConfirm: async () => false })
      )
    ).toBe(1);
    expect(existsSync(join(dir, "task.codex.hooks.ts"))).toBe(true);
  });

  it("points at full deletion when the last handler is removed", async () => {
    const f = flow();
    await runHooksCli(["add", f, "stop"], runtime());
    out = [];
    expect(await runHooksCli(["remove", f, "stop"], runtime())).toBe(0);
    expect(out.join("\n")).toContain("No handlers remain");
  });
});

describe("template/event parity", () => {
  it("every canonical event scaffolds, lists, and removes cleanly", async () => {
    const f = flow();
    expect(await runHooksCli(["add", f, ...CANONICAL_HOOK_EVENTS], runtime())).toBe(0);
    const hooksPath = join(dir, "task.codex.hooks.ts");
    const listed = await listHandledEvents(hooksPath);
    if (!listed.ok) throw new Error(listed.error);
    expect(listed.events.length).toBe(CANONICAL_HOOK_EVENTS.length);
    for (const event of CANONICAL_HOOK_EVENTS.slice(0, -1)) {
      expect(await runHooksCli(["remove", f, event], runtime())).toBe(0);
    }
    const rest = await listHandledEvents(hooksPath);
    expect(rest).toEqual({ ok: true, events: [CANONICAL_HOOK_EVENTS.at(-1)!] });
  });

  it("renderHooksTemplate output round-trips through the file the CLI writes", async () => {
    const f = flow();
    await runHooksCli(["add", f, "stop"], runtime());
    expect(readFileSync(join(dir, "task.codex.hooks.ts"), "utf8")).toBe(
      renderHooksTemplate(["stop"])
    );
  });
});
