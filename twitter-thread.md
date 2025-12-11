# Getting Started with mdflow - Twitter Thread

## Tweet 1/5 - The Hook
🧵 Want to build powerful AI agents in seconds instead of hours?

mdflow lets you turn simple markdown files into AI agents with superpowers.

No boilerplate. No complex setup. Just markdown + frontmatter.

Here's how easy it is: 👇

## Tweet 2/5 - Simple Start
Start with a file called `debug.claude.md`:

```yaml
---
model: opus
---
Debug this code and fix any issues
```

Run it:
```bash
md debug.claude.md
```

That's it! The `.claude.md` extension tells mdflow to use Claude. The frontmatter becomes `--model opus`.

## Tweet 3/5 - Add Template Power
Now let's make it reusable with templates:

```yaml
---
model: opus
_language: typescript
---
Debug this {{ _language }} code and fix any issues:

{{ _stdin }}
```

Use it:
```bash
cat buggy.ts | md debug.claude.md
# or override the language
md debug.claude.md --_language python < buggy.py
```

## Tweet 4/5 - Import Real Context
Here's where it gets powerful. Import your entire codebase:

```yaml
---
model: opus
---
Review this PR. Here's the context:

@./src/**/*.ts

And the changes:
!`git diff main`

Analyze for bugs, performance issues, and best practices.
```

Globs, command output, even specific functions - all in markdown.

## Tweet 5/5 - Call to Action
mdflow handles:
- 📁 File imports with globs (`@./src/**/*.ts`)
- 🎯 Symbol extraction (`@./file.ts#ClassName`)
- ⚡️ Command output (`` !`git status` ``)
- 🔧 Template variables with LiquidJS
- 🤖 Any AI CLI (Claude, Copilot, Gemini, custom)

Star the repo: https://github.com/johnlindquist/mdflow

Try it:
```bash
npx mdflow setup
md create my-agent
```
