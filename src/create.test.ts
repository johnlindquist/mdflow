import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCreateArgs, runCreate } from "./create";
import { parseRawFrontmatter } from "./parse";

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
      location: "project",
      open: true,
      dryRun: false,
      frontmatter: { model: "sonnet", temperature: 0.2 },
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

    const flowPath = join(directory, "flows", "review-staged-changes-for-correctness.md");
    expect(result.status).toBe("created");
    if (result.status !== "created") throw new Error("expected created result");
    expect(result.flowPath).toBe(flowPath);
    expect(existsSync(flowPath)).toBe(true);
    expect(existsSync(join(directory, "flows", "README.md"))).toBe(true);
    expect(existsSync(join(directory, ".mdflow.yaml"))).toBe(true);
    expect(readFileSync(join(directory, ".mdflow.yaml"), "utf8")).toContain("engine: pi");
    expect(parseRawFrontmatter(readFileSync(flowPath, "utf8"))).toMatchObject({
      frontmatter: {
        description: "Review staged changes for correctness",
      },
      body: "Review staged changes for correctness",
    });
    expect(messages.join("\n")).toContain("Created flow:");
    expect(messages.join("\n")).toContain("Run it directly: md review-staged-changes-for-correctness");
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
    expect(existsSync(join(directory, "flows", "summarize-this-repository-for-a-new-contributor.md"))).toBe(
      true
    );
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
    expect(output).toContain("Effect: FREE — no files written");
    expect(output).toContain("engine: codex");
    expect(output).toContain(join(directory, "flows", "draft-release-notes.md"));
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
    const result = await runCreate(["Explain API changes", "--dir", "legacy-agents"], {
      cwd: directory,
      log: () => {},
    });

    expect(result.status).toBe("created");
    if (result.status !== "created") throw new Error("expected created result");
    expect(result.flowPath).toBe(join(directory, "legacy-agents", "explain-api-changes.md"));
    expect(existsSync(result.flowPath)).toBe(true);
    expect(existsSync(join(directory, "legacy-agents", "README.md"))).toBe(false);
    expect(existsSync(join(directory, ".mdflow.yaml"))).toBe(false);
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
    expect(output).toContain("--global, -g            Create a personal flow in ~/.mdflow/ (user scope)");
    expect(output).not.toContain("Legacy: create directly in ~/.mdflow/");
    expect(existsSync(join(directory, "flows"))).toBe(false);
  });
});
