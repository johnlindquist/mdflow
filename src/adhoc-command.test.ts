import { describe, it, expect } from "bun:test";
import {
  detectAdhocCommand,
  createVirtualAgentContent,
  createVirtualFilename,
  SUPPORTED_COMMANDS,
} from "./adhoc-command";

describe("detectAdhocCommand", () => {
  describe("command detection from script name", () => {
    it("detects md.claude from argv[1]", () => {
      const result = detectAdhocCommand(["bun", "md.claude", "What is 2+2?"]);
      expect(result.isAdhoc).toBe(true);
      expect(result.command).toBe("claude");
      expect(result.body).toBe("What is 2+2?");
      expect(result.interactive).toBe(false);
    });

    it("detects md.gemini from argv[1]", () => {
      const result = detectAdhocCommand(["bun", "md.gemini", "Explain quantum computing"]);
      expect(result.isAdhoc).toBe(true);
      expect(result.command).toBe("gemini");
      expect(result.body).toBe("Explain quantum computing");
    });

    it("detects md.codex from argv[1]", () => {
      const result = detectAdhocCommand(["bun", "md.codex", "Write a function"]);
      expect(result.isAdhoc).toBe(true);
      expect(result.command).toBe("codex");
    });

    it("detects md.copilot from argv[1]", () => {
      const result = detectAdhocCommand(["bun", "md.copilot", "Help me debug"]);
      expect(result.isAdhoc).toBe(true);
      expect(result.command).toBe("copilot");
    });

    it("detects md.droid from argv[1]", () => {
      const result = detectAdhocCommand(["bun", "md.droid", "Build an app"]);
      expect(result.isAdhoc).toBe(true);
      expect(result.command).toBe("droid");
    });

    it("detects md.opencode from argv[1]", () => {
      const result = detectAdhocCommand(["bun", "md.opencode", "Refactor this"]);
      expect(result.isAdhoc).toBe(true);
      expect(result.command).toBe("opencode");
    });
  });

  describe("interactive mode detection", () => {
    it("detects md.i.claude for interactive mode", () => {
      const result = detectAdhocCommand(["bun", "md.i.claude", "Interactive session"]);
      expect(result.isAdhoc).toBe(true);
      expect(result.command).toBe("claude");
      expect(result.interactive).toBe(true);
    });

    it("detects md.i.gemini for interactive mode", () => {
      const result = detectAdhocCommand(["bun", "md.i.gemini", "Chat with me"]);
      expect(result.isAdhoc).toBe(true);
      expect(result.command).toBe("gemini");
      expect(result.interactive).toBe(true);
    });
  });

  describe("argument parsing", () => {
    it("extracts body as first non-flag argument", () => {
      const result = detectAdhocCommand(["bun", "md.claude", "My prompt"]);
      expect(result.body).toBe("My prompt");
    });

    it("handles flags before body", () => {
      const result = detectAdhocCommand(["bun", "md.claude", "--model", "opus", "My prompt"]);
      expect(result.body).toBe("My prompt");
      expect(result.passthroughArgs).toEqual(["--model", "opus"]);
    });

    it("handles flags after body", () => {
      const result = detectAdhocCommand(["bun", "md.claude", "My prompt", "--model", "opus"]);
      expect(result.body).toBe("My prompt");
      expect(result.passthroughArgs).toEqual(["--model", "opus"]);
    });

    it("handles mixed flags before and after body", () => {
      const result = detectAdhocCommand([
        "bun", "md.claude",
        "--verbose",
        "My prompt",
        "--model", "opus",
      ]);
      expect(result.body).toBe("My prompt");
      expect(result.passthroughArgs).toEqual(["--verbose", "--model", "opus"]);
    });

    it("returns undefined body when no prompt provided", () => {
      const result = detectAdhocCommand(["bun", "md.claude"]);
      expect(result.isAdhoc).toBe(true);
      expect(result.body).toBeUndefined();
    });

    it("handles flags only (no body)", () => {
      const result = detectAdhocCommand(["bun", "md.claude", "--model", "opus"]);
      expect(result.isAdhoc).toBe(true);
      expect(result.body).toBeUndefined();
      expect(result.passthroughArgs).toEqual(["--model", "opus"]);
    });

    it("handles prompts with @imports syntax", () => {
      const result = detectAdhocCommand(["bun", "md.claude", "Explain this: @error.log"]);
      expect(result.body).toBe("Explain this: @error.log");
    });

    it("handles multi-word prompts in quotes", () => {
      const result = detectAdhocCommand([
        "bun", "md.claude",
        "This is a multi-word prompt with special chars: @file.ts and {{ template }}"
      ]);
      expect(result.body).toBe("This is a multi-word prompt with special chars: @file.ts and {{ template }}");
    });
  });

  describe("non-adhoc invocations", () => {
    it("returns isAdhoc false for regular md command", () => {
      const result = detectAdhocCommand(["bun", "md", "task.claude.md"]);
      expect(result.isAdhoc).toBe(false);
    });

    it("returns isAdhoc false for mdflow command", () => {
      const result = detectAdhocCommand(["bun", "mdflow", "task.claude.md"]);
      expect(result.isAdhoc).toBe(false);
    });

    it("returns isAdhoc false for unsupported command", () => {
      const result = detectAdhocCommand(["bun", "md.unsupported", "prompt"]);
      expect(result.isAdhoc).toBe(false);
    });

    it("returns isAdhoc false for full path to index.ts", () => {
      const result = detectAdhocCommand(["bun", "/path/to/src/index.ts", "task.claude.md"]);
      expect(result.isAdhoc).toBe(false);
    });
  });

  describe("file extension handling", () => {
    it("strips .ts extension from script name", () => {
      const result = detectAdhocCommand(["bun", "md.claude.ts", "My prompt"]);
      expect(result.isAdhoc).toBe(true);
      expect(result.command).toBe("claude");
    });

    it("strips .js extension from script name", () => {
      const result = detectAdhocCommand(["bun", "md.claude.js", "My prompt"]);
      expect(result.isAdhoc).toBe(true);
      expect(result.command).toBe("claude");
    });
  });
});

