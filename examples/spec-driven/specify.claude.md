---
model: opus
_project: "{{ _project | default: 'MyProject' }}"
_interactive: true
---

# Specification: {{ _project }} Requirements

Define what you want to build, focusing on the **what** and **why**, not the technical details.

**Status**: Interactive workshop  
**Reference**: @./constitution.claude.md

## Feature Overview

Describe the problem your feature solves:

```
What problem are we solving?
Who has this problem?
Why is it valuable?
```

## User Stories

### Story 1: Core User Journey
**As a [user type], I want to [action] so that [outcome]**

- Acceptance criteria 1
- Acceptance criteria 2
- Acceptance criteria 3

### Story 2: Advanced Usage
**As a [power user], I want to [action] so that [outcome]**

- Acceptance criteria 1
- Acceptance criteria 2

### Story 3: Integration Points
**As a [developer], I want to [action] so that [outcome]**

- Acceptance criteria 1
- Acceptance criteria 2

## Clarification Questions (if needed)

Run this for deeper analysis:
```
md clarify.claude.md --_project "{{ _project }}"
```

## Success Metrics
- [ ] User can accomplish [key outcome]
- [ ] Performance meets [criteria]
- [ ] Edge case [X] handled gracefully
- [ ] Documentation complete

## Out of Scope
- Feature X (why?)
- Feature Y (why?)
- Future: Feature Z

---

**Next Step**: Once requirements are clear, run:
```bash
md plan.claude.md --_project "{{ _project }}"
```

This specification will be imported by downstream agents.
