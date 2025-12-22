---
model: opus
_project: "{{ _project | default: 'MyProject' }}"
_tech_stack: "{{ _tech_stack | default: 'TypeScript + Bun' }}"
---

# Implementation Plan: {{ _project }}

Technical architecture and implementation approach based on requirements.

**Technology Stack**: {{ _tech_stack }}  
**Reference Spec**: @./specify.claude.md

## Current Project Analysis
```
Dependencies:
!npm list --depth=0

Build config:
!cat package.json | grep -A 5 '"scripts"'

Existing architecture:
!find src -type f -name "*.ts" | head -20
```

## Architecture Overview

### Core Components
1. **[Component A]**: Purpose and responsibilities
2. **[Component B]**: Purpose and responsibilities
3. **[Component C]**: Purpose and responsibilities

### Data Flow Diagram
```
Input
  ↓
[Process]
  ↓
Output
```

### Technology Decisions
| Decision | Choice | Reasoning |
|----------|--------|-----------|
| Runtime | {{ _tech_stack }} | [Why?] |
| Language | TypeScript | Type safety |
| Framework | [X] | [Why?] |

## Implementation Approach

### Phase 1: Foundation
- Set up project structure
- Configure tooling
- Establish patterns

### Phase 2: Core Features
- Feature A
- Feature B
- Feature C

### Phase 3: Integration
- Connect components
- End-to-end testing
- Documentation

## Risk Assessment
| Risk | Mitigation |
|------|-----------|
| [Risk] | [Plan] |

---

**Usage**: Import this plan into `tasks.claude.md`:
```
@./plan.claude.md
```

**Next**: `md tasks.claude.md --_project "{{ _project }}"`
