# Mutation Proof: Property Tests vs Case Tests

Demonstrates that the property-based tests for `concatFrontmatter` catch
a strict superset of the bugs that the case-by-case tests catch.

## Setup

- **Property tests**: 6 tests in `config-monoid.test.ts` (identity, right-bias, associativity, no-mutation, key preservation)
- **Case tests**: merge-related tests across `config.test.ts`, `context.test.ts`, `command-builder.test.ts`
- **Baseline**: 158 tests, 0 failures

## Mutation 1: Left-bias (base wins instead of override)

```diff
- return { ...base, ...override };
+ return { ...override, ...base };
```

| Suite | Caught? | Failing tests |
|-------|---------|---------------|
| Case tests | Yes (5 failures) | `mergeConfigs > override takes priority`, `applyDefaults merges defaults with frontmatter (frontmatter wins)`, `loadFullConfig > project config overrides global config`, `config cascade > CWD config overrides git root config`, `buildCommand > frontmatter overrides config defaults` |
| Property tests | Yes (1 failure) | `right-bias: for any key in both a and b, result[k] === b[k]` |

**Both suites catch this mutation.**

## Mutation 2: Break identity (inject phantom key)

```diff
- return { ...base, ...override };
+ return { ...base, ...override, _phantom: true };
```

| Suite | Caught? | Failing tests |
|-------|---------|---------------|
| Case tests | No | All pass (case tests only assert specific keys, not absence of extras) |
| Property tests | Yes (2 failures) | `right identity: concat(x, {}) ≡ x`, `left identity: concat({}, x) ≡ x` |

**Only property tests catch this mutation.** The case tests check for the presence
of expected keys but don't verify that no unexpected keys are added. The identity
law catches this immediately because `concat(x, {})` should equal `x` exactly,
and the phantom key breaks that equality.

## Mutation 3: Mutate base input (return mutated base instead of new object)

```diff
- return { ...base, ...override };
+ Object.assign(base, override); return base;
```

| Suite | Caught? | Failing tests |
|-------|---------|---------------|
| Case tests | No | All pass (case tests don't snapshot inputs before/after) |
| Property tests | Yes (1 failure) | `no mutation: neither input is modified` |

**Only property tests catch this mutation.** The case tests pass fresh literals
to each test, so mutating them has no observable effect within a single test.
The property test explicitly verifies that inputs are unchanged after the call.

## Conclusion

| Mutation | Case tests | Property tests |
|----------|-----------|----------------|
| Left-bias | Caught | Caught |
| Phantom key injection | **Missed** | Caught |
| Input mutation | **Missed** | Caught |

The property tests catch all 3 mutations. The case tests catch only 1 of 3.
The property tests are strictly more powerful for verifying the algebraic
properties of `concatFrontmatter`, which justifies removing the case-by-case
merge tests that the property tests subsume.

Note: the case tests that test *other* behavior (config file loading, interactive
mode, project cascade with real filesystem) are NOT subsumed and should be retained.
Only the pure merge-logic tests (identity, precedence, key preservation) are
redundant with the property tests.
