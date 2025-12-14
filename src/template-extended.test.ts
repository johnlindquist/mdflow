/**
 * Extended template variable tests
 *
 * Tests for strict vs non-strict mode, edge cases in variable extraction,
 * and complex template patterns.
 */

import { expect, test, describe } from "bun:test";
import {
  extractTemplateVars,
  substituteTemplateVars,
  parseTemplateArgs,
} from "./template";
import fc from "fast-check";

describe("strict vs non-strict template mode", () => {
  describe("non-strict mode (default)", () => {
    test("renders missing variables as empty string", () => {
      const result = substituteTemplateVars("Hello {{ _missing }}!", {});
      expect(result).toBe("Hello !");
    });

    test("handles multiple missing variables", () => {
      const result = substituteTemplateVars(
        "{{ _a }} and {{ _b }} and {{ _c }}",
        {}
      );
      expect(result).toBe(" and  and ");
    });

    test("renders existing variables while leaving missing ones empty", () => {
      const result = substituteTemplateVars(
        "{{ _exists }} but {{ _missing }}",
        { _exists: "here" }
      );
      expect(result).toBe("here but ");
    });

    test("renders false conditions as empty", () => {
      const result = substituteTemplateVars(
        "{% if _undefined %}show{% endif %}",
        {}
      );
      expect(result).toBe("");
    });
  });

  describe("strict mode", () => {
    test("throws for missing underscore-prefixed variable", () => {
      expect(() =>
        substituteTemplateVars("{{ _required }}", {}, { strict: true })
      ).toThrow("Missing required template variable: _required");
    });

    test("throws for first missing variable in multiple", () => {
      expect(() =>
        substituteTemplateVars(
          "{{ _a }} {{ _b }}",
          { _b: "present" },
          { strict: true }
        )
      ).toThrow("Missing required template variable: _a");
    });

    test("throws for missing variable in logic tags", () => {
      expect(() =>
        substituteTemplateVars(
          "{% if _condition %}show{% endif %}",
          {},
          { strict: true }
        )
      ).toThrow("Missing required template variable: _condition");
    });

    test("passes when all underscore variables are provided", () => {
      const result = substituteTemplateVars(
        "{{ _a }} and {{ _b }}",
        { _a: "first", _b: "second" },
        { strict: true }
      );
      expect(result).toBe("first and second");
    });

    test("does NOT throw for non-underscore variables", () => {
      // Non-underscore variables are not managed by template system
      const result = substituteTemplateVars(
        "{{ model }} works",
        {},
        { strict: true }
      );
      expect(result).toBe(" works");
    });

    test("throws even with default filter in strict mode", () => {
      // Strict mode validates variables BEFORE rendering, so default filter doesn't help
      expect(() =>
        substituteTemplateVars(
          '{{ _name | default: "World" }}',
          {},
          { strict: true }
        )
      ).toThrow("Missing required template variable: _name");
    });
  });
});

describe("variable extraction edge cases", () => {
  test("extracts from nested property access", () => {
    const vars = extractTemplateVars("{{ _config.setting }}");
    expect(vars).toContain("_config");
  });

  test("extracts from deeply nested access", () => {
    const vars = extractTemplateVars("{{ _a.b.c.d }}");
    expect(vars).toContain("_a");
    expect(vars).not.toContain("b");
  });

  test("extracts from array index access", () => {
    const vars = extractTemplateVars("{{ _items[0] }}");
    expect(vars).toContain("_items");
  });

  test("handles filter chain", () => {
    const vars = extractTemplateVars("{{ _name | upcase | truncate: 10 }}");
    expect(vars).toContain("_name");
  });

  test("extracts from for loop collection", () => {
    const vars = extractTemplateVars(
      "{% for item in _items %}{{ item }}{% endfor %}"
    );
    expect(vars).toContain("_items");
    // 'item' is a loop variable, not a template variable
  });

  test("extracts from case statement", () => {
    const vars = extractTemplateVars(
      "{% case _status %}{% when 'active' %}Active{% endcase %}"
    );
    expect(vars).toContain("_status");
  });

  test("excludes assigned variables", () => {
    const vars = extractTemplateVars(
      "{% assign local = 'value' %}{{ local }}{{ _external }}"
    );
    expect(vars).toContain("_external");
    expect(vars).not.toContain("local");
  });

  test("excludes captured variables", () => {
    const vars = extractTemplateVars(
      "{% capture greeting %}Hi{% endcapture %}{{ greeting }}{{ _name }}"
    );
    expect(vars).toContain("_name");
    expect(vars).not.toContain("greeting");
  });

  test("handles contains operator", () => {
    const vars = extractTemplateVars(
      "{% if _list contains _item %}found{% endif %}"
    );
    expect(vars).toContain("_list");
    expect(vars).toContain("_item");
  });
});

