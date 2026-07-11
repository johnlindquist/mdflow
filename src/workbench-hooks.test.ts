import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentFile } from "./cli";
import {
  clearWorkbenchHooksStatusCache,
  getWorkbenchHooksStatus,
  hydrateWorkbenchHooksStatus,
} from "./workbench-hooks";

let directory = "";

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "mdflow-workbench-hooks-"));
  clearWorkbenchHooksStatusCache();
});

afterEach(() => {
  clearWorkbenchHooksStatusCache();
  rmSync(directory, { recursive: true, force: true });
});

function flow(): AgentFile {
  const path = join(directory, "review.codex.md");
  writeFileSync(path, "# Review\n");
  return { name: "review.codex.md", path, source: "flows" };
}

describe("Workbench hooks hydration", () => {
  test("absent hooks stay synchronous and never invoke the event lister", async () => {
    const file = flow();
    let calls = 0;
    const listEvents = async () => {
      calls += 1;
      return { ok: true as const, events: ["stop" as const] };
    };

    expect(getWorkbenchHooksStatus(file)).toEqual({ state: "none" });
    expect(await hydrateWorkbenchHooksStatus(file, { listEvents })).toEqual({ state: "none" });
    expect(calls).toBe(0);
  });

  test("caches successful event lists by hooks path and mtime", async () => {
    const file = flow();
    const hooksPath = join(directory, "review.codex.hooks.ts");
    writeFileSync(hooksPath, "// test hook\n");
    let calls = 0;
    const listEvents = async () => {
      calls += 1;
      return { ok: true as const, events: ["sessionStart" as const, "stop" as const] };
    };

    expect(getWorkbenchHooksStatus(file)).toMatchObject({ state: "loading", path: hooksPath });
    expect(await hydrateWorkbenchHooksStatus(file, { listEvents })).toMatchObject({
      state: "ready",
      events: ["sessionStart", "stop"],
    });
    expect(await hydrateWorkbenchHooksStatus(file, { listEvents })).toMatchObject({ state: "ready" });
    expect(calls).toBe(1);

    const future = new Date(Date.now() + 2_000);
    utimesSync(hooksPath, future, future);
    expect(getWorkbenchHooksStatus(file)).toMatchObject({ state: "loading", path: hooksPath });
    await hydrateWorkbenchHooksStatus(file, { listEvents });
    expect(calls).toBe(2);
  });

  test("caches an unreadable event-list result without hiding the hooks file", async () => {
    const file = flow();
    const hooksPath = join(directory, "review.codex.hooks.ts");
    writeFileSync(hooksPath, "// broken hook\n");
    let calls = 0;
    const listEvents = async () => {
      calls += 1;
      return { ok: false as const, error: "event contract failed" };
    };

    expect(await hydrateWorkbenchHooksStatus(file, { listEvents })).toMatchObject({
      state: "error",
      path: hooksPath,
      error: "event contract failed",
    });
    expect(await hydrateWorkbenchHooksStatus(file, { listEvents })).toMatchObject({ state: "error" });
    expect(calls).toBe(1);
  });
});
