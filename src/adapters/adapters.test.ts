/**
 * Tests for the Tool Adapter pattern
 */

import { expect, test, describe, beforeEach } from "bun:test";
import {
  getAdapter,
  hasAdapter,
  registerAdapter,
  getRegisteredAdapters,
  buildBuiltinDefaults,
  clearAdapterRegistry,
  getDefaultAdapter,
} from "./index";
import { claudeAdapter } from "./claude";
import { copilotAdapter } from "./copilot";
import { codexAdapter } from "./codex";
import { geminiAdapter } from "./gemini";
import { droidAdapter } from "./droid";
import { opencodeAdapter } from "./opencode";
import { piAdapter } from "./pi";
import { cursorAgentAdapter } from "./cursor-agent";
import { agyAdapter } from "./agy";
import type { ToolAdapter, AgentFrontmatter } from "../types";

describe("Tool Adapter Registry", () => {
  describe("built-in adapters", () => {
    test("claude adapter is registered", () => {
      expect(hasAdapter("claude")).toBe(true);
    });

    test("copilot adapter is registered", () => {
      expect(hasAdapter("copilot")).toBe(true);
    });

    test("codex adapter is registered", () => {
      expect(hasAdapter("codex")).toBe(true);
    });

    test("gemini adapter is registered", () => {
      expect(hasAdapter("gemini")).toBe(true);
    });

    test("droid adapter is registered", () => {
      expect(hasAdapter("droid")).toBe(true);
    });

    test("opencode adapter is registered", () => {
      expect(hasAdapter("opencode")).toBe(true);
    });

    test("getRegisteredAdapters returns all built-in adapters", () => {
      const adapters = getRegisteredAdapters();
      expect(adapters).toContain("claude");
      expect(adapters).toContain("copilot");
      expect(adapters).toContain("codex");
      expect(adapters).toContain("gemini");
      expect(adapters).toContain("droid");
      expect(adapters).toContain("opencode");
    });
  });

  describe("getAdapter", () => {
    test("returns specific adapter for known tool", () => {
      const adapter = getAdapter("claude");
      expect(adapter.name).toBe("claude");
    });

    test("returns default adapter for unknown tool", () => {
      const adapter = getAdapter("unknown-tool");
      expect(adapter.name).toBe("default");
    });
  });

  describe("buildBuiltinDefaults", () => {
    test("generates correct defaults from adapters", () => {
      const defaults = buildBuiltinDefaults();

      // Claude defaults
      expect(defaults.claude).toBeDefined();
      expect(defaults.claude!.print).toBe(true);

      // Copilot defaults
      expect(defaults.copilot).toBeDefined();
      expect(defaults.copilot!.$1).toBe("prompt");
      expect(defaults.copilot!.silent).toBe(true);

      // Codex defaults
      expect(defaults.codex).toBeDefined();
      expect(defaults.codex!._subcommand).toBe("exec");

      // Droid defaults
      expect(defaults.droid).toBeDefined();
      expect(defaults.droid!._subcommand).toBe("exec");

      // Opencode defaults
      expect(defaults.opencode).toBeDefined();
      expect(defaults.opencode!._subcommand).toBe("run");

      // Gemini has no defaults (empty object not included)
      // Actually, gemini returns empty object, so it won't be in defaults
    });
  });

  describe("custom adapter registration", () => {
    // Note: We need to be careful with registration in tests since it affects global state
    test("can register a custom adapter", () => {
      const customAdapter: ToolAdapter = {
        name: "my-custom-tool",
        getDefaults() {
          return { verbose: true };
        },
        applyInteractiveMode(frontmatter) {
          return { ...frontmatter, interactive: true };
        },
      };

      registerAdapter(customAdapter);
      expect(hasAdapter("my-custom-tool")).toBe(true);

      const adapter = getAdapter("my-custom-tool");
      expect(adapter.name).toBe("my-custom-tool");
      expect(adapter.getDefaults()).toEqual({ verbose: true });
    });
  });
});

