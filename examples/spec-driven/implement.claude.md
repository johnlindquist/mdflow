---
model: opus
---

# Implementation: Execute the Plan

Execute all tasks to build the feature according to the plan.

## Pre-Implementation Checklist
- [ ] Constitution established and agreed upon
- [ ] Specification reviewed and approved
- [ ] Technical plan validated
- [ ] Task breakdown accepted
- [ ] Team understanding confirmed

## Execution Instructions

### Step 1: Validate Prerequisites
```bash
# Ensure development environment is ready
bun --version
git status
```

### Step 2: Execute Phase 1 (Core Infrastructure)
Process Task 1.1, 1.2, 1.3 sequentially:
- Create type definitions
- Implement parser
- Set up build configuration

### Step 3: Execute Phase 2 (Configuration & Templating)
Process Task 2.1, 2.2, 2.3:
- Build configuration loader
- Integrate LiquidJS templates
- Add environment handling

### Step 4: Execute Phase 3 (Import System)
Process Task 3.1, 3.2, 3.3:
- File import parser
- Glob support with filtering
- Command output injection

### Step 5: Execute Phase 4 (Command Execution)
Process Task 4.1, 4.2, 4.3:
- Command resolution logic
- CLI argument building
- Process execution and streaming

### Step 6: Execute Phase 5 (History & State)
Process Task 5.1, 5.2:
- Frecency tracking system
- Variable persistence and recall

### Step 7: Execute Phase 6 (CLI & Logging)
Process Task 6.1, 6.2:
- Pino logging setup
- CLI command interface

### Step 8: Execute Phase 7 (Testing & Documentation)
Process Task 7.1, 7.2, 7.3:
- Unit test suite
- Integration tests
- Complete documentation

## Validation Gates

After each phase, verify:
- ✓ Code compiles without errors
- ✓ Existing tests still pass
- ✓ New functionality works as specified
- ✓ Documentation is updated
- ✓ Examples reflect new features

## Rollout Plan
1. Merge to main branch
2. Tag release version
3. Run smoke tests on all platforms
4. Update CHANGELOG.md
5. Publish release notes

## Success Criteria
- All phases completed as planned
- Test coverage above 80%
- All CLI commands functional
- Documentation comprehensive
- No breaking changes to existing API
