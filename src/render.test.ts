/**
 * Tests for `md render <flow.md>` — the mdflow rendering system.
 *
 * The contract is FREE (never invokes an engine — proven by a spy engine on
 * PATH), self-contained (no external resources in the HTML), redacted
 * (env-like values never appear), and machine-consumable (the page embeds
 * its own render model as JSON).
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { chmod, mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { spawnMd, createTempDir } from "./test-utils";
import { buildRenderModel, renderFlowHtml, type RenderModel } from "./render";

describe("md render", () => {
  let tempDir: string;
  let cleanup: () => Promise<void>;
  let projectDir: string;
  let homeDir: string;
  let binDir: string;
  let spyLog: string;
  let flowPath: string;
  let hooksFlowPath: string;
  let longBody: string;

  const env = () => ({
    HOME: homeDir,
    MDFLOW_ENGINE: "",
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    SPY_LOG: spyLog,
  });

  const renderJson = async (args: string[]): Promise<RenderModel> => {
    const result = await spawnMd(["render", ...args, "--json"], {
      cwd: projectDir,
      env: env(),
    });
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout);
  };

  beforeAll(async () => {
    ({ tempDir, cleanup } = await createTempDir("render-test-"));
    projectDir = join(tempDir, "project");
    homeDir = join(tempDir, "home");
    binDir = join(tempDir, "bin");
    spyLog = join(tempDir, "engine-was-called.log");

    await mkdir(join(projectDir, "flows"), { recursive: true });
    await mkdir(homeDir, { recursive: true });
    await mkdir(binDir, { recursive: true });

    // Spy engine: any invocation leaves a marker file.
    const spyEnginePath = join(binDir, "spyeng");
    await writeFile(spyEnginePath, `#!/bin/sh\necho invoked >> "$SPY_LOG"\necho done\n`);
    await chmod(spyEnginePath, 0o755);

    // Body longer than explain's 1000-char preview: the render model must
    // carry the FULL prompt. Includes an XSS probe and a template var.
    longBody = `Say {{ _target }}. <script>alert("xss")</script> ${"x".repeat(1500)}`;
    flowPath = join(projectDir, "flows", "task.spyeng.md");
    await writeFile(
      flowPath,
      `---
_inputs:
  _target:
    type: text
    description: What to say
    default: hello
_env:
  API_KEY: super-secret-value
---
${longBody}`
    );

    // Codex flow with a sibling hooks file (codex is the engine with a
    // verified hooks translation), scaffolded through the real user path so
    // static event discovery sees the canonical handlers shape.
    hooksFlowPath = join(projectDir, "flows", "review.codex.md");
    await writeFile(hooksFlowPath, `---\nmodel: gpt-5\n---\nReview things.`);
    const scaffold = await spawnMd(
      ["hooks", "add", hooksFlowPath, "stop", "userPromptSubmit"],
      { cwd: projectDir, env: env() }
    );
    expect(scaffold.exitCode).toBe(0);
  });

  afterAll(async () => {
    await cleanup();
  });

  it("emits the full render model as JSON without invoking the engine", async () => {
    const model = await renderJson([flowPath]);

    expect(model.kind).toBe("mdflow-render");
    expect(model.renderVersion).toBe(1);
    expect(model.protocolVersion).toBe(1);
    expect(model.engine.name).toBe("spyeng");
    expect(model.flow.name).toBe("task.spyeng");
    expect(model.mode.interactive).toBe(false);
    expect(model.command.argv[0]).toBe("spyeng");
    // Full prompt, default input substituted, never truncated.
    expect(model.prompt.text).toContain("Say hello.");
    expect(model.prompt.text.length).toBeGreaterThan(1500);
    expect(model.inputs).toEqual([
      { name: "_target", type: "text", message: "What to say", default: "hello" },
    ]);
    expect(model.body.raw).toContain("{{ _target }}");
    expect(existsSync(spyLog)).toBe(false);
  });

  it("redacts env values everywhere in model and HTML", async () => {
    const model = await renderJson([flowPath]);
    expect(JSON.stringify(model)).not.toContain("super-secret-value");
    expect(model.envKeys).toEqual(["API_KEY"]);
    expect(model.frontmatter.original["_env"]).toEqual({ API_KEY: "****" });

    const html = await spawnMd(["render", flowPath], { cwd: projectDir, env: env() });
    expect(html.exitCode).toBe(0);
    expect(html.stdout).not.toContain("super-secret-value");
  });

  it("redacts secret-like flag values in the rendered argv", async () => {
    const flow = join(projectDir, "flows", "keyed.spyeng.md");
    await writeFile(flow, `---\napi-key: sk-live-LEAKME\n---\nBody.`);
    const model = await renderJson([flow]);
    expect(JSON.stringify(model)).not.toContain("sk-live-LEAKME");
    expect(model.command.argv).toContain("****");
  });

  it("renders self-contained, escaped HTML with an embedded model", async () => {
    const result = await spawnMd(["render", flowPath], { cwd: projectDir, env: env() });
    expect(result.exitCode).toBe(0);
    const html = result.stdout;

    expect(html).toContain("<!doctype html>");
    // Flow content is escaped: the XSS probe never appears as a live tag.
    expect(html).not.toContain(`<script>alert`);
    expect(html).toContain("&lt;script&gt;alert");
    // Self-contained: no external fetches.
    expect(html).not.toMatch(/src="https?:|href="https?:|@import|url\(https?:/);
    // Embedded machine-readable model round-trips.
    const match = html.match(
      /<script type="application\/json" id="mdflow-render-model">(.*?)<\/script>/s
    );
    expect(match).not.toBeNull();
    const embedded = JSON.parse(match![1]!) as RenderModel;
    expect(embedded.kind).toBe("mdflow-render");
    expect(embedded.engine.name).toBe("spyeng");
    expect(embedded.prompt.text).toContain('<script>alert("xss")</script>');
    expect(existsSync(spyLog)).toBe(false);
  });

  it("includes discovered lifecycle hooks and their events", async () => {
    const model = await renderJson([hooksFlowPath]);
    expect(model.engine.name).toBe("codex");
    expect(model.hooks).not.toBeNull();
    expect(model.hooks!.events).toEqual(["stop", "userPromptSubmit"]);
    expect(model.hooks!.error).toBeNull();
    // The codex translation lands in the argv as a -c hooks override.
    expect(model.command.argv.join(" ")).toContain("--dangerously-bypass-hook-trust");

    const html = renderFlowHtml(model);
    expect(html).toContain("userPromptSubmit");
    expect(html).toContain("review.codex.hooks.ts");
  });

  it("surfaces a missing hooks file as an error, not a crash", async () => {
    const flow = join(projectDir, "flows", "missing-hooks.codex.md");
    await writeFile(flow, `---\n_hooks: ./nope.hooks.ts\n---\nBody.`);
    const model = await renderJson([flow]);
    expect(model.hooks).not.toBeNull();
    expect(model.hooks!.error).toContain("Hooks file not found");
    expect(model.warnings.join(" ")).toContain("Hooks file not found");
    const html = renderFlowHtml(model);
    expect(html).toContain("Hooks file not found");
  });

  it("surfaces hooks on an engine without a hook translation as an error", async () => {
    const flow = join(projectDir, "flows", "hooked.spyeng.md");
    await writeFile(flow, `Body.`);
    const scaffold = await spawnMd(["hooks", "add", flow, "stop"], {
      cwd: projectDir,
      env: env(),
    });
    expect(scaffold.exitCode).toBe(0);

    const model = await renderJson([flow]);
    expect(model.hooks).not.toBeNull();
    expect(model.hooks!.events).toEqual(["stop"]);
    expect(model.hooks!.error).toBeTruthy();
  });

  it("writes HTML to --out and prints the path", async () => {
    const outPath = join(tempDir, "out", "task.html");
    await mkdir(join(tempDir, "out"), { recursive: true });
    const result = await spawnMd(["render", flowPath, "--out", outPath], {
      cwd: projectDir,
      env: env(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(outPath);
    expect(existsSync(outPath)).toBe(true);
    const html = await Bun.file(outPath).text();
    expect(html).toContain("mdflow-render-model");
  });

  it("respects the --engine override like a real run", async () => {
    const model = await renderJson([flowPath, "--engine", "codex"]);
    expect(model.engine.name).toBe("codex");
    expect(model.engine.source).toContain("CLI flag");
    expect(model.command.argv[0]).toBe("codex");
  });

  it("fails cleanly with usage when no file is given", async () => {
    const result = await spawnMd(["render"], { cwd: projectDir, env: env() });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Usage: md render");
  });

  it("buildRenderModel is callable in-process (app integration path)", async () => {
    const model = await buildRenderModel(flowPath, [], projectDir);
    expect(model.flow.path).toBe(flowPath);
    expect(model.configFingerprint.startsWith("sha256:")).toBe(true);
  });
});