describe("createVirtualAgentContent", () => {
  it("creates basic content without interactive mode", () => {
    const content = createVirtualAgentContent("claude", "My prompt");
    expect(content).toBe("---\n---\nMy prompt");
  });

  it("creates content with interactive mode", () => {
    const content = createVirtualAgentContent("claude", "My prompt", true);
    expect(content).toBe("---\n_interactive: true\n---\nMy prompt");
  });

  it("preserves prompt content with @imports", () => {
    const content = createVirtualAgentContent("claude", "Explain: @error.log");
    expect(content).toContain("Explain: @error.log");
  });

  it("preserves prompt content with template variables", () => {
    const content = createVirtualAgentContent("claude", "Hello {{ _name }}");
    expect(content).toContain("Hello {{ _name }}");
  });
});

describe("createVirtualFilename", () => {
  it("creates filename for print mode", () => {
    const filename = createVirtualFilename("claude");
    expect(filename).toBe("adhoc.claude.md");
  });

  it("creates filename for interactive mode", () => {
    const filename = createVirtualFilename("claude", true);
    expect(filename).toBe("adhoc.i.claude.md");
  });

  it("creates filename for different commands", () => {
    expect(createVirtualFilename("gemini")).toBe("adhoc.gemini.md");
    expect(createVirtualFilename("codex")).toBe("adhoc.codex.md");
    expect(createVirtualFilename("copilot")).toBe("adhoc.copilot.md");
  });
});

describe("SUPPORTED_COMMANDS", () => {
  it("includes all expected commands", () => {
    expect(SUPPORTED_COMMANDS).toContain("claude");
    expect(SUPPORTED_COMMANDS).toContain("codex");
    expect(SUPPORTED_COMMANDS).toContain("gemini");
    expect(SUPPORTED_COMMANDS).toContain("copilot");
    expect(SUPPORTED_COMMANDS).toContain("droid");
    expect(SUPPORTED_COMMANDS).toContain("opencode");
  });

  it("has exactly 6 supported commands", () => {
    expect(SUPPORTED_COMMANDS.length).toBe(6);
  });
});