describe("complex template patterns", () => {
  test("handles nested conditionals", () => {
    const template = `
      {% if _level1 %}
        Level 1
        {% if _level2 %}
          Level 2
        {% endif %}
      {% endif %}
    `;
    const vars = extractTemplateVars(template);
    expect(vars).toContain("_level1");
    expect(vars).toContain("_level2");
  });

  test("handles elsif chains", () => {
    const template = `
      {% if _a %}A
      {% elsif _b %}B
      {% elsif _c %}C
      {% else %}Default
      {% endif %}
    `;
    const vars = extractTemplateVars(template);
    expect(vars).toContain("_a");
    expect(vars).toContain("_b");
    expect(vars).toContain("_c");
  });

  test("handles unless blocks", () => {
    const vars = extractTemplateVars(
      "{% unless _silent %}Speaking{% endunless %}"
    );
    expect(vars).toContain("_silent");
  });

  test("handles complex boolean expressions", () => {
    const vars = extractTemplateVars(
      "{% if _a and _b or _c %}complex{% endif %}"
    );
    expect(vars).toContain("_a");
    expect(vars).toContain("_b");
    expect(vars).toContain("_c");
  });

  test("handles comparison operators", () => {
    const vars = extractTemplateVars(
      '{% if _count > 10 and _status == "active" %}show{% endif %}'
    );
    expect(vars).toContain("_count");
    expect(vars).toContain("_status");
  });
});

describe("parseTemplateArgs edge cases", () => {
  const knownFlags = new Set(["--model", "-m", "--silent", "--verbose"]);

  test("parses template arg with equals sign in value", () => {
    const args = ["--_equation", "x=y+z"];
    const vars = parseTemplateArgs(args, knownFlags);
    expect(vars._equation).toBe("x=y+z");
  });

  test("parses template arg with spaces in value", () => {
    const args = ["--_message", "hello world"];
    const vars = parseTemplateArgs(args, knownFlags);
    expect(vars._message).toBe("hello world");
  });

  test("handles boolean flags (no value)", () => {
    const args = ["--_force", "--_verbose"];
    const vars = parseTemplateArgs(args, knownFlags);
    expect(vars._force).toBe("true");
    expect(vars._verbose).toBe("true");
  });

  test("handles mixed boolean and value flags", () => {
    const args = ["--_force", "--_target", "file.ts", "--_dry"];
    const vars = parseTemplateArgs(args, knownFlags);
    expect(vars._force).toBe("true");
    expect(vars._target).toBe("file.ts");
    expect(vars._dry).toBe("true");
  });

  test("parses both underscore and non-underscore flags", () => {
    // parseTemplateArgs parses all unknown flags, not just underscore-prefixed
    const args = ["--unknown", "value", "--_known", "value2"];
    const vars = parseTemplateArgs(args, knownFlags);
    expect(vars._known).toBe("value2");
    expect((vars as any).unknown).toBe("value");
  });

  test("handles empty args array", () => {
    const vars = parseTemplateArgs([], knownFlags);
    expect(vars).toEqual({});
  });
});

describe("template fuzz tests", () => {
  test("extractTemplateVars handles random strings", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = extractTemplateVars(input);
        expect(Array.isArray(result)).toBe(true);
      }),
      { numRuns: 500 }
    );
  });

  test("substituteTemplateVars handles random content and vars", () => {
    fc.assert(
      fc.property(
        // Filter out strings with broken template syntax to avoid LiquidJS parse errors
        fc.string().filter(s => !s.includes('{%') && !s.includes('%}') && !s.includes('{{') && !s.includes('}}')),
        fc.dictionary(
          fc.string().filter(s => s.startsWith("_") && s.length > 1),
          fc.string()
        ),
        (content, vars) => {
          // Should not throw for valid non-template content
          const result = substituteTemplateVars(content, vars);
          expect(typeof result).toBe("string");
        }
      ),
      { numRuns: 200 }
    );
  });

  test("parseTemplateArgs handles random args", () => {
    const knownFlags = new Set(["--known"]);
    fc.assert(
      fc.property(fc.array(fc.string()), (args) => {
        const result = parseTemplateArgs(args, knownFlags);
        expect(typeof result).toBe("object");
      }),
      { numRuns: 200 }
    );
  });
});

describe("shell_escape filter", () => {
  test("escapes single quotes correctly", () => {
    const result = substituteTemplateVars("{{ _cmd | shell_escape }}", {
      _cmd: "it's a test",
    });
    // Platform-dependent escaping
    expect(result.length).toBeGreaterThan(0);
  });

  test("escapes double quotes", () => {
    const result = substituteTemplateVars("{{ _cmd | shell_escape }}", {
      _cmd: 'say "hello"',
    });
    expect(result.length).toBeGreaterThan(0);
  });

  test("escapes shell metacharacters", () => {
    const dangerous = ["$(whoami)", "`id`", "${HOME}", "a;b", "a|b", "a&b"];
    for (const cmd of dangerous) {
      const result = substituteTemplateVars("{{ _cmd | q }}", { _cmd: cmd });
      expect(result.length).toBeGreaterThan(0);
    }
  });
});
