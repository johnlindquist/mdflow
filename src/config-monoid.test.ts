/**
 * Property-based tests for concatFrontmatter monoid laws.
 *
 * These tests verify that concatFrontmatter satisfies:
 *   1. Right identity:  concatFrontmatter(x, {}) ≡ x
 *   2. Left identity:   concatFrontmatter({}, x) ≡ x
 *   3. Right-bias:      for any key in both a and b, result[k] === b[k]
 *   4. Associativity:   concat(a, concat(b, c)) ≡ concat(concat(a, b), c)
 *   5. No mutation:     neither input is modified
 */

import { describe, it, expect } from "bun:test";
import fc from "fast-check";
import { concatFrontmatter } from "./config";
import type { AgentFrontmatter } from "./types";

/**
 * Arbitrary for generating realistic AgentFrontmatter objects.
 *
 * Covers the key spaces that matter: plain string/number/boolean flags,
 * underscore-prefixed template vars, $N positional mappings, and arrays.
 * We deliberately include undefined and null values since frontmatter
 * parsed from YAML can contain these.
 */
const arbFrontmatter: fc.Arbitrary<AgentFrontmatter> = fc.dictionary(
  // Keys: mix of plain flags, _template vars, and $N positionals
  fc.oneof(
    fc.stringMatching(/^[a-z][a-z0-9-]{0,10}$/),       // plain flags: model, verbose, add-dir
    fc.stringMatching(/^_[a-z][a-z0-9]{0,8}$/),          // template vars: _name, _stdin
    fc.constantFrom("$1", "$2", "$3"),                     // positional mappings
  ),
  // Values: the types that actually appear in frontmatter
  fc.oneof(
    fc.string(),
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
    fc.constant(undefined),
    fc.array(fc.string(), { maxLength: 3 }),
  ),
) as fc.Arbitrary<AgentFrontmatter>;

describe("concatFrontmatter monoid laws", () => {
  it("right identity: concat(x, {}) ≡ x", () => {
    fc.assert(
      fc.property(arbFrontmatter, (x) => {
        const result = concatFrontmatter(x, {});
        expect(result).toEqual(x);
      }),
      { numRuns: 200 },
    );
  });

  it("left identity: concat({}, x) ≡ x", () => {
    fc.assert(
      fc.property(arbFrontmatter, (x) => {
        const result = concatFrontmatter({}, x);
        expect(result).toEqual(x);
      }),
      { numRuns: 200 },
    );
  });

  it("right-bias: for any key in both a and b, result[k] === b[k]", () => {
    fc.assert(
      fc.property(arbFrontmatter, arbFrontmatter, (a, b) => {
        const result = concatFrontmatter(a, b);
        for (const key of Object.keys(b)) {
          expect(result[key]).toEqual(b[key]);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("associativity: concat(a, concat(b, c)) ≡ concat(concat(a, b), c)", () => {
    fc.assert(
      fc.property(arbFrontmatter, arbFrontmatter, arbFrontmatter, (a, b, c) => {
        const leftAssoc = concatFrontmatter(concatFrontmatter(a, b), c);
        const rightAssoc = concatFrontmatter(a, concatFrontmatter(b, c));
        expect(leftAssoc).toEqual(rightAssoc);
      }),
      { numRuns: 200 },
    );
  });

  it("no mutation: neither input is modified", () => {
    fc.assert(
      fc.property(arbFrontmatter, arbFrontmatter, (a, b) => {
        // Deep clone inputs before the operation
        const aCopy = JSON.parse(JSON.stringify(a));
        const bCopy = JSON.parse(JSON.stringify(b));

        concatFrontmatter(a, b);

        // Inputs must be unchanged (compare via JSON since toEqual
        // treats undefined values inconsistently across deep clone)
        expect(JSON.stringify(a)).toEqual(JSON.stringify(aCopy));
        expect(JSON.stringify(b)).toEqual(JSON.stringify(bCopy));
      }),
      { numRuns: 200 },
    );
  });

  it("base keys not in override are preserved", () => {
    fc.assert(
      fc.property(arbFrontmatter, arbFrontmatter, (a, b) => {
        const result = concatFrontmatter(a, b);
        for (const key of Object.keys(a)) {
          if (!(key in b)) {
            expect(result[key]).toEqual(a[key]);
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});
