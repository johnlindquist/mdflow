---
engine: copilot
model: claude-sonnet-4
silent: true
copilot:
  allowed-tools:
    - shell(mkdir:*)
    - shell(bun:*)
    - shell(git:*)
    - shell(npm:*)
    - shell(open:*)
    - write
interactive: true
---

Set up npm Trusted Publishing with GitHub Actions for this project.

## Steps to perform:

0. **Prompt for npm package name**:
   - Ask the user: "What is your npm package name?"
   - Check if the package exists on npm using `npm view {package-name}`
   - If it doesn't exist, ask if they want to create it (they'll need to publish manually first or reserve the name)
   - Ask: "Have you already configured Trusted Publisher for this package on npm? (yes/no)"
   - If no, open `https://www.npmjs.com/package/{package-name}/access` in the browser and instruct them to:
     - Scroll to Trusted Publishers → Connect a new publisher → GitHub
     - Repository owner: (from git remote)
     - Repository name: (from git remote)
     - Workflow filename: release.yml
     - Environment: (leave empty)
   - Wait for user confirmation before proceeding

1. **Create `.github/workflows/release.yml`** with:
   - Trigger on push to main
   - Permissions: `contents: write`, `issues: write`, `id-token: write`
   - Use `actions/checkout@v4`, `oven-sh/setup-bun@v2`
   - Run `bun install` and `bun run build` (if build script exists)
   - Run `bunx semantic-release`

2. **Create `.releaserc.json`** with plugins:
   - @semantic-release/commit-analyzer
   - @semantic-release/release-notes-generator
   - @semantic-release/changelog
   - @semantic-release/npm
   - @semantic-release/github
   - @semantic-release/git (commit CHANGELOG.md and package.json)

3. **Install dependencies**: