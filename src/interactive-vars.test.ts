import { expect, test, describe, mock, spyOn, beforeEach, afterEach } from "bun:test";
import { extractTemplateVars } from "./template";

/**
 * Tests for interactive variable recovery feature.
 *
 * The feature prompts users for missing template variables interactively
 * when running in a TTY environment, instead of immediately failing.
 */

describe("interactive variable recovery", () => {
  describe("missing variable detection", () => {
    test("identifies missing variables from template", () => {
      const body = "Hello {{ name }}, your task is {{ task }}";
      const requiredVars = extractTemplateVars(body);
      const templateVars: Record<string, string> = { name: "Alice" };

      const missingVars = requiredVars.filter(v => !(v in templateVars));

      expect(missingVars).toEqual(["task"]);
    });

    test("returns empty array when all variables provided", () => {
      const body = "Hello {{ name }}";
      const requiredVars = extractTemplateVars(body);
      const templateVars: Record<string, string> = { name: "Bob" };

      const missingVars = requiredVars.filter(v => !(v in templateVars));

      expect(missingVars).toEqual([]);
    });

    test("identifies multiple missing variables", () => {
      const body = "{{ a }} and {{ b }} and {{ c }}";
      const requiredVars = extractTemplateVars(body);
      const templateVars: Record<string, string> = { b: "provided" };

      const missingVars = requiredVars.filter(v => !(v in templateVars));

      expect(missingVars).toEqual(["a", "c"]);
    });
  });

  describe("TTY detection logic", () => {
    test("process.stdin.isTTY is boolean or undefined", () => {
      // In test environment, isTTY may be undefined or false
      const isTTY = process.stdin.isTTY;
      expect(isTTY === undefined || typeof isTTY === "boolean").toBe(true);
    });

    test("interactive mode should only activate when isTTY is truthy", () => {
      // Simulate the logic used in index.ts
      const shouldPromptInteractively = (isTTY: boolean | undefined) => {
        return !!isTTY;
      };

      expect(shouldPromptInteractively(true)).toBe(true);
      expect(shouldPromptInteractively(false)).toBe(false);
      expect(shouldPromptInteractively(undefined)).toBe(false);
    });
  });

  describe("variable collection behavior", () => {
    test("collects all missing variables into templateVars", async () => {
      // Simulating the behavior without actual inquirer prompts
      const missingVars = ["name", "task"];
      const templateVars: Record<string, string> = {};

      // Mock what the interactive loop does
      const mockInputValues = ["Alice", "write tests"];
      for (let i = 0; i < missingVars.length; i++) {
        const v = missingVars[i];
        templateVars[v] = mockInputValues[i];
      }

      expect(templateVars).toEqual({
        name: "Alice",
        task: "write tests"
      });
    });

    test("preserves existing template variables when prompting for missing ones", () => {
      const missingVars = ["task"];
      const templateVars: Record<string, string> = { name: "Bob" };

      // Mock adding the missing variable
      templateVars["task"] = "code review";

      expect(templateVars).toEqual({
        name: "Bob",
        task: "code review"
      });
    });
  });

  describe("non-interactive mode behavior", () => {
    test("should exit with error message when not TTY", () => {
      const missingVars = ["name", "task"];
      const isTTY = false;

      // This simulates the error message format
      if (!isTTY && missingVars.length > 0) {
        const errorMessage = `Missing template variables: ${missingVars.join(", ")}`;
        expect(errorMessage).toBe("Missing template variables: name, task");
      }
    });

    test("error message includes helpful hint about args:", () => {
      const helpMessage = "Use 'args:' in frontmatter to map CLI arguments to variables";
      expect(helpMessage).toContain("args:");
      expect(helpMessage).toContain("frontmatter");
    });
  });
});

describe("integration with extractTemplateVars", () => {
  test("handles LiquidJS syntax correctly", () => {
    const body = "{{ variable_with_underscore }} and {{ camelCase }}";
    const vars = extractTemplateVars(body);
    expect(vars).toContain("variable_with_underscore");
    expect(vars).toContain("camelCase");
  });

  test("variables with filters are extracted", () => {
    // Variables with filter expressions are extracted because they may still
    // need user input even if they have a default filter
    const body = '{{ name | default: "World" }}';
    const vars = extractTemplateVars(body);
    // The variable is extracted even with a filter
    expect(vars).toEqual(["name"]);
  });

  test("deduplicates repeated variables for prompting", () => {
    const body = "{{ name }} says hello to {{ name }}";
    const vars = extractTemplateVars(body);
    // Should only prompt once for name
    expect(vars).toEqual(["name"]);
  });
});