describe("Claude Adapter", () => {
  test("has correct name", () => {
    expect(claudeAdapter.name).toBe("claude");
  });

  test("getDefaults returns print mode settings", () => {
    const defaults = claudeAdapter.getDefaults();
    expect(defaults.print).toBe(true);
  });

  test("applyInteractiveMode removes print flag", () => {
    const frontmatter: AgentFrontmatter = {
      print: true,
      model: "opus",
    };

    const result = claudeAdapter.applyInteractiveMode(frontmatter);
    expect(result.print).toBeUndefined();
    expect(result.model).toBe("opus");
  });

  test("applyInteractiveMode preserves other settings", () => {
    const frontmatter: AgentFrontmatter = {
      print: true,
      model: "opus",
      verbose: true,
    };

    const result = claudeAdapter.applyInteractiveMode(frontmatter);
    expect(result.model).toBe("opus");
    expect(result.verbose).toBe(true);
  });
});

describe("Copilot Adapter", () => {
  test("has correct name", () => {
    expect(copilotAdapter.name).toBe("copilot");
  });

  test("getDefaults returns prompt mapping and silent mode", () => {
    const defaults = copilotAdapter.getDefaults();
    expect(defaults.$1).toBe("prompt");
    expect(defaults.silent).toBe(true);
  });

  test("applyInteractiveMode changes $1 to interactive", () => {
    const frontmatter: AgentFrontmatter = {
      $1: "prompt",
      silent: true,
    };

    const result = copilotAdapter.applyInteractiveMode(frontmatter);
    expect(result.$1).toBe("interactive");
    expect(result.silent).toBe(true);
  });
});

describe("Codex Adapter", () => {
  test("has correct name", () => {
    expect(codexAdapter.name).toBe("codex");
  });

  test("getDefaults returns exec subcommand", () => {
    const defaults = codexAdapter.getDefaults();
    expect(defaults._subcommand).toBe("exec");
  });

  test("applyInteractiveMode removes _subcommand", () => {
    const frontmatter: AgentFrontmatter = {
      _subcommand: "exec",
      model: "gpt-4",
    };

    const result = codexAdapter.applyInteractiveMode(frontmatter);
    expect(result._subcommand).toBeUndefined();
    expect(result.model).toBe("gpt-4");
  });
});

describe("Gemini Adapter", () => {
  test("has correct name", () => {
    expect(geminiAdapter.name).toBe("gemini");
  });

  test("getDefaults returns empty object (one-shot is default)", () => {
    const defaults = geminiAdapter.getDefaults();
    expect(Object.keys(defaults).length).toBe(0);
  });

  test("applyInteractiveMode adds prompt-interactive flag", () => {
    const frontmatter: AgentFrontmatter = {
      model: "pro",
    };

    const result = geminiAdapter.applyInteractiveMode(frontmatter);
    expect(result.$1).toBe("prompt-interactive");
    expect(result.model).toBe("pro");
  });
});

describe("Droid Adapter", () => {
  test("has correct name", () => {
    expect(droidAdapter.name).toBe("droid");
  });

  test("getDefaults returns exec subcommand", () => {
    const defaults = droidAdapter.getDefaults();
    expect(defaults._subcommand).toBe("exec");
  });

  test("applyInteractiveMode removes _subcommand", () => {
    const frontmatter: AgentFrontmatter = {
      _subcommand: "exec",
      model: "claude-opus-4-5",
    };

    const result = droidAdapter.applyInteractiveMode(frontmatter);
    expect(result._subcommand).toBeUndefined();
    expect(result.model).toBe("claude-opus-4-5");
  });
});

