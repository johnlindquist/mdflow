import { expect, test, describe } from "bun:test";
import { validateFrontmatter, safeParseFrontmatter } from "./schema";

describe("validateFrontmatter", () => {
  test("validates minimal frontmatter", () => {
    const result = validateFrontmatter({ command: "claude" });
    expect(result.command).toBe("claude");
  });

  test("validates inputs array", () => {
    const result = validateFrontmatter({
      inputs: [
        { name: "branch", type: "text", message: "Branch?" },
        { name: "force", type: "confirm", message: "Force?", default: false },
      ]
    });
    expect(result.inputs).toHaveLength(2);
    expect(result.inputs![0]!.name).toBe("branch");
    expect(result.inputs![1]!.default).toBe(false);
  });

  test("validates select input with choices", () => {
    const result = validateFrontmatter({
      inputs: [
        { name: "env", type: "select", message: "Env?", choices: ["dev", "prod"] }
      ]
    });
    expect(result.inputs![0]!.choices).toEqual(["dev", "prod"]);
  });

  test("rejects select without choices", () => {
    expect(() => validateFrontmatter({
      inputs: [
        { name: "env", type: "select", message: "Env?" }
      ]
    })).toThrow("Select inputs require a non-empty choices array");
  });

  test("validates context as string", () => {
    const result = validateFrontmatter({ context: "src/**/*.ts" });
    expect(result.context).toBe("src/**/*.ts");
  });

  test("validates context as array", () => {
    const result = validateFrontmatter({ context: ["src/**/*.ts", "!**/*.test.ts"] });
    expect(result.context).toEqual(["src/**/*.ts", "!**/*.test.ts"]);
  });

  test("validates requires object", () => {
    const result = validateFrontmatter({
      requires: {
        bin: ["docker", "gh"],
        env: ["GITHUB_TOKEN"]
      }
    });
    expect(result.requires?.bin).toEqual(["docker", "gh"]);
    expect(result.requires?.env).toEqual(["GITHUB_TOKEN"]);
  });

  test("validates cache flag", () => {
    const result = validateFrontmatter({ cache: true });
    expect(result.cache).toBe(true);
  });

  test("allows unknown keys - they become CLI flags", () => {
    const result = validateFrontmatter({
      command: "claude",
      model: "opus",
      "dangerously-skip-permissions": true,
      "mcp-config": "./mcp.json"
    });
    expect(result.command).toBe("claude");
    expect((result as any).model).toBe("opus");
    expect((result as any)["dangerously-skip-permissions"]).toBe(true);
    expect((result as any)["mcp-config"]).toBe("./mcp.json");
  });
});

describe("safeParseFrontmatter", () => {
  test("returns success with valid data", () => {
    const result = safeParseFrontmatter({ command: "gemini" });
    expect(result.success).toBe(true);
    expect(result.data?.command).toBe("gemini");
  });

  test("returns errors with invalid data", () => {
    const result = safeParseFrontmatter({
      inputs: [{ type: "text" }] // Missing name and message
    });
    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
  });

  test("formats error paths correctly", () => {
    const result = safeParseFrontmatter({
      inputs: [{ name: "test", type: "invalid", message: "test" }]
    });
    expect(result.success).toBe(false);
    expect(result.errors?.some(e => e.includes("inputs.0.type"))).toBe(true);
  });
});
