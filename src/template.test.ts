import { expect, test, describe } from "bun:test";
import {
  extractTemplateVars,
  substituteTemplateVars,
  parseTemplateArgs,
} from "./template";

describe("extractTemplateVars", () => {
  // Output tag tests ({{ variable }})
  test("extracts single variable", () => {
    const vars = extractTemplateVars("Hello {{ name }}!");
    expect(vars).toEqual(["name"]);
  });

  test("extracts multiple variables", () => {
    const vars = extractTemplateVars("{{ target }} references {{ reference }}");
    expect(vars).toEqual(["target", "reference"]);
  });

  test("handles variable with no spaces", () => {
    const vars = extractTemplateVars("{{name}}");
    expect(vars).toEqual(["name"]);
  });

  test("handles variable with extra spaces", () => {
    const vars = extractTemplateVars("{{   name   }}");
    expect(vars).toEqual(["name"]);
  });

  test("deduplicates repeated variables", () => {
    const vars = extractTemplateVars("{{ x }} and {{ x }} again");
    expect(vars).toEqual(["x"]);
  });

  test("returns empty array when no variables", () => {
    const vars = extractTemplateVars("No variables here");
    expect(vars).toEqual([]);
  });

  test("extracts variable from filter expression", () => {
    const vars = extractTemplateVars("{{ name | upcase }}");
    expect(vars).toEqual(["name"]);
  });

  // Logic tag tests ({% if/unless/elsif variable %})
  test("extracts variable from if tag", () => {
    const vars = extractTemplateVars("{% if debug %}DEBUG{% endif %}");
    expect(vars).toEqual(["debug"]);
  });

  test("extracts variable from unless tag", () => {
    const vars = extractTemplateVars("{% unless silent %}Loud{% endunless %}");
    expect(vars).toEqual(["silent"]);
  });

  test("extracts variable from elsif tag", () => {
    const vars = extractTemplateVars("{% if a %}A{% elsif b %}B{% endif %}");
    expect(vars).toContain("a");
    expect(vars).toContain("b");
  });

  test("extracts variables from comparison operators", () => {
    const vars = extractTemplateVars('{% if mode == "debug" %}DEBUG{% endif %}');
    expect(vars).toEqual(["mode"]);
  });

  test("extracts variables from and/or conditions", () => {
    const vars = extractTemplateVars("{% if debug and verbose %}VERBOSE DEBUG{% endif %}");
    expect(vars).toContain("debug");
    expect(vars).toContain("verbose");
  });

  test("excludes Liquid operators and keywords", () => {
    const vars = extractTemplateVars("{% if debug and not silent or verbose %}test{% endif %}");
    expect(vars).toContain("debug");
    expect(vars).toContain("silent");
    expect(vars).toContain("verbose");
    expect(vars).not.toContain("and");
    expect(vars).not.toContain("not");
    expect(vars).not.toContain("or");
  });

  test("excludes true/false/nil keywords", () => {
    const vars = extractTemplateVars("{% if enabled == true %}yes{% endif %}");
    expect(vars).toEqual(["enabled"]);
    expect(vars).not.toContain("true");
  });

  test("excludes numeric values", () => {
    const vars = extractTemplateVars("{% if count > 10 %}many{% endif %}");
    expect(vars).toEqual(["count"]);
    expect(vars).not.toContain("10");
  });

  // Combined cases
  test("extracts variables from both output and logic tags", () => {
    const content = `{% if debug %}
      Debug: {{ message }}
    {% endif %}`;
    const vars = extractTemplateVars(content);
    expect(vars).toContain("debug");
    expect(vars).toContain("message");
  });

  test("deduplicates variables across output and logic tags", () => {
    const content = "{% if name %}Hello {{ name }}!{% endif %}";
    const vars = extractTemplateVars(content);
    expect(vars).toEqual(["name"]);
  });

  test("handles complex template with multiple logic tags", () => {
    const content = `
      {% if force %}--force{% endif %}
      {% unless quiet %}echo "Processing {{ file }}"{% endunless %}
      {% if verbose and debug %}--verbose --debug{% elsif trace %}--trace{% endif %}
    `;
    const vars = extractTemplateVars(content);
    expect(vars).toContain("force");
    expect(vars).toContain("quiet");
    expect(vars).toContain("file");
    expect(vars).toContain("verbose");
    expect(vars).toContain("debug");
    expect(vars).toContain("trace");
  });
});