describe("Opencode Adapter", () => {
  test("has correct name", () => {
    expect(opencodeAdapter.name).toBe("opencode");
  });

  test("getDefaults returns run subcommand", () => {
    const defaults = opencodeAdapter.getDefaults();
    expect(defaults._subcommand).toBe("run");
  });

  test("applyInteractiveMode removes _subcommand", () => {
    const frontmatter: AgentFrontmatter = {
      _subcommand: "run",
      model: "anthropic/claude-sonnet",
    };

    const result = opencodeAdapter.applyInteractiveMode(frontmatter);
    expect(result._subcommand).toBeUndefined();
    expect(result.model).toBe("anthropic/claude-sonnet");
  });
});

describe("Default Adapter", () => {
  test("has name 'default'", () => {
    const adapter = getDefaultAdapter();
    expect(adapter.name).toBe("default");
  });

  test("getDefaults returns empty object", () => {
    const adapter = getDefaultAdapter();
    expect(adapter.getDefaults()).toEqual({});
  });

  test("applyInteractiveMode returns copy without modifications", () => {
    const adapter = getDefaultAdapter();
    const frontmatter: AgentFrontmatter = {
      custom: "value",
      flag: true,
    };

    const result = adapter.applyInteractiveMode(frontmatter);
    expect(result).toEqual(frontmatter);
    // Ensure it's a copy, not the same object
    expect(result).not.toBe(frontmatter);
  });
});

describe("pi Adapter (v3 default engine)", () => {
  test("is registered", () => {
    expect(hasAdapter("pi")).toBe(true);
  });

  test("has correct name", () => {
    expect(piAdapter.name).toBe("pi");
  });

  test("getDefaults is hermetic print mode", () => {
    const defaults = piAdapter.getDefaults();
    expect(defaults.print).toBe(true);
    expect(defaults["no-extensions"]).toBe(true);
    expect(defaults["no-skills"]).toBe(true);
    expect(defaults["no-prompt-templates"]).toBe(true);
    expect(defaults["no-context-files"]).toBe(true);
    expect(defaults["no-session"]).toBe(true);
  });

  test("applyInteractiveMode removes print but keeps isolation", () => {
    const frontmatter: AgentFrontmatter = { print: true, "no-skills": true, model: "gpt-5.5" };
    const result = piAdapter.applyInteractiveMode(frontmatter);
    expect(result.print).toBeUndefined();
    expect(result["no-skills"]).toBe(true);
    expect(result.model).toBe("gpt-5.5");
  });
});

describe("Cursor Agent Adapter", () => {
  test("is registered", () => {
    expect(hasAdapter("cursor-agent")).toBe(true);
  });

  test("has correct name", () => {
    expect(cursorAgentAdapter.name).toBe("cursor-agent");
  });

  test("getDefaults uses print mode with text output", () => {
    const defaults = cursorAgentAdapter.getDefaults();
    expect(defaults.print).toBe(true);
    expect(defaults["output-format"]).toBe("text");
  });

  test("applyInteractiveMode removes print and output-format", () => {
    const frontmatter: AgentFrontmatter = { print: true, "output-format": "text", model: "sonnet-4" };
    const result = cursorAgentAdapter.applyInteractiveMode(frontmatter);
    expect(result.print).toBeUndefined();
    expect(result["output-format"]).toBeUndefined();
    expect(result.model).toBe("sonnet-4");
  });
});

describe("agy (Antigravity) Adapter", () => {
  test("is registered", () => {
    expect(hasAdapter("agy")).toBe(true);
  });

  test("has correct name", () => {
    expect(agyAdapter.name).toBe("agy");
  });

  test("getDefaults uses print mode", () => {
    const defaults = agyAdapter.getDefaults();
    expect(defaults.print).toBe(true);
  });

  test("applyInteractiveMode swaps print for prompt-interactive", () => {
    const frontmatter: AgentFrontmatter = { print: true, model: "gemini-3.1-pro" };
    const result = agyAdapter.applyInteractiveMode(frontmatter);
    expect(result.print).toBeUndefined();
    expect(result.$1).toBe("prompt-interactive");
    expect(result.model).toBe("gemini-3.1-pro");
  });
});
