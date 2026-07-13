# mdflow.dev — the website

The landing page for [mdflow](https://github.com/johnlindquist/mdflow),
deployed to https://mdflow.dev via Vercel (Root Directory = `site/`).

Imported from the former `johnlindquist/mdflow.dev` repo so the CLI and its
site ship from one place. Site-only commits use the `chore(site):` /
`docs(site):` scopes so semantic-release never cuts a CLI release for a
visual tweak.

## Facts vs art

Factual copy (commands, flags, engines, version badge) renders from
[`src/facts.json`](src/facts.json), which is **generated — do not edit it by
hand**. Regenerate from the CLI source of truth at the repo root:

```bash
bun run facts          # rewrite site/src/facts.json
bun run facts:check    # CI drift gate (fails if stale)
```

Everything else is hand-written. Preserve the positioning and conversion
invariants in the root `CLAUDE.md`: the Hero leads with “Markdown Agents that
Evolve,” the one-flow model supports it, and the full playful maker/workshop
pitch follows the Hero immediately. Its Eggo interaction, animated ticket
track, shaders, and CTA are part of the sales experience, not footer
decoration.

## Run locally

```bash
npm install
npm run dev        # via portless at http://mdflow.localhost:1355
npm run dev:raw    # plain vite on its default port
npm run build      # production build to dist/
```

`GEMINI_API_KEY` in `.env.local` is only needed for features that call
Gemini at runtime; the build itself works without it.