describe("substituteTemplateVars", () => {
  test("substitutes single variable", () => {
    const result = substituteTemplateVars("Hello {{ name }}!", { name: "World" });
    expect(result).toBe("Hello World!");
  });

  test("substitutes multiple variables", () => {
    const result = substituteTemplateVars(
      "Refactor {{ target }} to match {{ reference }}",
      { target: "src/utils.ts", reference: "src/main.ts" }
    );
    expect(result).toBe("Refactor src/utils.ts to match src/main.ts");
  });

  test("handles repeated variables", () => {
    const result = substituteTemplateVars("{{ x }} + {{ x }} = 2x", { x: "1" });
    expect(result).toBe("1 + 1 = 2x");
  });

  test("renders unknown variables as empty by default", () => {
    const result = substituteTemplateVars("{{ known }} and {{ unknown }}", {
      known: "yes",
    });
    expect(result).toBe("yes and ");
  });

  test("uses default filter for fallback values", () => {
    const result = substituteTemplateVars('Hello {{ name | default: "World" }}!', {});
    expect(result).toBe("Hello World!");
  });

  test("throws in strict mode for missing variables", () => {
    expect(() =>
      substituteTemplateVars("{{ missing }}", {}, { strict: true })
    ).toThrow("Missing required template variable: missing");
  });

  test("throws in strict mode for missing variables in logic tags", () => {
    expect(() =>
      substituteTemplateVars("{% if debug %}DEBUG{% endif %}", {}, { strict: true })
    ).toThrow("Missing required template variable: debug");
  });

  test("strict mode passes when logic tag variables are provided", () => {
    const result = substituteTemplateVars(
      "{% if debug %}DEBUG{% endif %}",
      { debug: "true" },
      { strict: true }
    );
    expect(result).toBe("DEBUG");
  });

  test("supports conditionals", () => {
    const result = substituteTemplateVars(
      "{% if force %}--force{% endif %}",
      { force: "true" }
    );
    expect(result).toBe("--force");
  });

  test("supports conditional else", () => {
    const result = substituteTemplateVars(
      "{% if debug %}DEBUG{% else %}PRODUCTION{% endif %}",
      {}
    );
    expect(result).toBe("PRODUCTION");
  });

  test("supports upcase filter", () => {
    const result = substituteTemplateVars("{{ name | upcase }}", { name: "hello" });
    expect(result).toBe("HELLO");
  });

  test("supports downcase filter", () => {
    const result = substituteTemplateVars("{{ name | downcase }}", { name: "HELLO" });
    expect(result).toBe("hello");
  });
});

describe("parseTemplateArgs", () => {
  const knownFlags = new Set(["--model", "-m", "--silent"]);

  test("parses simple template arg", () => {
    const args = ["--target", "src/utils.ts"];
    const vars = parseTemplateArgs(args, knownFlags);
    expect(vars).toEqual({ target: "src/utils.ts" });
  });

  test("parses multiple template args", () => {
    const args = ["--target", "src/utils.ts", "--reference", "src/main.ts"];
    const vars = parseTemplateArgs(args, knownFlags);
    expect(vars).toEqual({ target: "src/utils.ts", reference: "src/main.ts" });
  });

  test("ignores known flags", () => {
    const args = ["--model", "gpt-5", "--target", "file.ts", "--silent"];
    const vars = parseTemplateArgs(args, knownFlags);
    expect(vars).toEqual({ target: "file.ts" });
  });

  test("handles boolean template flags", () => {
    const args = ["--force", "--target", "file.ts"];
    const vars = parseTemplateArgs(args, knownFlags);
    expect(vars).toEqual({ force: "true", target: "file.ts" });
  });

  test("handles paths with special characters", () => {
    const args = ["--path", "/Users/name/My Documents/file.ts"];
    const vars = parseTemplateArgs(args, knownFlags);
    expect(vars).toEqual({ path: "/Users/name/My Documents/file.ts" });
  });

  test("returns empty object when no template args", () => {
    const args = ["--model", "gpt-5", "--silent"];
    const vars = parseTemplateArgs(args, knownFlags);
    expect(vars).toEqual({});
  });
});
