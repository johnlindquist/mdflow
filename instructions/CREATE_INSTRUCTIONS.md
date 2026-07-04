---
engine: copilot
model: claude-sonnet-4
silent: true
allow-tool:
    - write
interactive: true
---

Create a new copilot instructions file based on a user scenario.

## Steps to perform:

1. **Ask the user**: "Describe the task or workflow you want to automate (e.g., 'set up npm publishing', 'deploy to AWS', 'create a new React component'):"

2. **Ask for the filename**: "What should this instructions file be called? (e.g., SETUP_NPM_PUBLISHING.md, DEPLOY_AWS.md):"

3. **Gather requirements**:
   - "What tools/commands will this task need? (e.g., git, npm, bun, aws, docker)"
   - "Should this be interactive (pause for user input)? (yes/no)"
   - "What model should be used? (claude-haiku-4.5 for simple, claude-sonnet-4 for complex)"

4. **Create the instructions file** with:
   - YAML frontmatter containing:
     - `engine: copilot`
     - `model`: based on complexity
     - `silent: true`
     - `allow-tool`: list of shell commands needed (e.g., `shell(git:*)`, `shell(npm:*)`)
     - `interactive: true` if user input is needed
   - Clear step-by-step instructions for the AI to follow
   - Any user prompts needed (step 0 pattern for gathering info)
   - Verification steps where appropriate

5. **Save the file** to `/Users/johnlindquist/agents/instructions/{filename}`

## Example structure:

```markdown
---
engine: copilot
model: claude-sonnet-4
silent: true
allow-tool:
    - shell(command:*)
    - write
interactive: true
---

Description of what this instructions file does.

## Steps to perform:

0. **Gather information from user**:
   - Ask relevant questions
   - Validate inputs
   - Wait for confirmation before proceeding

1. **First major step**:
   - Sub-step details
   - Commands to run

2. **Second major step**:
   - Sub-step details

3. **Verification**:
   - How to confirm success
```

## Reference files for patterns:
- SETUP_NPM_PUBLISHING.md - Interactive setup with user prompts and browser opening
- CHECK_ACTIONS.md - Interactive CI status checking
