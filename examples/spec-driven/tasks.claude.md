---
model: opus
_project: "{{ _project | default: 'MyProject' }}"
---

# Task Breakdown: {{ _project }} Implementation

Actionable, sequenced implementation tasks derived from the plan.

**Plan Reference**: @./plan.claude.md  
**Specification**: @./specify.claude.md

## Analyze Current State
```
!find . -name "*.ts" -type f | wc -l
!npm test 2>&1 | tail -20
!git log --oneline -5
```

## Phase 1: Foundation
- [ ] **Task 1.1**: [Specific action]
  - [ ] Subtask A
  - [ ] Subtask B
  - Estimated: N hours
  - Owner: [Team member]

- [ ] **Task 1.2**: [Specific action]
  - [ ] Subtask A
  - [ ] Subtask B
  - Estimated: N hours
  - Owner: [Team member]

- [ ] **Task 1.3**: [Specific action]
  - [ ] Subtask A
  - [ ] Subtask B
  - Estimated: N hours
  - Owner: [Team member]

## Phase 2: Core Implementation
- [ ] **Task 2.1**: [Specific action]
  - Blocking: Task 1.1, 1.2
  - Related tests: @./src/[component].test.ts

- [ ] **Task 2.2**: [Specific action]
  - Blocking: Task 2.1
  - Related files: @./src/[module]/**/*.ts

- [ ] **Task 2.3**: [Specific action]
  - Blocking: Task 2.1

## Phase 3: Integration & Testing
- [ ] **Task 3.1**: Integration testing
  - Run: `!npm test`
  - Coverage threshold: 80%

- [ ] **Task 3.2**: Documentation
  - Update README
  - Add examples
  - Document API

- [ ] **Task 3.3**: Review & Deploy
  - Code review checklist
  - Performance testing
  - Deployment plan

## Execution Commands

Start work on a task:
```bash
md implement.claude.md --_project "{{ _project }}" --_task "1.1"
```

Check progress:
```bash
!npm test -- --watch
```

---

**Next**: `md implement.claude.md --_project "{{ _project }}"`
