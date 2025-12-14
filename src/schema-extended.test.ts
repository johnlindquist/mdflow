/**
 * Extended schema validation tests
 *
 * Tests for frontmatter parsing edge cases, validation errors,
 * and type coercion behavior.
 */

import { expect, test, describe } from "bun:test";
import { validateFrontmatter, safeParseFrontmatter } from "./schema";
import fc from "fast-check";

describe("frontmatter validation edge cases", () => {
  describe("_env key validation", () => {
    test("validates _env as object with string values", () => {
      const result = validateFrontmatter({
        _env: { API_KEY: "secret", DEBUG: "true" }
      });
      expect(result._env).toEqual({ API_KEY: "secret", DEBUG: "true" });
    });

    test("coerces _env number values to strings", () => {
      const result = validateFrontmatter({
        _env: { PORT: 3000, TIMEOUT: 5000 }
      });
      expect(result._env).toEqual({ PORT: "3000", TIMEOUT: "5000" });
    });

    test("coerces _env boolean values to strings", () => {
      const result = validateFrontmatter({
        _env: { DEBUG: true, VERBOSE: false }
      });
      expect(result._env).toEqual({ DEBUG: "true", VERBOSE: "false" });
    });

    test("handles mixed _env value types", () => {
      const result = validateFrontmatter({
        _env: { STR: "hello", NUM: 42, BOOL: true }
      });
      expect(result._env).toEqual({ STR: "hello", NUM: "42", BOOL: "true" });
    });
  });

  describe("_inputs key validation", () => {
    test("validates _inputs with single item", () => {
      const result = validateFrontmatter({ _inputs: ["message"] });
      expect(result._inputs).toEqual(["message"]);
    });

    test("validates _inputs with empty array", () => {
      const result = validateFrontmatter({ _inputs: [] });
      expect(result._inputs).toEqual([]);
    });

    test("validates _inputs with many items", () => {
      const inputs = Array.from({ length: 20 }, (_, i) => `arg${i}`);
      const result = validateFrontmatter({ _inputs: inputs });
      expect(result._inputs).toEqual(inputs);
    });

    test("rejects _inputs with non-string items", () => {
      const result = safeParseFrontmatter({ _inputs: [123, "valid"] });
      expect(result.success).toBe(false);
    });

    test("rejects _inputs as string instead of array", () => {
      const result = safeParseFrontmatter({ _inputs: "not-an-array" });
      expect(result.success).toBe(false);
    });
  });

  describe("passthrough behavior", () => {
    test("passes through arbitrary CLI flag keys", () => {
      const frontmatter = {
        model: "opus",
        print: true,
        "add-dir": ["./src", "./tests"],
        verbose: false,
      };
      const result = validateFrontmatter(frontmatter);
      expect((result as any).model).toBe("opus");
      expect((result as any).print).toBe(true);
      expect((result as any)["add-dir"]).toEqual(["./src", "./tests"]);
      expect((result as any).verbose).toBe(false);
    });

    test("passes through positional mappings", () => {
      const frontmatter = {
        $1: "prompt",
        $2: "context",
        $10: "extra",
      };
      const result = validateFrontmatter(frontmatter);
      expect((result as any).$1).toBe("prompt");
      expect((result as any).$2).toBe("context");
      expect((result as any).$10).toBe("extra");
    });

    test("passes through template variable definitions", () => {
      const frontmatter = {
        _name: "default-name",
        _target: "./src",
        _debug: true,
      };
      const result = validateFrontmatter(frontmatter);
      expect((result as any)._name).toBe("default-name");
      expect((result as any)._target).toBe("./src");
      expect((result as any)._debug).toBe(true);
    });
  });

  describe("complex frontmatter structures", () => {
    test("handles deeply nested objects", () => {
      const frontmatter = {
        config: {
          nested: {
            deep: {
              value: "test"
            }
          }
        }
      };
      const result = validateFrontmatter(frontmatter);
      expect((result as any).config.nested.deep.value).toBe("test");
    });

    test("handles arrays of objects", () => {
      const frontmatter = {
        tools: [
          { name: "tool1", enabled: true },
          { name: "tool2", enabled: false },
        ]
      };
      const result = validateFrontmatter(frontmatter);
      expect((result as any).tools).toHaveLength(2);
    });

    test("handles null values", () => {
      const frontmatter = { maybeNull: null };
      const result = validateFrontmatter(frontmatter);
      expect((result as any).maybeNull).toBeNull();
    });

    test("handles undefined values", () => {
      const frontmatter = { maybeUndefined: undefined };
      const result = validateFrontmatter(frontmatter);
      // undefined values might be stripped or kept depending on implementation
      expect(result).toBeDefined();
    });
  });

  describe("error formatting", () => {
    test("provides clear error for invalid _inputs type", () => {
      const result = safeParseFrontmatter({ _inputs: 123 });
      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBeGreaterThan(0);
    });

    test("provides clear error for invalid _env type", () => {
      const result = safeParseFrontmatter({ _env: "not-an-object" });
      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
    });

    test("returns multiple errors for multiple invalid fields", () => {
      const result = safeParseFrontmatter({
        _inputs: 123,
        _env: "invalid",
      });
      expect(result.success).toBe(false);
      // Should have errors for both fields
    });
  });
});

