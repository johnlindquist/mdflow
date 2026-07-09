import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

const activeGenerationSurfaces = [
  "assets/init/guide.md",
  "skills/mdflow/SKILL.md",
  "site/components/AgentPrompts.tsx",
] as const;

describe("active flow-generation prompts", () => {
  for (const relativePath of activeGenerationSurfaces) {
    test(`${relativePath} enforces the interactive wait contract`, () => {
      const source = readFileSync(join(root, relativePath), "utf8");
      expect(source).toContain("_system-prompt");
      expect(source).toContain("_append-system-prompt");
      expect(source).toContain('_task: ""');
      expect(source).toContain("{{ _task }}");
      expect(source).toContain("User task:");
      expect(source).toMatch(/no positional prompt|no empty or placeholder positional prompt/);
    });
  }

  test("both website prompts carry the contract", () => {
    const source = readFileSync(join(root, "site/components/AgentPrompts.tsx"), "utf8");
    expect(source.match(/_system-prompt/g)?.length).toBeGreaterThanOrEqual(2);
    expect(source.match(/_append-system-prompt/g)?.length).toBeGreaterThanOrEqual(2);
    expect(source.match(/_task: \"\"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(source.match(/\{\{ _task \}\}/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
