import { expect, test, describe } from "bun:test";
import { parseFrontmatter } from "./parse";

describe("parseFrontmatter", () => {
  test("returns empty frontmatter when no frontmatter present", () => {
    const content = "Just some content";
    const result = parseFrontmatter(content);
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe("Just some content");
  });

  test("parses simple string values", () => {
    const content = `---
model: claude-haiku-4.5
agent: my-agent
---
Body content`;
    const result = parseFrontmatter(content);
    expect(result.frontmatter.model).toBe("claude-haiku-4.5");
    expect(result.frontmatter.agent).toBe("my-agent");
    expect(result.body).toBe("Body content");
  });

  test("parses boolean values", () => {
    const content = `---
silent: true
interactive: false
---
Body`;
    const result = parseFrontmatter(content);
    expect(result.frontmatter.silent).toBe(true);
    expect(result.frontmatter.interactive).toBe(false);
  });

  test("parses inline array", () => {
    const content = `---
before: [command1, command2]
---
Body`;
    const result = parseFrontmatter(content);
    expect(result.frontmatter.before).toEqual(["command1", "command2"]);
  });

  test("parses multiline array", () => {
    const content = `---
before:
  - gh run list
  - git status
model: gpt-5
---
Body`;
    const result = parseFrontmatter(content);
    expect(result.frontmatter.before).toEqual(["gh run list", "git status"]);
    expect(result.frontmatter.model).toBe("gpt-5");
  });

  test("parses single before value as string", () => {
    const content = `---
before: gh run list --limit 5
model: claude-haiku-4.5
---
Body`;
    const result = parseFrontmatter(content);
    expect(result.frontmatter.before).toBe("gh run list --limit 5");
  });

  test("handles kebab-case keys", () => {
    const content = `---
allow-all-tools: true
allow-tool: shell(git:*)
deny-tool: shell(rm)
add-dir: /tmp
---
Body`;
    const result = parseFrontmatter(content);
    expect(result.frontmatter["allow-all-tools"]).toBe(true);
    expect(result.frontmatter["allow-tool"]).toBe("shell(git:*)");
    expect(result.frontmatter["deny-tool"]).toBe("shell(rm)");
    expect(result.frontmatter["add-dir"]).toBe("/tmp");
  });

  test("preserves multiline body", () => {
    const content = `---
model: gpt-5
---

Line 1

Line 2

Line 3`;
    const result = parseFrontmatter(content);
    expect(result.body).toBe("Line 1\n\nLine 2\n\nLine 3");
  });
});
