---
model: opus
_project: "{{ _project | default: 'MyProject' }}"
_task: "{{ _task | default: '1.1' }}"
_interactive: true
---

# Implementation: {{ _project }} - Task {{ _task }}

Guide for executing individual tasks or all tasks in sequence.

**Task Reference**: @./tasks.claude.md  
**All Specs**: @./plan.claude.md  
**Mode**: Interactive - ask questions as you work

## Pre-Work Checklist
```
!git status
!npm test 2>&1 | head -20
!git branch
```

## Current Task: {{ _task }}

### Context
Review the task definition from tasks.claude.md:
@./tasks.claude.md

### Implementation Steps

1. **Understand the requirements**
   - What needs to be built?
   - What are the acceptance criteria?
   - What files will be affected?

2. **Write tests first** (TDD)
   ```bash
   npm test -- --watch
   ```

3. **Implement incrementally**
   - Small, reviewable commits
   - Test frequently
   - Run linter: `!npm run lint`

4. **Validate implementation**
   ```bash
   !npm test
   !npm run lint
   !npm run build
   ```

5. **Document changes**
   - Update README if needed
   - Add inline comments
   - Update CHANGELOG.md

## Parallel Tasks (if running multiple agents)

Run task analysis in parallel:
```
md implement.claude.md --_project "{{ _project }}" --_task "1.1" | tee task-1.1-notes.md
md implement.claude.md --_project "{{ _project }}" --_task "1.2" | tee task-1.2-notes.md
```

## Integration After Task Completion

Once task is done:
```bash
git add -A
git commit -m "feat: implement task {{ _task }}"
!npm test
```

## When Stuck

Ask for help or clarification:
```bash
md help.claude.md --_question "How do I handle [specific issue]?"
```

---

**Quick Commands**:
```bash
# Run just this task
md implement.claude.md --_project "{{ _project }}" --_task "{{ _task }}"

# Watch tests
!npm test -- --watch

# Run full suite
!npm test && npm run lint && npm run build
```

**Next Task**: Update tasks.claude.md when this task is complete.
