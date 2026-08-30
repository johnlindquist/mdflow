---
model: opus
_project: "{{ _project | default: 'MyProject' }}"
---

# Spec Review: {{ _project }} Consistency & Coverage

Cross-artifact analysis to ensure specs are complete and consistent.

**Constitution**: @./constitution.claude.md  
**Specification**: @./specify.claude.md  
**Plan**: @./plan.claude.md  
**Tasks**: @./tasks.claude.md

## Quality Gates

Analyze all artifacts for:

### Consistency
- [ ] Specification aligns with constitution principles
- [ ] Plan aligns with specification requirements
- [ ] Tasks implement all plan components
- [ ] No contradictions between documents
- [ ] Terminology is consistent

### Coverage
- [ ] All spec requirements mapped to plan sections
- [ ] All plan sections mapped to tasks
- [ ] Success criteria from spec are measurable
- [ ] Risk assessment covers identified challenges
- [ ] All assumptions are documented

### Completeness
- [ ] User stories have acceptance criteria
- [ ] Tasks have clear owners and estimates
- [ ] Dependencies between tasks are identified
- [ ] Integration points are documented
- [ ] Edge cases are addressed

### Clarity
- [ ] Requirements are unambiguous
- [ ] Technical approach is justified
- [ ] Task breakdowns are actionable
- [ ] Success metrics are specific

## Issues Found

Identify and prioritize:

1. **Critical Issues** (blocks implementation)
   - Issue: [description]
   - Location: [spec file and section]
   - Resolution: [recommendation]

2. **Major Issues** (should fix before starting)
   - Issue: [description]
   - Location: [spec file and section]
   - Resolution: [recommendation]

3. **Minor Issues** (nice to address)
   - Issue: [description]
   - Location: [spec file and section]
   - Resolution: [recommendation]

## Recommendations

Suggest improvements:

- [ ] Clarify [specific requirement]
- [ ] Add [missing detail]
- [ ] Simplify [complex section]
- [ ] Document [assumption]
- [ ] Define [edge case]

## Sign-Off Checklist

Before proceeding to implementation:

- [ ] All critical issues resolved
- [ ] Specifications reviewed by team
- [ ] Plan approved by technical lead
- [ ] Tasks assigned to owners
- [ ] No blockers identified
- [ ] Ready to execute

---

**Current Status**: Review in progress

Once all checks pass, proceed with:
```bash
md implement.claude.md --_project "{{ _project }}" --_task "1.1"
```
