---
model: opus
_project: "{{ _project | default: 'MyProject' }}"
_interactive: true
---

# Clarification Workshop: {{ _project }}

Interactive session to clarify underspecified areas before planning.

**Specification**: @./specify.claude.md

## Analysis

Review current specification:
@./specify.claude.md

## Clarifying Questions

Based on the specification above, ask clarifying questions about:

1. **User Impact**
   - Who is the primary user?
   - What problem does this solve for them?
   - What's the expected outcome?

2. **Scope & Constraints**
   - What's explicitly in scope?
   - What's explicitly out of scope?
   - Are there technical constraints?

3. **Success Criteria**
   - How will we measure success?
   - What are the non-negotiables?
   - What's nice-to-have?

4. **Dependencies & Integration**
   - What systems does this interact with?
   - Are there integration points?
   - Any external APIs or services?

5. **Timeline & Resources**
   - How quickly do we need this?
   - Who's available to work on it?
   - Are there blocking dependencies?

## Output

Generate a clarification summary that:
- Resolves ambiguities from the specification
- Documents key assumptions
- Highlights areas needing more definition
- Ready to pass to `md plan.claude.md`

---

**Next**: After clarifications are resolved, run:
```bash
md plan.claude.md --_project "{{ _project }}"
```
