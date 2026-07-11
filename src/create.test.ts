import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeCreateScope,
  formatCreateScope,
  parseCreateArgs,
  runCreate,
  type GlobalFlowAvailability,
} from "./create";
import { parseRawFrontmatter } from "./parse";
import { spawnMd } from "./test-utils";

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "mdflow-create-"));
  mkdirSync(join(directory, ".git"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("parseCreateArgs", () => {
  it("joins plain-language intent and preserves useful legacy flags", () => {
    expect(
      parseCreateArgs([
        "Review",
        "staged",
        "changes",
        "--_command",
        "claude",
        "--model=sonnet",
        "--temperature",
        "0.2",
        "--open",
      ])
    ).toMatchObject({
      intent: "Review staged changes",
      engine: "claude",
      model: "sonnet",
      location: "project",
      open: true,
      dryRun: false,
      frontmatter: { temperature: 0.2 },
    });
  });

  it("collects repeatable docs entries and effort", () => {
    expect(
      parseCreateArgs(["Summarize gog", "--docs", "gog --help", "--docs=https://example.com/api.md", "--effort", "high"])
    ).toMatchObject({
      intent: "Summarize gog",
      docs: ["gog --help", "https://example.com/api.md"],
      effort: "high",
    });
  });

  it("recognizes a v2 filename without mistaking it for prompt text", () => {
    expect(parseCreateArgs(["review.i.codex.md", "-g"])).toMatchObject({
      name: "review.i.codex.md",
      location: "user",
    });
  });

  it("rejects missing values and unknown locations", () => {
    expect(() => parseCreateArgs(["hello", "--engine"])).toThrow("--engine requires a value");
    expect(() => parseCreateArgs(["hello", "--location", "somewhere"])).toThrow(
      "Unknown create location"
    );
  });
});

describe("create scope labels", () => {
  it("states every destination and availability contract unambiguously", () => {
    const home = join(directory, "home");
    const cases = [
      describeCreateScope({
        location: "project",
        flowPath: join(directory, "flows", "review.md"),
        slug: "review",
        cwd: directory,
        projectRoot: directory,
        homeDirectory: home,
      }),
      describeCreateScope({
        location: "cwd",
        flowPath: join(directory, "review.md"),
        slug: "review",
        cwd: directory,
        homeDirectory: home,
      }),
      describeCreateScope({
        location: "user",
        flowPath: join(home, ".mdflow", "review.md"),
        slug: "review",
        cwd: directory,
        homeDirectory: home,
      }),
      describeCreateScope({
        location: "custom",
        flowPath: join(directory, "shared", "review.md"),
        slug: "review",
        cwd: directory,
        homeDirectory: home,
      }),
    ];

    expect(formatCreateScope(cases[0]!)).toBe(
      "Creating in THIS PROJECT → ./flows/review.md (available throughout this project as md review)",
    );
    expect(formatCreateScope(cases[1]!)).toBe(
      "Creating in CURRENT DIRECTORY → ./review.md (available here; elsewhere invoke it by path)",
    );
    expect(formatCreateScope(cases[2]!)).toBe(
      "Creating GLOBALLY → ~/.mdflow/review.md (available from any directory as md review)",
    );
    expect(formatCreateScope(cases[3]!)).toBe(
      "Creating in CUSTOM DIRECTORY → ./shared/review.md (invoke it by path unless this directory is on PATH)",
    );
  });
});

describe("runCreate", () => {
  it("creates a canonical project flow, roster, and config from intent", async () => {
    const messages: string[] = [];
    let opened = false;
    const result = await runCreate(["Review", "staged", "changes", "for", "correctness"], {
      cwd: directory,
      log: (message) => messages.push(message),
      openFile: () => {
        opened = true;
        return true;
      },
    });

    const flowPath = join(directory, "flows", "review-staged-changes.md");
    expect(result.status).toBe("created");
    if (result.status !== "created") throw new Error("expected created result");
    expect(result.flowPath).toBe(flowPath);
    expect(existsSync(flowPath)).toBe(true);
    expect(existsSync(join(directory, "flows", "README.md"))).toBe(true);
    // No --engine choice was made, so no project-wide engine default may be
    // stamped as a hidden side effect.
    expect(existsSync(join(directory, ".mdflow.yaml"))).toBe(false);
    expect(parseRawFrontmatter(readFileSync(flowPath, "utf8"))).toMatchObject({
      frontmatter: {
        description: "Review staged changes for correctness",
      },
      body: "Review staged changes for correctness",
    });
    expect(messages.join("\n")).toContain("Created flow:");
    expect(messages.join("\n")).toContain(
      "Creating in THIS PROJECT → ./flows/review-staged-changes.md",
    );
    expect(messages.join("\n")).toContain(
      "Created in THIS PROJECT → ./flows/review-staged-changes.md",
    );
    expect(messages.join("\n")).toContain("Run it directly: md review-staged-changes");
    expect(messages.join("\n")).toContain("Open the Flow Workbench: md");
    expect(opened).toBe(false);
  });

  it("uses exactly one intent prompt when invoked bare", async () => {
    let promptCount = 0;
    const result = await runCreate([], {
      cwd: directory,
      log: () => {},
      promptIntent: async () => {
        promptCount++;
        return "Summarize this repository for a new contributor";
      },
    });

    expect(promptCount).toBe(1);
    expect(result.status).toBe("created");
    expect(existsSync(join(directory, "flows", "summarize-repository-contributor.md"))).toBe(
      true
    );
  });

  it("warns when unknown flags are retained as frontmatter", async () => {
    const warnings: string[] = [];
    const result = await runCreate(["Test flow", "--dry-run", "--scope", "global"], {
      cwd: directory,
      log: () => {},
      warn: (message) => warnings.push(message),
    });
    expect(result.status).toBe("preview");
    expect(warnings.join("\n")).toContain("--scope");
    expect(warnings.join("\n")).toContain("retained as flow frontmatter");
  });

  it("refuses to prompt for intent when stdin is not a TTY", async () => {
    await expect(
      runCreate([], { cwd: directory, log: () => {}, isStdinTTY: false })
    ).rejects.toThrow(/INTENT_REQUIRED/);
  });

  it("previews the exact draft and target without writing", async () => {
    const messages: string[] = [];
    const result = await runCreate(["Draft release notes", "--engine", "codex", "--dry-run"], {
      cwd: directory,
      log: (message) => messages.push(message),
    });

    expect(result.status).toBe("preview");
    expect(existsSync(join(directory, "flows"))).toBe(false);
    expect(existsSync(join(directory, ".mdflow.yaml"))).toBe(false);
    const output = messages.join("\n");
    expect(output).toContain("Flow preview");
    expect(output).toContain("Would create in THIS PROJECT → ./flows/draft-release-notes.md");
    expect(output).toContain("Effect: FREE — no files written");
    expect(output).toContain("engine: codex");
    expect(output).toContain(join(directory, "flows", "draft-release-notes.md"));
  });

  it("creates a genuinely global flow and runs the availability check", async () => {
    const messages: string[] = [];
    const receipts: GlobalFlowAvailability[] = [];
    const home = join(directory, "home");
    const result = await runCreate(["Review globally", "--global"], {
      cwd: directory,
      homeDirectory: home,
      log: (message) => messages.push(message),
      ensureGlobalAvailability: (receipt) => {
        expect(existsSync(receipt.flowPath)).toBe(true);
        receipts.push(receipt);
      },
    });

    expect(result.status).toBe("created");
    if (result.status !== "created") throw new Error("expected created result");
    expect(result.flowPath).toBe(join(home, ".mdflow", "review-globally.md"));
    expect(receipts).toEqual([
      { flowPath: result.flowPath, invocation: "md review-globally", slug: "review-globally", userAgentsDir: join(home, ".mdflow") },
    ]);
    const output = messages.join("\n");
    expect(output).toContain(
      "Creating GLOBALLY → ~/.mdflow/review-globally.md (available from any directory as md review-globally)",
    );
    expect(output).toContain(
      "Created GLOBALLY → ~/.mdflow/review-globally.md (available from any directory as md review-globally)",
    );
    expect(output).toContain("Run from any directory: md review-globally");
    expect(output).toContain(
      "Exact global path (bypasses a same-named project flow): md ~/.mdflow/review-globally.md",
    );
  });

  it("resolves a global flow by name from an unrelated directory", async () => {
    const home = join(directory, "spawn-home");
    const elsewhere = join(directory, "unrelated", "working-directory");
    mkdirSync(elsewhere, { recursive: true });
    const env = { HOME: home };

    const created = await spawnMd(
      ["create", "Global availability probe", "--global", "--engine", "echo"],
      { cwd: directory, env },
    );
    expect(created.exitCode).toBe(0);
    expect(created.stdout).toContain("Run from any directory: md global-availability-probe");
    expect(existsSync(join(home, ".mdflow", "global-availability-probe.md"))).toBe(true);

    const invoked = await spawnMd(
      ["global-availability-probe", "--_dry-run"],
      { cwd: elsewhere, env },
    );
    expect(invoked.exitCode).toBe(0);
    expect(`${invoked.stdout}\n${invoked.stderr}`).toContain("DRY RUN");
  });

  it("never overwrites an existing flow", async () => {
    const first = await runCreate(["Review changes"], { cwd: directory, log: () => {} });
    if (first.status !== "created") throw new Error("expected created result");
    const original = readFileSync(first.flowPath, "utf8");
    const messages: string[] = [];

    const second = await runCreate(["Review changes"], {
      cwd: directory,
      log: (message) => messages.push(message),
    });

    expect(second.status).toBe("conflict");
    expect(readFileSync(first.flowPath, "utf8")).toBe(original);
    expect(messages.join("\n")).toContain("Nothing was changed");
    expect(messages.join("\n")).toContain("--name <slug>");
  });

  it("translates a legacy filename and metadata into a canonical v3 flow", async () => {
    const opened: string[] = [];
    const result = await runCreate(
      ["review.i.claude.md", "--model", "opus", "--content", "Review the supplied diff.", "--open"],
      {
        cwd: directory,
        log: () => {},
        openFile: (path) => {
          opened.push(path);
          return true;
        },
      }
    );

    const flowPath = join(directory, "flows", "review.md");
    expect(result.status).toBe("created");
    if (result.status !== "created") throw new Error("expected created result");
    expect(result.flowPath).toBe(flowPath);
    expect(opened).toEqual([flowPath]);
    expect(parseRawFrontmatter(readFileSync(flowPath, "utf8"))).toMatchObject({
      frontmatter: {
        description: "review",
        engine: "claude",
        model: "opus",
        _interactive: true,
      },
      body: "Review the supplied diff.",
    });
    expect(readFileSync(join(directory, ".mdflow.yaml"), "utf8")).toContain("engine: claude");
  });

  it("keeps custom-directory creation as a safe, create-only legacy escape hatch", async () => {
    const result = await runCreate(["Explain API changes", "--dir", "legacy agents"], {
      cwd: directory,
      log: () => {},
    });

    expect(result.status).toBe("created");
    if (result.status !== "created") throw new Error("expected created result");
    expect(result.flowPath).toBe(join(directory, "legacy agents", "explain-api-changes.md"));
    expect(existsSync(result.flowPath)).toBe(true);
    expect(existsSync(join(directory, "legacy agents", "README.md"))).toBe(false);
    expect(existsSync(join(directory, ".mdflow.yaml"))).toBe(false);
  });

  it("creates in the current directory with scope-specific invocation guidance", async () => {
    const messages: string[] = [];
    const result = await runCreate(["Local helper", "--location", "cwd"], {
      cwd: directory,
      log: (message) => messages.push(message),
    });
    expect(result.status).toBe("created");
    if (result.status !== "created") throw new Error("expected created result");
    expect(result.flowPath).toBe(join(directory, "local-helper.md"));
    const output = messages.join("\n");
    expect(output).toContain("Creating in CURRENT DIRECTORY → ./local-helper.md");
    expect(output).toContain("Created in CURRENT DIRECTORY → ./local-helper.md");
    expect(output).toContain("Run from this directory: md local-helper");
  });

  it("prints help without prompting or writing", async () => {
    const messages: string[] = [];
    let prompted = false;
    const result = await runCreate(["--help"], {
      cwd: directory,
      log: (message) => messages.push(message),
      promptIntent: async () => {
        prompted = true;
        return "should not happen";
      },
    });

    expect(result.status).toBe("help");
    expect(prompted).toBe(false);
    const output = messages.join("\n");
    expect(output).toContain("Usage: md create [intent...] [options]");
    expect(output).toContain("--global, -g            Create in ~/.mdflow/; md <name> works everywhere");
    expect(output).not.toContain("Legacy: create directly in ~/.mdflow/");
    expect(existsSync(join(directory, "flows"))).toBe(false);
  });
});
