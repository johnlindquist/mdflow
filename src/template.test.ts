import { expect, test, describe } from "bun:test";
import {
  extractTemplateVars,
  substituteTemplateVars,
  parseTemplateArgs,
} from "./template";

describe("extractTemplateVars", () => {
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
