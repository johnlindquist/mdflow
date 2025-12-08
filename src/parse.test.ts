import { expect, test, describe } from "bun:test";
import { parseFrontmatter, stripShebang } from "./parse";

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
context: ["src/**/*.ts", "tests/**/*.ts"]
---
Body`;
    const result = parseFrontmatter(content);
    expect(result.frontmatter.context).toEqual(["src/**/*.ts", "tests/**/*.ts"]);
  });

  test("parses multiline array", () => {
    const content = `---
context:
  - src/**/*.ts
  - lib/**/*.ts
model: gpt-5
---
Body`;
    const result = parseFrontmatter(content);
    expect(result.frontmatter.context).toEqual(["src/**/*.ts", "lib/**/*.ts"]);
    expect(result.frontmatter.model).toBe("gpt-5");
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

  test("strips shebang line before parsing", () => {
    const content = `#!/usr/bin/env ma
---
model: gpt-5
---
Body content`;
    const result = parseFrontmatter(content);
    expect(result.frontmatter.model).toBe("gpt-5");
    expect(result.body).toBe("Body content");
  });

  test("handles shebang without frontmatter", () => {
    const content = `#!/usr/bin/env ma
Just some content`;
    const result = parseFrontmatter(content);
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe("Just some content");
  });
});

describe("stripShebang", () => {
  test("removes shebang line", () => {
    const content = `#!/usr/bin/env ma
rest of content`;
    expect(stripShebang(content)).toBe("rest of content");
  });

  test("preserves content without shebang", () => {
    const content = "no shebang here";
    expect(stripShebang(content)).toBe("no shebang here");
  });

  test("handles various shebang formats", () => {
    expect(stripShebang("#!/bin/bash\nrest")).toBe("rest");
    expect(stripShebang("#! /usr/bin/env node\nrest")).toBe("rest");
    expect(stripShebang("#!/usr/local/bin/ma\nrest")).toBe("rest");
  });
});

describe("parseFrontmatter passthrough", () => {
  test("passes through arbitrary nested objects", () => {
    const content = `---
custom:
  nested:
    value: 42
model: gpt-5
---
Body`;
    const result = parseFrontmatter(content);
    expect(result.frontmatter.custom).toEqual({ nested: { value: 42 } });
    expect(result.frontmatter.model).toBe("gpt-5");
  });

  test("passes through arrays of objects", () => {
    const content = `---
items:
  - name: first
    value: 1
  - name: second
    value: 2
---
Body`;
    const result = parseFrontmatter(content);
    expect(result.frontmatter.items).toHaveLength(2);
    expect(result.frontmatter.items[0]).toEqual({ name: "first", value: 1 });
    expect(result.frontmatter.items[1]).toEqual({ name: "second", value: 2 });
  });
});
