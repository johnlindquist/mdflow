---
model: opus
_base: "{{ _base | default: 'main' }}"
---

# Remove AI Code Slop

Identify and remove AI-generated code artifacts introduced in this branch.

## Diff Analysis

Analyzing changes against `{{ _base }}`:

```
Files changed:
!git diff {{ _base }}...HEAD --stat

Actual diff:
!git diff {{ _base }}...HEAD
```

## Slop Detection

Look for and remove:

### 1. Excessive Comments
- Comments that explain obvious code
- Block comments that restate code
- Multiple comments on consecutive lines
- Comments inconsistent with file style
- "TODO" or "FIXME" left by AI

Example to remove:
```typescript
// Check if user is valid
if (!user) {
  return null;
}

// Loop through items
items.forEach(item => {
  // Process the item
  process(item);
});
```

Better:
```typescript
if (!user) return null;

items.forEach(item => process(item));
```

### 2. Defensive Checks
- Extra null/undefined checks on validated inputs
- Redundant type guards after type narrowing
- Try/catch blocks for functions that don't throw
- Validation in code paths already validated upstream

Example to remove:
```typescript
// After already checking user exists
if (user) {
  if (user.id) {
    try {
      const result = processUser(user);
    } catch (error) {
      // This function never throws
      console.error(error);
    }
  }
}
```

### 3. Type Casts (`any`)
- `as any` to bypass type errors
- `// @ts-ignore` comments
- `any` typed parameters that should be specific

Example to remove:
```typescript
const data = response.data as any; // Instead of properly typing
if ((error as any).statusCode === 404) {} // Instead of type guard
```

### 4. Inconsistent Style
- Logging inconsistent with the file
- Error handling that doesn't match patterns
- Variable naming that diverges from conventions
- Formatting different from surrounding code
- Excessive whitespace or empty lines

Example to remove:
```typescript
// If file never logs debug info:
console.debug("Processing item", item);

// If file uses throw, not console.error:
console.error("Failed");
```

## Instructions

For each file with changes:

1. Review the actual code changes
2. Identify obvious AI slop (unnecessary comments, defensive checks, casts)
3. Remove it while preserving functionality
4. Ensure remaining code matches file style
5. Run: `npm test` to verify no breakage

Generate a clean, minimal diff that removes only the slop.

## Modified Files

```
!git diff {{ _base }}...HEAD --name-only
```

For each file above, review and clean.

## Validation

After cleanup:
```bash
npm test
npm run lint
git diff {{ _base }}...HEAD
```

Ensure diff is minimal and removes only slop, not functionality.

---

**Output**: Show the cleaned diff with brief explanation of what was removed.
