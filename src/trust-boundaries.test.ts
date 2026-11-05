/** Black-box checks: each effect is observed at the OS boundary, not by asking
 * the planner what it would do. All downloads use local HTTP servers. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnMd } from "./test-utils";
import { fetchTextResource } from "./fetch";
import { validateUrl } from "./security";

let root: string, project: string, home: string;
const servers: Array<ReturnType<typeof Bun.serve>> = [];
function serve(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}
function file(name: string, content: string) { writeFileSync(join(project, name), content); }
const md = (args: string[], stdin?: string, env?: Record<string, string>) => spawnMd(args, {
  cwd: project, stdin, env: { HOME: home, MDFLOW_EVOLVE: "off", PATH: root + ":" + process.env.PATH, ...env },
});
const ran = (name = "engine-called") => existsSync(join(project, name));
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mdflow-proof-"));
  project = join(root, "project"); home = join(root, "home");
  mkdirSync(project); mkdirSync(home);
  const engine = join(root, "proofengine");
  writeFileSync(engine, '#!/bin/sh\ntouch engine-called\nprintf "%s" "$1"\n'); chmodSync(engine, 0o700);
});
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  rmSync(root, { recursive: true, force: true });
});

describe("the flow declares actions; data cannot add one", () => {
  const payload = "!`touch injected`\n```sh\n#!/bin/sh\ntouch injected\n```\n{{ 5 | plus: 4 }}";
  test("stdin, positional and named inputs reach the real engine literally", async () => {
    file("run.proofengine.md", "{{ _stdin }}\n{{ _1 }}\n{{ _text }}");
    const result = await md(["run.proofengine.md", payload, "--_text", payload], payload);
    expect(result.exitCode, result.stderr).toBe(0); expect(ran()).toBe(true);
    expect(result.stdout).toBe([payload, payload, payload].join("\n")); expect(ran("injected")).toBe(false);
  });
  test("URL and nested file contents cannot introduce shell actions or Liquid", async () => {
    const url = serve(() => new Response(payload, { headers: { "content-type": "text/plain" } }));
    file("context.md", "@./leaf.md"); file("leaf.md", payload);
    file("run.proofengine.md", `@${url}/readme.md\n@./context.md`);
    const result = await md(["run.proofengine.md", "--_quiet"]);
    expect(result.exitCode).toBe(0); expect(result.stdout).toBe(payload + "\n" + payload); expect(ran("injected")).toBe(false);
  });
  test("authored commands render once, respect Liquid scope, and cannot be split by quoted input", async () => {
    const input = "'` !`touch injected` {{ _stdin }}";
    file("run.proofengine.md", "{% for i in (1..2) %}!`printf '%s:%s' {{ i }} {{ _stdin | q }}`\n{% endfor %}{% if false %}!`touch injected`{% endif %}");
    const result = await md(["run.proofengine.md", "--_quiet"], input);
    expect(result.exitCode, result.stderr).toBe(0); expect(result.stdout.trimEnd()).toBe(`1:${input}\n2:${input}`); expect(ran("injected")).toBe(false);
  });
  test("in-project symlinks work; symlinks out of the import root do not disclose bytes", async () => {
    file("inside.md", "inside"); symlinkSync(join(project, "inside.md"), join(project, "link.md"));
    file("read.proofengine.md", "@./link.md");
    expect((await md(["read.proofengine.md", "--_quiet"])).stdout).toBe("inside");
    writeFileSync(join(root, "private"), "OUTSIDE_MARKER"); rmSync(join(project, "link.md"));
    symlinkSync(join(root, "private"), join(project, "link.md"));
    rmSync(join(project, "engine-called"));
    for (const ref of ["@./link.md", "@./link.md:1-1", "@./link.md#Foo"]) {
      file("read.proofengine.md", ref);
      const result = await md(["read.proofengine.md", "--_quiet"]);
      expect(result.exitCode).not.toBe(0); expect(result.stdout + result.stderr).not.toContain("OUTSIDE_MARKER");
    }
    expect(ran()).toBe(false);
  });
});

describe("preview and dispatch agree on consent", () => {
  test("event mode refuses inspection and edit requests before hooks, inline code or engine launch", async () => {
    file("run.proofengine.md", "!`touch inline-ran`");
    for (const flag of ["--_dry-run", "--dry-run", "--_context", "--_edit", "--json"]) {
      const result = await md(["run.proofengine.md", flag, "--events"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.trim().split("\n").map(l => JSON.parse(l).event)).toEqual(["protocol", "run.error"]);
    }
    expect(ran()).toBe(false); expect(ran("inline-ran")).toBe(false);
  });
  test("all dispatch modes enforce the budget against the actual step or prompt", async () => {
    const long = "exceeds the one token budget";
    for (const body of [`---\n_max_prompt_tokens: 1\n---\n${long}`, `---\n_max_prompt_tokens: 1\n_steps:\n  - id: first\n    run: ${long}\n---\n`]) {
      file("budget.proofengine.md", body);
      for (const flags of [[], ["--json"], ["--events"]]) {
        const result = await md(["budget.proofengine.md", ...flags]);
        expect(result.exitCode).not.toBe(0); expect(result.stdout + result.stderr).toContain("_max_prompt_tokens"); expect(ran()).toBe(false);
      }
    }
  });
  test("clearing the nested-run marker in flow _env cannot consent for the caller", async () => {
    file("nested.proofengine.md", '---\n_env:\n  MDFLOW_ACTIVE_FLOW: ""\n---\nhello');
    const result = await md(["nested.proofengine.md"], undefined, { MDFLOW_ACTIVE_FLOW: "1" });
    expect(result.exitCode).not.toBe(0); expect(result.stderr).toContain("NESTED_FLOW"); expect(ran()).toBe(false);
  });
  test("inline and fence deadlines cover process exit and terminate late writers", async () => {
    const script = "exec 1>&- 2>&-; sleep 0.4; touch late-write";
    for (const body of ["!`" + script + "`", "```sh\n#!/bin/sh\n" + script + "\n```"]) {
      file("timeout.proofengine.md", body);
      const result = await md(["timeout.proofengine.md"], undefined, { MDFLOW_COMMAND_TIMEOUT: "60" });
      expect(result.exitCode).not.toBe(0); expect(result.stderr).toContain("timed out");
    }
    await Bun.sleep(500); expect(ran()).toBe(false); expect(ran("late-write")).toBe(false);
  });
  test("a successful child cannot report run.completed after output validation fails", async () => {
    file("validate.proofengine.md", "---\n_output:\n  format: json\n  save: result.json\n---\nnot json");
    const result = await md(["validate.proofengine.md", "--events"]);
    expect(ran()).toBe(true); expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stdout.trim().split("\n").at(-1)!).event).toBe("run.error"); expect(ran("result.json")).toBe(false);
  });
});

describe("network and registry policy", () => {
  test("policy is checked before any redirected request, including flow-supplied _env overrides", async () => {
    let blockedHits = 0;
    const blocked = serve(() => { blockedHits++; return new Response("PRIVATE"); });
    const allowed = serve(() => Response.redirect(blocked + "/secret.md"));
    file("fetch.proofengine.md", `---\n_env:\n  MDFLOW_IMPORT_URL_ALLOWLIST: '*'\n---\n@${allowed}/start.md`);
    expect((await md(["fetch.proofengine.md"], undefined, { MDFLOW_IMPORT_URL_ALLOWLIST: allowed })).exitCode).not.toBe(0);
    expect((await md(["install", allowed + "/start.md", "--project"])).exitCode).not.toBe(0);
    expect(blockedHits).toBe(0); expect(ran()).toBe(false);
    expect(() => validateUrl("https://good.test.evil.test", { allowlist: ["https://good.test"] })).toThrow();
    expect(() => validateUrl("https://good.test/admin", { allowlist: ["https://good.test/Admin"] })).toThrow();
  });
  test("explaining a remote flow fetches only that flow and fingerprints the inspected bytes", async () => {
    let nested = 0, rev = 1;
    const url = serve(req => {
      if (new URL(req.url).pathname === "/context.md") { nested++; return new Response("extra"); }
      return new Response(`---\nengine: echo\n---\nrev ${rev} @${url}/context.md`);
    });
    const explain = async () => {
      const result = await md(["explain", url + "/flow.md", "--json"]);
      expect(result.exitCode).toBe(0); return JSON.parse(result.stdout);
    };
    const first = await explain(); rev++; const second = await explain();
    expect(first.configFingerprint).not.toBe(second.configFingerprint); expect(nested).toBe(0);
  });
  test("a convention hook symlink cannot redirect scaffold writes or auto-attach outside code", async () => {
    file("hooks.codex.md", "review");
    const outside = join(root, "outside.ts"); symlinkSync(outside, join(project, "hooks.codex.hooks.ts"));
    expect((await md(["hooks", "add", "hooks.codex.md", "stop"])).exitCode).not.toBe(0);
    expect(existsSync(outside)).toBe(false);
    writeFileSync(outside, 'throw new Error("UNEXPECTED_HOOK_EXECUTION");');
    for (const args of [["hooks", "list", "hooks.codex.md"], ["hooks.codex.md", "--dry-run"]]) {
      const result = await md(args); expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Convention hooks file"); expect(result.stderr).not.toContain("UNEXPECTED_HOOK_EXECUTION");
    }
  });
  test("download bounds cover unannounced bytes and a body stalled AFTER its headers", async () => {
    const url = serve(req => new Response(new ReadableStream({ start(c) {
      c.enqueue(new Uint8Array([121, 121])); if (req.url.endsWith("/large")) c.close();
    } })));
    await expect(fetchTextResource(url + "/large", { maxBytes: 1 })).rejects.toThrow(/byte limit/);
    await expect(fetchTextResource(url + "/stall", { timeoutMs: 120 })).rejects.toThrow(/timed out/);
  });
  test("concurrent installs preserve both pins; moving a project preserves trust, tampering does not", async () => {
    const url = serve(req => new Response("---\nengine: proofengine\n---\n" + new URL(req.url).pathname));
    const installs = await Promise.all(["a", "b"].map(s => md(["install", `${url}/${s}/job.md`, "--project"])));
    expect(installs.map(i => i.exitCode)).toEqual([0, 0]);
    const moved = join(root, "moved"); renameSync(project, moved); project = moved;
    const entries = Object.values(JSON.parse(readFileSync(join(project, ".mdflow/mdflow.lock.json"), "utf8")).entries) as Array<{ installedPath: string; source: string }>;
    expect(entries).toHaveLength(2);
    for (const e of entries) {
      expect(e.installedPath).not.toContain(root);
      expect((await md([e.installedPath])).stdout).toBe(new URL(e.source).pathname);
      expect((await md([e.installedPath, "--events"])).exitCode).toBe(0); // no compat mutation
    }
    const path = join(project, ".mdflow/registry", entries[0]!.installedPath);
    writeFileSync(path, "---\nengine: proofengine\n---\n!`touch injected`");
    symlinkSync(path, join(project, "alias.md")); rmSync(join(project, "engine-called"));
    for (const flags of [[], ["--events"], ["--_dry-run"]]) {
      const result = await md(["alias.md", ...flags]); expect(result.exitCode).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("SHA-256 mismatch");
    }
    expect(ran()).toBe(false); expect(ran("injected")).toBe(false);
  });
  test("neither a forged removal target nor a symlinked registry directory can modify an outside file", async () => {
    const path = join(root, "keep.md"); writeFileSync(path, "KEEP");
    mkdirSync(join(project, ".mdflow")); file(".mdflow/mdflow.lock.json", JSON.stringify({ entries: {
      "keep.md": { installedPath: path, source: "https://example.test/keep.md", sha256: "0".repeat(64), installedAt: new Date().toISOString() },
    } }));
    expect((await md(["remove", "keep", "--project"])).exitCode).not.toBe(0);
    rmSync(join(project, ".mdflow/mdflow.lock.json")); symlinkSync(root, join(project, ".mdflow/registry"));
    const url = serve(() => new Response("overwrite"));
    expect((await md(["install", url + "/keep.md", "--project"])).exitCode).not.toBe(0);
    expect(readFileSync(path, "utf8")).toBe("KEEP"); expect(ran(".mdflow/mdflow.lock.json")).toBe(false);
  });
});
