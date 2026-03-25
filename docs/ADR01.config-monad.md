# ADR-01: Unify config merging under a monoid

- **Status**: Accepted
- **Date**: 2025-12-12
- **Scope**: `config.ts`, `command-builder.ts`

## Context

mdflow's config precedence chain merges six layers, each overriding the last:

```
built-in ⊕ global ⊕ git-root ⊕ cwd ⊕ frontmatter ⊕ CLI flags
```

This is structurally a monoidal fold: `{}` is the identity, right-biased shallow merge is the associative binary operation, and `reduce` is the fold. But before this change, three separate code paths expressed that same operation differently:

1. `mergeConfigs()` in `config.ts`: deep-clones base, then shallow-merges override per command key
2. `applyDefaults()` in `config.ts`: spreads defaults first, then iterates frontmatter entries with assignment
3. Inline spreads in `command-builder.ts`: `{ ...defaults, ...frontmatter } as AgentFrontmatter`

The inline spreads don't deep-clone, so they can alias nested objects. `applyDefaults` uses iteration rather than spread, which behaves identically for flat objects but could diverge with getters or `toJSON`. There were ~18 tests across three files testing variations of the same merge logic, but no integration test verified the full precedence chain end-to-end.

## Decision

Introduce `concatFrontmatter(base, override)` as the single canonical merge operation, with documented algebraic laws:

```typescript
export function concatFrontmatter(
  base: AgentFrontmatter,
  override: AgentFrontmatter
): AgentFrontmatter {
  return { ...base, ...override };
}
```

Laws (verified by property-based tests):
- **Identity**: `concatFrontmatter({}, x) ≡ x` and `concatFrontmatter(x, {}) ≡ x`
- **Right-bias**: for any key `k` in both `a` and `b`, `result[k] === b[k]`
- **Associativity**: `concat(a, concat(b, c)) ≡ concat(concat(a, b), c)`
- **No mutation**: neither input is modified

All three code paths now delegate to this function:
- `applyDefaults` becomes a thin wrapper: `concatFrontmatter(defaults, frontmatter)`
- `mergeConfigs` uses it for per-command merging
- `buildCommand` / `buildCommandBase` call it instead of inline spreads

## Testing strategy

Property-based tests (fast-check, 200 randomized inputs per law) replace the case-by-case merge tests. A mutation proof (`doc/mutation-proof.md`) demonstrates equivalence: three deliberate bugs were introduced one at a time, and the property tests caught all three (3/3) while the case tests caught only one (1/3). The two bugs missed by case tests were phantom key injection (caught by identity law) and input mutation (caught by no-mutation law).

## Consequences

- One function to reason about for all config merging, instead of three
- Property-based tests provide strictly stronger coverage with fewer test cases
- `applyDefaults` is retained as a backward-compatible wrapper (thin delegation, no separate logic)
- `mergeConfigs` still handles the `GlobalConfig` level (per-command dispatch), but its inner merge is now `concatFrontmatter`