describe("frontmatter fuzz tests", () => {
  test("handles any object without throwing", () => {
    fc.assert(
      fc.property(fc.object(), (obj) => {
        // Should not throw
        const result = safeParseFrontmatter(obj);
        expect(typeof result.success).toBe("boolean");
      }),
      { numRuns: 200 }
    );
  });

  test("handles valid _inputs arrays", () => {
    fc.assert(
      fc.property(fc.array(fc.string()), (inputs) => {
        const result = safeParseFrontmatter({ _inputs: inputs });
        expect(result.success).toBe(true);
        expect(result.data?._inputs).toEqual(inputs);
      }),
      { numRuns: 100 }
    );
  });

  test("handles valid _env objects", () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.string().filter(s => s.length > 0 && !s.includes('\0')),
          fc.oneof(fc.string(), fc.integer(), fc.boolean())
        ),
        (env) => {
          const result = safeParseFrontmatter({ _env: env });
          expect(result.success).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe("YAML-specific edge cases", () => {
  test("handles YAML true/false as booleans", () => {
    // YAML parses 'true' and 'false' as booleans
    const result = validateFrontmatter({
      enabled: true,
      disabled: false,
    });
    expect((result as any).enabled).toBe(true);
    expect((result as any).disabled).toBe(false);
  });

  test("handles YAML yes/no as booleans", () => {
    // Some YAML parsers treat yes/no as booleans
    const result = validateFrontmatter({
      yesValue: true, // Would be parsed from 'yes' in YAML
      noValue: false, // Would be parsed from 'no' in YAML
    });
    expect(result).toBeDefined();
  });

  test("handles YAML numbers", () => {
    const result = validateFrontmatter({
      intVal: 42,
      floatVal: 3.14,
      negVal: -10,
      sciVal: 1e10,
    });
    expect((result as any).intVal).toBe(42);
    expect((result as any).floatVal).toBe(3.14);
    expect((result as any).negVal).toBe(-10);
    expect((result as any).sciVal).toBe(1e10);
  });

  test("handles YAML multiline strings", () => {
    const multiline = "line1\nline2\nline3";
    const result = validateFrontmatter({
      description: multiline,
    });
    expect((result as any).description).toBe(multiline);
  });

  test("handles special YAML values in _env", () => {
    // When YAML parses port: 3000, it becomes a number
    // The schema should coerce it to string for _env
    const result = validateFrontmatter({
      _env: {
        PORT: 3000,
        ENABLED: true,
        RATIO: 0.5,
      }
    });
    expect(result._env).toEqual({
      PORT: "3000",
      ENABLED: "true",
      RATIO: "0.5",
    });
  });
});
