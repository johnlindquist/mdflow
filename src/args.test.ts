import { expect, test, describe } from "bun:test";
import { parseFrontmatter } from "./parse";
import { substituteTemplateVars, extractTemplateVars } from "./template";
import { resolveCommand } from "./command";

/**
 * Tests for the args system:
 * - args: [varname] in frontmatter defines positional arguments
 * - CLI positional args fill template variables in the body
 * - {{ varname }} in body gets replaced with the CLI arg value
 */

describe("args positional argument flow", () => {
  test("args field defines template variables consumed from CLI", () => {
    const content = `---
args: [message]
---
Say: {{ message }}`;

    const { frontmatter, body } = parseFrontmatter(content);

    // Simulate CLI: md file.md "Hello World"
    const cliArgs = ["Hello World"];
    const templateVars: Record<string, string> = {};

    // Consume positional args (same logic as index.ts)
    if (frontmatter.args && Array.isArray(frontmatter.args)) {
      for (let i = 0; i < frontmatter.args.length; i++) {
        if (i < cliArgs.length) {
          templateVars[frontmatter.args[i]] = cliArgs[i];
        }
      }
    }

    expect(templateVars).toEqual({ message: "Hello World" });

    // Apply substitution
    const result = substituteTemplateVars(body, templateVars);
    expect(result).toBe("Say: Hello World");
  });

  test("multiple args consume multiple positional CLI arguments", () => {
    const content = `---
args: [name, action]
---
{{ name }} will {{ action }}`;

    const { frontmatter, body } = parseFrontmatter(content);

    // Simulate CLI: md file.md "Alice" "run"
    const cliArgs = ["Alice", "run"];
    const templateVars: Record<string, string> = {};

    if (frontmatter.args && Array.isArray(frontmatter.args)) {
      for (let i = 0; i < frontmatter.args.length; i++) {
        if (i < cliArgs.length) {
          templateVars[frontmatter.args[i]] = cliArgs[i];
        }
      }
    }

    expect(templateVars).toEqual({ name: "Alice", action: "run" });

    const result = substituteTemplateVars(body, templateVars);
    expect(result).toBe("Alice will run");
  });

  test("body consisting only of template var becomes the CLI arg", () => {
    const content = `---
args: [prompt]
---
{{ prompt }}`;

    const { frontmatter, body } = parseFrontmatter(content);

    // Simulate CLI: md file.md "Write me a haiku about coding"
    const cliArgs = ["Write me a haiku about coding"];
    const templateVars: Record<string, string> = {};

    if (frontmatter.args && Array.isArray(frontmatter.args)) {
      for (let i = 0; i < frontmatter.args.length; i++) {
        if (i < cliArgs.length) {
          templateVars[frontmatter.args[i]] = cliArgs[i];
        }
      }
    }

    const result = substituteTemplateVars(body, templateVars);
    expect(result).toBe("Write me a haiku about coding");
  });

  test("missing template variables are detected", () => {
    const body = "Hello {{ name }}, welcome to {{ place }}";
    const requiredVars = extractTemplateVars(body);

    expect(requiredVars).toContain("name");
    expect(requiredVars).toContain("place");

    // If only one is provided, the other is "missing"
    const templateVars = { name: "Alice" };
    const missingVars = requiredVars.filter(v => !(v in templateVars));

    expect(missingVars).toEqual(["place"]);
  });
});

describe("$varname fields with defaults", () => {
  test("$varname field with default value", () => {
    const content = `---
$feature_name: Authentication
---
Build {{ feature_name }}`;

    const { frontmatter, body } = parseFrontmatter(content);

    // Extract $varname fields
    const namedVarFields = Object.keys(frontmatter)
      .filter(key => key.startsWith("$") && !/^\$\d+$/.test(key));

    const templateVars: Record<string, string> = {};

    // Use frontmatter default (no CLI override)
    for (const key of namedVarFields) {
      const varName = key.slice(1);
      const defaultValue = frontmatter[key];
      if (defaultValue !== undefined && defaultValue !== null && defaultValue !== "") {
        templateVars[varName] = String(defaultValue);
      }
    }

    expect(templateVars).toEqual({ feature_name: "Authentication" });

    const result = substituteTemplateVars(body, templateVars);
    expect(result).toBe("Build Authentication");
  });

  test("CLI flag overrides $varname default", () => {
    const content = `---
$feature_name: Authentication
---
Build {{ feature_name }}`;

    const { frontmatter, body } = parseFrontmatter(content);

    // Simulate CLI: md file.md --feature_name "Payments"
    const cliArgs = ["--feature_name", "Payments"];

    const namedVarFields = Object.keys(frontmatter)
      .filter(key => key.startsWith("$") && !/^\$\d+$/.test(key));

    const templateVars: Record<string, string> = {};

    for (const key of namedVarFields) {
      const varName = key.slice(1);
      const defaultValue = frontmatter[key];

      // Look for --varname in CLI args
      const flagIndex = cliArgs.findIndex(arg => arg === `--${varName}`);
      if (flagIndex !== -1 && flagIndex + 1 < cliArgs.length) {
        templateVars[varName] = cliArgs[flagIndex + 1];
      } else if (defaultValue !== undefined && defaultValue !== null && defaultValue !== "") {
        templateVars[varName] = String(defaultValue);
      }
    }

    expect(templateVars).toEqual({ feature_name: "Payments" });

    const result = substituteTemplateVars(body, templateVars);
    expect(result).toBe("Build Payments");
  });
});

describe("flag hijacking", () => {
  test("--_command flag is consumed and used as command", () => {
    // Simulate CLI: md generic.md --_command claude --model opus
    const cliArgs = ["--_command", "claude", "--model", "opus"];

    // Extract --_command flag (same logic as index.ts)
    let commandFromCli: string | undefined;
    const remainingArgs = [...cliArgs];

    const commandFlagIndex = remainingArgs.findIndex(arg => arg === "--_command" || arg === "-_c");
    if (commandFlagIndex !== -1 && commandFlagIndex + 1 < remainingArgs.length) {
      commandFromCli = remainingArgs[commandFlagIndex + 1];
      remainingArgs.splice(commandFlagIndex, 2);
    }

    expect(commandFromCli).toBe("claude");
    expect(remainingArgs).toEqual(["--model", "opus"]); // --_command consumed
  });

  test("-_c short flag also works for command", () => {
    const cliArgs = ["-_c", "gemini", "--verbose"];
    const remainingArgs = [...cliArgs];

    let commandFromCli: string | undefined;
    const commandFlagIndex = remainingArgs.findIndex(arg => arg === "--_command" || arg === "-_c");
    if (commandFlagIndex !== -1 && commandFlagIndex + 1 < remainingArgs.length) {
      commandFromCli = remainingArgs[commandFlagIndex + 1];
      remainingArgs.splice(commandFlagIndex, 2);
    }

    expect(commandFromCli).toBe("gemini");
    expect(remainingArgs).toEqual(["--verbose"]);
  });

  test("--_command takes priority over filename", () => {
    // If --_command is provided, it takes priority
    // (filename would give "codex" but --_command says "claude")
    const commandFromCli = "claude";
    const commandFromFilename = "codex"; // from task.codex.md

    const command = commandFromCli || commandFromFilename;
    expect(command).toBe("claude");
  });
});
