import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildGuidePrompt,
  detectInstalledEngines,
  loadCatalog,
  postFlightReport,
  scaffoldStarterFlows,
} from "./init";
import { getRegisteredAdapters } from "./adapters";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mdflow-init-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadCatalog", () => {
  it("returns starter flows with descriptions", () => {
    const catalog = loadCatalog();
    expect(catalog.length).toBeGreaterThanOrEqual(3);
    for (const entry of catalog) {
      expect(entry.name).toEndWith(".md");
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.content).toContain("description:");
    }
    expect(catalog.map((e) => e.name)).toContain("review.md");
  });
});

describe("buildGuidePrompt", () => {
  it("fills every placeholder and embeds the catalog", () => {
    const prompt = buildGuidePrompt("claude", ["claude", "codex"], loadCatalog());
    expect(prompt).not.toContain("__ENGINE__");
    expect(prompt).not.toContain("__ENGINES_DETECTED__");
    expect(prompt).not.toContain("__CATALOG__");
    expect(prompt).not.toContain("__MDFLOW_VERSION__");
    expect(prompt).toContain("claude");
    expect(prompt).toContain("codex");
    expect(prompt).toContain("review.md");
    // The guide must teach dry-run verification and forbid real runs.
    expect(prompt).toContain("--_dry-run");
    expect(prompt).toContain("Never execute a real engine run");
  });

  it("keeps template/import examples verbatim (no expansion)", () => {
    const prompt = buildGuidePrompt("claude", ["claude"], loadCatalog());
    expect(prompt).toContain("{{ _stdin }}");
    expect(prompt).toContain("!`git diff --cached`");
  });
});

describe("scaffoldStarterFlows", () => {
  it("creates flows/, roster README, and .mdflow.yaml", () => {
    const lines = scaffoldStarterFlows(dir, "claude");

    expect(existsSync(join(dir, "flows", "review.md"))).toBe(true);
    expect(existsSync(join(dir, "flows", "README.md"))).toBe(true);
    expect(existsSync(join(dir, ".mdflow.yaml"))).toBe(true);

    const config = readFileSync(join(dir, ".mdflow.yaml"), "utf-8");
    expect(config).toContain("engine: claude");

    const readme = readFileSync(join(dir, "flows", "README.md"), "utf-8");
    expect(readme).toContain("review.md");
    expect(readme).toContain("--_dry-run");

    expect(lines.some((l) => l.includes("created flows/review.md"))).toBe(true);
  });

  it("never overwrites existing files", () => {
    mkdirSync(join(dir, "flows"), { recursive: true });
    writeFileSync(join(dir, "flows", "review.md"), "MINE");
    writeFileSync(join(dir, ".mdflow.yaml"), "engine: codex\n");

    const lines = scaffoldStarterFlows(dir, "claude");

    expect(readFileSync(join(dir, "flows", "review.md"), "utf-8")).toBe("MINE");
    expect(readFileSync(join(dir, ".mdflow.yaml"), "utf-8")).toBe("engine: codex\n");
    expect(lines.some((l) => l.includes("skipped flows/review.md"))).toBe(true);
    expect(lines.some((l) => l.includes("skipped .mdflow.yaml"))).toBe(true);
  });
});

describe("postFlightReport", () => {
  it("reports each flow with its resolved engine", async () => {
    scaffoldStarterFlows(dir, "claude");
    const lines = await postFlightReport(dir);

    const rosterLines = lines.filter((l) => l.trimStart().startsWith("flows/"));
    expect(rosterLines.length).toBeGreaterThanOrEqual(3);
    expect(lines.join("\n")).toContain("flows/review.md");
    expect(lines.join("\n")).toContain("claude (engine via config)");
  });

  it("reports when nothing was created", async () => {
    const lines = await postFlightReport(dir);
    expect(lines.join("\n")).toContain("No flows/ directory");
  });

  it("flags unparseable flows instead of throwing", async () => {
    mkdirSync(join(dir, "flows"), { recursive: true });
    writeFileSync(join(dir, "flows", "broken.md"), "---\n: [ not yaml\n---\nbody");
    const lines = await postFlightReport(dir);
    expect(lines.join("\n")).toContain("broken.md");
  });
});

describe("detectInstalledEngines", () => {
  it("only returns registered adapters", () => {
    const registered = new Set(getRegisteredAdapters());
    for (const engine of detectInstalledEngines()) {
      expect(registered.has(engine)).toBe(true);
    }
  });
});

describe("launchGuidedSession", () => {
  it("passes the guide prompt to the engine as the positional arg", async () => {
    // Stub engine: writes its argv to a file so we can inspect the invocation.
    const binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    const argsFile = join(dir, "args.txt");
    const stub = join(binDir, "mdflow-test-engine");
    writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\n`);
    chmodSync(stub, 0o755);

    // Bun.which snapshots PATH at process startup, so the stub must be on
    // PATH before the mdflow code runs — launch in a subprocess.
    const helper = join(dir, "helper.ts");
    writeFileSync(
      helper,
      `import { launchGuidedSession } from ${JSON.stringify(join(import.meta.dir, "init.ts"))};
const code = await launchGuidedSession("mdflow-test-engine", "GUIDE PROMPT CONTENT");
process.exit(code);`
    );
    const proc = Bun.spawnSync(["bun", "run", helper], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    });

    expect(proc.exitCode).toBe(0);
    const argv = readFileSync(argsFile, "utf-8");
    expect(argv).toContain("GUIDE PROMPT CONTENT");
  });
});
