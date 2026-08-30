---
model: opus
_project: "{{ _project | default: 'MyProject' }}"
_team: "{{ _team | default: 'Engineering Team' }}"
---

# Constitution: {{ _project }} Development Principles

Define the core principles and values that will guide all development decisions for this project.

**Project**: {{ _project }}  
**Team**: {{ _team }}  
**Date**: `!date +%Y-%m-%d`

## Current Repository Status
@./.gitignore
@./package.json
@./tsconfig.json:1-20

## Engineering Principles
- Write clean, maintainable code with clear abstractions
- Prioritize readability over cleverness
- Test-driven development for critical paths
- Type safety through TypeScript

## Code Quality Standards
- Consistent naming conventions and code style
- Comprehensive error handling and validation
- Clear documentation for complex logic
- Performance-conscious implementations

## Development Workflow
- Markdown-first specification approach
- Clear separation of concerns
- Incremental development with regular validation
- Peer review and feedback integration

## Team Agreements
```
Lint: `!npm run lint`
Test: `!npm test`
Build: `!npm run build`
```

## User Experience
- Intuitive command-line interfaces
- Clear error messages with actionable guidance
- Fast feedback loops for interactive tools
- Comprehensive help documentation

---

**Next Step**: Run `md specify.claude.md --_project "{{ _project }}"` to define requirements.
