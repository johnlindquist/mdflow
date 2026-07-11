# Codex lifecycle-hooks empirical probe

- Codex under test: `codex-cli 0.144.1`
- Probe date: 2026-07-10
- Probe root: `/private/tmp/claude-501/-Users-johnlindquist-dev-mdflow/0f13f75c-ef37-4a85-bd8c-73fe70abeeed/scratchpad/probe`
- Safety boundary: every writable `CODEX_HOME`, hook, log, capture, and child working directory is under the probe root. The real `~/.codex/auth.json` is only symlinked into isolated homes. The real `~/.codex/hooks.json` and `~/.codex/config.toml` were read only.

Reference inspection found that the real `~/.codex/hooks.json` uses PascalCase keys `SessionStart`, `UserPromptSubmit`, and `Stop`. Its top-level shape is `{ "hooks": { EVENT: [...] } }`. The real trust records use normalized snake-case event names inside `[hooks.state]`, for example `...:session_start:0:0` and `...:user_prompt_submit:0:0`.

The raw version/help receipt and sanitized reference key/state extracts are preserved as `probe/codex-version.txt`, `probe/codex-exec-help.txt`, `probe/reference-real-hook-keys.json`, and `probe/reference-real-hook-state-lines.txt`.

## Q1 — Trust

**VERDICT:** With a fresh isolated `CODEX_HOME`, valid user-level `hooks.json`, and no `[hooks.state]` entries, `codex exec` silently skipped every hook and still exited 0. Adding `--dangerously-bypass-hook-trust` made `SessionStart`, `UserPromptSubmit`, and `Stop` all fire. The bypass run printed an explicit warning twice. The no-bypass run printed no hook-trust warning at all.

The isolated `config.toml` contained only:

```toml
# Intentionally no [hooks.state] table and no project trust entry.
```

Exact no-bypass command:

```sh
env CODEX_HOME=/private/tmp/claude-501/-Users-johnlindquist-dev-mdflow/0f13f75c-ef37-4a85-bd8c-73fe70abeeed/scratchpad/probe/q1-q2-q4/homes/q1 \
  HOOK_EVENTS=/private/tmp/claude-501/-Users-johnlindquist-dev-mdflow/0f13f75c-ef37-4a85-bd8c-73fe70abeeed/scratchpad/probe/q1-q2-q4/cases/q1-no-bypass/events.ndjson \
  HOOK_META=/private/tmp/claude-501/-Users-johnlindquist-dev-mdflow/0f13f75c-ef37-4a85-bd8c-73fe70abeeed/scratchpad/probe/q1-q2-q4/cases/q1-no-bypass/hook-meta.txt \
  codex exec --color never --skip-git-repo-check \
  -C /private/tmp/claude-501/-Users-johnlindquist-dev-mdflow/0f13f75c-ef37-4a85-bd8c-73fe70abeeed/scratchpad/probe/q1-q2-q4/cwd \
  'Reply with the word ok'
```

Evidence: exit status `0`, stdout `ok`, ordinary run header/answer on stderr, no warning, and no `hook:` lines. Both `events.ndjson` and `hook-meta.txt` are exactly 0 bytes: the hooks **did not fire** rather than firing with empty stdin.

The bypass command was identical with `--dangerously-bypass-hook-trust`. Relevant stderr:

```text
warning: `--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation.
warning: `--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation.
hook: SessionStart
hook: SessionStart Completed
hook: UserPromptSubmit
hook: UserPromptSubmit Completed
codex
ok
hook: Stop
hook: Stop Completed
```

That run exited 0 and produced exactly three non-empty lines in `cases/q1-bypass/events.ndjson`, whose `hook_event_name` values were `SessionStart`, `UserPromptSubmit`, and `Stop` in that order. Full commands and captures are in `probe/q1-q2-q4/cases/q1-*`.

## Q2 — Isolation flags

**VERDICT:** `--ignore-user-config` does **not** skip `$CODEX_HOME/hooks.json`; all registered user hooks still loaded. `--ephemeral` also does **not** disable hooks. Ephemeral mode changes hook payload `transcript_path` to JSON `null` and does not persist a session rollout.

Both tests used the Q1 user hooks plus `--dangerously-bypass-hook-trust` and exited 0 with stdout `ok`.

```sh
codex exec --color never --skip-git-repo-check \
  -C /private/tmp/claude-501/-Users-johnlindquist-dev-mdflow/0f13f75c-ef37-4a85-bd8c-73fe70abeeed/scratchpad/probe/q1-q2-q4/cwd \
  --dangerously-bypass-hook-trust --ignore-user-config 'Reply with the word ok'
```

The ignore-user-config capture shows all six start/completion lines for `SessionStart`, `UserPromptSubmit`, and `Stop`, and `cases/q2-ignore-user-config/events.ndjson` has three non-empty payloads. That directly proves the hooks file was loaded.

The separate ephemeral command replaced `--ignore-user-config` with `--ephemeral`. It also showed all three hooks and three payloads. Representative payload:

```json
{"session_id":"019f4dbc-afa3-7260-a166-37dd338959a8","transcript_path":null,"cwd":"/private/tmp/claude-501/-Users-johnlindquist-dev-mdflow/0f13f75c-ef37-4a85-bd8c-73fe70abeeed/scratchpad/probe/q1-q2-q4/cwd","hook_event_name":"SessionStart","model":"gpt-5.6-sol","permission_mode":"bypassPermissions","source":"startup"}
```

No `sessions/.../rollout-*.jsonl` exists in that ephemeral home. Raw captures are in `probe/q1-q2-q4/cases/q2-*`.

## Q3 — Payloads

**VERDICT:** In the requested tool-use run, exactly five hooks fired once each with non-empty stdin: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, and `Stop`. Configured `SessionEnd` did not fire at all. A separate `AgentTurnComplete` registration was silently non-operative. The five raw inputs are preserved byte-for-byte, one line each, in `probe/q3-q9/main-logs/events.ndjson`.

Canonical command (exit 0):

```sh
CODEX_HOME="$PWD/probe/q3-q9/home-main" codex exec \
  --skip-git-repo-check --dangerously-bypass-hook-trust \
  -C "$PWD/probe/q3-q9/work" \
  'Run the shell command `echo hi` then reply done.'
```

`home-main/hooks.json` registered PascalCase `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, and `SessionEnd`. Stdout was exactly `Done.`. Relevant stderr:

```text
session id: 019f4dbb-f2b6-7901-bf65-a92e5054be8c
warning: `--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation.
warning: `--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation.
hook: SessionStart
hook: SessionStart Completed
hook: UserPromptSubmit
hook: UserPromptSubmit Completed
hook: PreToolUse
hook: PreToolUse Completed
exec
/bin/zsh -lc 'echo hi' in .../probe/q3-q9/work
 succeeded in 0ms:
hi
hook: PostToolUse
hook: PostToolUse Completed
hook: Stop
hook: Stop Completed
```

Exact raw stdin, in firing order:

```jsonl
{"session_id":"019f4dbb-f2b6-7901-bf65-a92e5054be8c","transcript_path":"/private/tmp/claude-501/-Users-johnlindquist-dev-mdflow/0f13f75c-ef37-4a85-bd8c-73fe70abeeed/scratchpad/probe/q3-q9/home-main/sessions/2026/07/10/rollout-2026-07-10T14-33-10-019f4dbb-f2b6-7901-bf65-a92e5054be8c.jsonl","cwd":"/private/tmp/claude-501/-Users-johnlindquist-dev-mdflow/0f13f75c-ef37-4a85-bd8c-73fe70abeeed/scratchpad/probe/q3-q9/work","hook_event_name":"SessionStart","model":"gpt-5.6-sol","permission_mode":"bypassPermissions","source":"startup"}
{"session_id":"019f4dbb-f2b6-7901-bf65-a92e5054be8c","turn_id":"019f4dbb-f791-7091-be4f-e35db88eb89e","transcript_path":"/private/tmp/claude-501/-Users-johnlindquist-dev-mdflow/0f13f75c-ef37-4a85-bd8c-73fe70abeeed/scratchpad/probe/q3-q9/home-main/sessions/2026/07/10/rollout-2026-07-10T14-33-10-019f4dbb-f2b6-7901-bf65-a92e5054be8c.jsonl","cwd":"/private/tmp/claude-501/-Users-johnlindquist-dev-mdflow/0f13f75c-ef37-4a85-bd8c-73fe70abeeed/scratchpad/probe/q3-q9/work","hook_event_name":"UserPromptSubmit","model":"gpt-5.6-sol","permission_mode":"bypassPermissions","prompt":"Run the shell command `echo hi` then reply done."}
{"session_id":"019f4dbb-f2b6-7901-bf65-a92e5054be8c","turn_id":"019f4dbb-f791-7091-be4f-e35db88eb89e","transcript_path":"/private/tmp/claude-501/-Users-johnlindquist-dev-mdflow/0f13f75c-ef37-4a85-bd8c-73fe70abeeed/scratchpad/probe/q3-q9/home-main/sessions/2026/07/10/rollout-2026-07-10T14-33-10-019f4dbb-f2b6-7901-bf65-a92e5054be8c.jsonl","cwd":"/private/tmp/claude-501/-Users-johnlindquist-dev-mdflow/0f13f75c-ef37-4a85-bd8c-73fe70abeeed/scratchpad/probe/q3-q9/work","hook_event_name":"PreToolUse","model":"gpt-5.6-sol","permission_mode":"bypassPermissions","tool_name":"Bash","tool_input":{"command":"echo hi"},"tool_use_id":"exec-172ae5d8-a79a-4dc7-9739-c87146a3c53f"}
{"session_id":"019f4dbb-f2b6-7901-bf65-a92e5054be8c","turn_id":"019f4dbb-f791-7091-be4f-e35db88eb89e","transcript_path":"/private/tmp/claude-501/-Users-johnlindquist-dev-mdflow/0f13f75c-ef37-4a85-bd8c-73fe70abeeed/scratchpad/probe/q3-q9/home-main/sessions/2026/07/10/rollout-2026-07-10T14-33-10-019f4dbb-f2b6-7901-bf65-a92e5054be8c.jsonl","cwd":"/private/tmp/claude-501/-Users-johnlindquist-dev-mdflow/0f13f75c-ef37-4a85-bd8c-73fe70abeeed/scratchpad/probe/q3-q9/work","hook_event_name":"PostToolUse","model":"gpt-5.6-sol","permission_mode":"bypassPermissions","tool_name":"Bash","tool_input":{"command":"echo hi"},"tool_response":"hi\n","tool_use_id":"exec-172ae5d8-a79a-4dc7-9739-c87146a3c53f"}
{"session_id":"019f4dbb-f2b6-7901-bf65-a92e5054be8c","turn_id":"019f4dbb-f791-7091-be4f-e35db88eb89e","transcript_path":"/private/tmp/claude-501/-Users-johnlindquist-dev-mdflow/0f13f75c-ef37-4a85-bd8c-73fe70abeeed/scratchpad/probe/q3-q9/home-main/sessions/2026/07/10/rollout-2026-07-10T14-33-10-019f4dbb-f2b6-7901-bf65-a92e5054be8c.jsonl","cwd":"/private/tmp/claude-501/-Users-johnlindquist-dev-mdflow/0f13f75c-ef37-4a85-bd8c-73fe70abeeed/scratchpad/probe/q3-q9/work","hook_event_name":"Stop","model":"gpt-5.6-sol","permission_mode":"bypassPermissions","stop_hook_active":false,"last_assistant_message":"Done."}
```

The capture program also measured that these stdin values had no trailing newline; byte lengths were `531`, `625`, `671`, `695`, and `611` respectively.

`SessionEnd` is not merely “empty”: there is no sixth event line, no invocation metadata row, and no stderr lifecycle line. A second run registered a known-good `SessionStart` sentinel plus `AgentTurnComplete`; only SessionStart fired, with no parse warning. Empirically, neither `SessionEnd` nor `AgentTurnComplete` was operative in these 0.144.1 exec runs; both keys were silently ignored. Raw main, agent-control, stdout, stderr, status, and invocation captures are under `probe/q3-q9/`.

## Q4 — Event-name casing

**VERDICT:** Use PascalCase keys such as `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, and `Stop`. The real read-only `~/.codex/hooks.json` uses PascalCase for its three configured events; isolated PascalCase fixtures fired all five named event types across Q3/Q4. An otherwise identical fixture using `session_start`, `user_prompt_submit`, and `stop` silently fired zero hooks. Snake-case trust-record identifiers in `config.toml` do not imply snake-case `hooks.json` keys.

Read-only reference command and exact captured output:

```sh
jq -c '.hooks | keys' ~/.codex/hooks.json
```

```json
["SessionStart","Stop","UserPromptSubmit"]
```

The output is preserved in `probe/reference-real-hook-keys.json`; normalized trust-table names are preserved in `probe/reference-real-hook-state-lines.txt`.

Both isolated tests used the bypass flag, exited 0, and returned `ok`. The PascalCase run showed:

```text
hook: SessionStart
hook: SessionStart Completed
hook: UserPromptSubmit
hook: UserPromptSubmit Completed
hook: Stop
hook: Stop Completed
```

Its event file has three non-empty payloads. The snake-case run showed only the two bypass warnings and the model answer—no hook lifecycle lines, no config error—and both its event and metadata logs are exactly 0 bytes. Fixtures and raw captures are in `probe/q1-q2-q4/homes/q4-*` and `probe/q1-q2-q4/cases/q4-*`.

## Q5 — Blocking

**VERDICT:** In exec mode, a `UserPromptSubmit` hook exiting 2 blocks the model turn, but the parent `codex exec` still exits **0**. Its stdout is empty and the hook's own stderr is suppressed; the visible indication is `hook: UserPromptSubmit Blocked`. Separately, a Stop hook emitting `{"decision":"block","reason":"..."}` forces another model continuation and another Stop invocation.

### UserPromptSubmit exit 2

The hook consumed and logged stdin, printed `Q5_USER_PROMPT_EXIT_2_DISTINCTIVE_STDERR` to stderr, then exited 2. Command:

```sh
Q5_USER_EVENTS="$PWD/q5-user-block/events.ndjson" \
CODEX_HOME="$PWD/q5-user-block/home" \
codex exec --skip-git-repo-check --dangerously-bypass-hook-trust --color never \
  -C "$PWD/q5-user-block/cwd" "Reply with the word ok" \
  > q5-user-block/stdout.txt 2> q5-user-block/stderr.txt
```

Observed status `0`; stdout was exactly 0 bytes. Relevant stderr:

```text
user
Reply with the word ok
warning: `--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation.
warning: `--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation.
hook: UserPromptSubmit
hook: UserPromptSubmit Blocked
```

Exact raw stdin proves the hook did fire:

```json
{"session_id":"019f4dbb-c3d7-7231-b156-48fc83ac026c","turn_id":"019f4dbb-c79c-7fa0-b852-71247774e780","transcript_path":"/private/tmp/claude-501/-Users-johnlindquist-dev-mdflow/0f13f75c-ef37-4a85-bd8c-73fe70abeeed/scratchpad/probe/q5-q6/q5-user-block/home/sessions/2026/07/10/rollout-2026-07-10T14-32-58-019f4dbb-c3d7-7231-b156-48fc83ac026c.jsonl","cwd":"/private/tmp/claude-501/-Users-johnlindquist-dev-mdflow/0f13f75c-ef37-4a85-bd8c-73fe70abeeed/scratchpad/probe/q5-q6/q5-user-block/cwd","hook_event_name":"UserPromptSubmit","model":"gpt-5.6-sol","permission_mode":"bypassPermissions","prompt":"Reply with the word ok"}
```

The distinctive stderr marker appears nowhere in the captured CLI streams or session transcript.

### Stop decision block

The Stop hook emitted this exact line on its first invocation, then `{}` on its second:

```json
{"decision":"block","reason":"Q5_STOP_BLOCK_ONCE: continue and reply with the word continued"}
```

Command:

```sh
Q5_STOP_EVENTS="$PWD/q5-stop-block/events.ndjson" \
Q5_STOP_SENTINEL="$PWD/q5-stop-block/block-once.sentinel" \
CODEX_HOME="$PWD/q5-stop-block/home" \
codex exec --skip-git-repo-check --dangerously-bypass-hook-trust --color never \
  -o "$PWD/q5-stop-block/last-message.txt" \
  -C "$PWD/q5-stop-block/cwd" "Reply with the exact word first"
```

Relevant stderr:

```text
codex
first
hook: Stop
hook: Stop Blocked
codex
continued
hook: Stop
hook: Stop Completed
tokens used
6,188
```

Parent status was 0. Both final stdout and `--output-last-message` contained `continued`. The two exact Stop inputs were:

```jsonl
{"session_id":"019f4dbc-587e-7c21-9029-4f84f053ed2c","turn_id":"019f4dbc-5d95-7523-8fb4-dbe31510fc2d","transcript_path":"/private/tmp/claude-501/-Users-johnlindquist-dev-mdflow/0f13f75c-ef37-4a85-bd8c-73fe70abeeed/scratchpad/probe/q5-q6/q5-stop-block/home/sessions/2026/07/10/rollout-2026-07-10T14-33-36-019f4dbc-587e-7c21-9029-4f84f053ed2c.jsonl","cwd":"/private/tmp/claude-501/-Users-johnlindquist-dev-mdflow/0f13f75c-ef37-4a85-bd8c-73fe70abeeed/scratchpad/probe/q5-q6/q5-stop-block/cwd","hook_event_name":"Stop","model":"gpt-5.6-sol","permission_mode":"bypassPermissions","stop_hook_active":false,"last_assistant_message":"first"}
{"session_id":"019f4dbc-587e-7c21-9029-4f84f053ed2c","turn_id":"019f4dbc-5d95-7523-8fb4-dbe31510fc2d","transcript_path":"/private/tmp/claude-501/-Users-johnlindquist-dev-mdflow/0f13f75c-ef37-4a85-bd8c-73fe70abeeed/scratchpad/probe/q5-q6/q5-stop-block/home/sessions/2026/07/10/rollout-2026-07-10T14-33-36-019f4dbc-587e-7c21-9029-4f84f053ed2c.jsonl","cwd":"/private/tmp/claude-501/-Users-johnlindquist-dev-mdflow/0f13f75c-ef37-4a85-bd8c-73fe70abeeed/scratchpad/probe/q5-q6/q5-stop-block/cwd","hook_event_name":"Stop","model":"gpt-5.6-sol","permission_mode":"bypassPermissions","stop_hook_active":true,"last_assistant_message":"continued"}
```

The sentinel made the second invocation allow completion, avoiding an intentional infinite continuation loop. Raw Q5 evidence is under `probe/q5-q6/q5-*`.

## Q6 — `-c` override injection

**VERDICT:** **Yes.** Codex 0.144.1 accepts complete hook definitions via `-c` with no `hooks.json`. Both a dotted PascalCase event override and a top-level inline `hooks` table worked, with and without `--strict-config`:

```text
hooks.UserPromptSubmit=[{hooks=[{type="command",command="/ABS/PATH/q6-logger.sh",timeout=5}]}]
hooks={UserPromptSubmit=[{hooks=[{type="command",command="/ABS/PATH/q6-logger.sh",timeout=5}]}]}
```

The nesting is mandatory: event -> group/matcher list -> each group's `hooks` command list. These two variants silently did nothing, even with `--strict-config`:

```text
hooks.user_prompt_submit=[{hooks=[{type="command",command="/ABS/PATH/q6-logger.sh",timeout=5}]}]
hooks.UserPromptSubmit=[{type="command",command="/ABS/PATH/q6-logger.sh",timeout=5}]
```

A separate no-`hooks.json` control confirmed that one inline table can inject multiple events at once:

```text
hooks={SessionStart=[{hooks=[{type="command",command="/ABS/PATH/session-start.sh",timeout=10}]}],UserPromptSubmit=[{hooks=[{type="command",command="/ABS/PATH/user-prompt.sh",timeout=10}]}]}
```

That run logged one SessionStart and one UserPromptSubmit invocation; the latter deliberately exited 2, so the model was blocked and no tokens were spent on an answer. Status was still 0. The exact invocation is preserved in `probe/q6-multi-inline/command.txt`, the absent-file receipt in `hooks-json-presence.txt`, and all raw outputs beside them.

Representative working command, whose isolated home had `auth.json` but no `hooks.json`:

```sh
override='hooks.UserPromptSubmit=[{hooks=[{type="command",command="/private/tmp/claude-501/-Users-johnlindquist-dev-mdflow/0f13f75c-ef37-4a85-bd8c-73fe70abeeed/scratchpad/probe/q5-q6/scripts/q6-logger.sh",timeout=5}]}]'
Q6_EVENTS="$PWD/events.ndjson" CODEX_HOME="$PWD/home" \
codex exec --skip-git-repo-check --dangerously-bypass-hook-trust --color never \
  -c "$override" -C "$PWD/cwd" "Reply with the word ok"
```

Observed status 0 and stderr:

```text
hook: UserPromptSubmit
hook: UserPromptSubmit Completed
codex
ok
tokens used
5,632
```

The actual captured payload was:

```json
{"session_id":"019f4dbe-4cad-7e90-bfb3-350b684f1250","turn_id":"019f4dbe-5138-7b50-81c2-490a3cd62929","transcript_path":"/private/tmp/claude-501/-Users-johnlindquist-dev-mdflow/0f13f75c-ef37-4a85-bd8c-73fe70abeeed/scratchpad/probe/q5-q6/q6-overrides/dotted-camel/home/sessions/2026/07/10/rollout-2026-07-10T14-35-44-019f4dbe-4cad-7e90-bfb3-350b684f1250.jsonl","cwd":"/private/tmp/claude-501/-Users-johnlindquist-dev-mdflow/0f13f75c-ef37-4a85-bd8c-73fe70abeeed/scratchpad/probe/q5-q6/q6-overrides/dotted-camel/cwd","hook_event_name":"UserPromptSubmit","model":"gpt-5.6-sol","permission_mode":"bypassPermissions","prompt":"Reply with the word ok"}
```

Full final matrix:

```text
direct-list                        rc=0 fired=no
direct-list-strict                 rc=0 fired=no
dotted-camel                       rc=0 fired=yes
dotted-camel-strict                rc=0 fired=yes
dotted-snake                       rc=0 fired=no
dotted-snake-strict                rc=0 fired=no
inline-table                       rc=0 fired=yes
inline-table-strict                rc=0 fired=yes
```

Every case's `hooks.json` presence receipt says `ABSENT`. Therefore a wrapper does not need a temporary hooks file merely to inject a hook. Raw evidence is under `probe/q5-q6/q6-overrides/`; files prefixed `pre-chmod` are discarded harness attempts and are not used above.

### Aggregation/isolation control

CLI injection does **not** replace an existing `$CODEX_HOME/hooks.json`; the sources aggregate. This was tested in four fresh homes whose file configured logger A for `SessionStart` and `UserPromptSubmit`, while CLI logger B injected another `UserPromptSubmit` and exited 2:

| CLI form | `--ignore-user-config` | File A SessionStart | File A UserPromptSubmit | CLI B UserPromptSubmit |
|---|---:|---:|---:|---:|
| dotted event | no | 1 | 1 | 1 |
| top-level inline table | no | 1 | 1 | 1 |
| dotted event | yes | 1 | 1 | 1 |
| top-level inline table | yes | 1 | 1 | 1 |

All four exited 0 with empty stdout because B blocked the model. Typical stderr was:

```text
hook: SessionStart
hook: SessionStart Completed
hook: UserPromptSubmit
hook: UserPromptSubmit
hook: UserPromptSubmit Completed
hook: UserPromptSubmit Blocked
```

Thus neither `-c hooks.UserPromptSubmit=...`, `-c hooks={...}`, nor `--ignore-user-config` suppresses ambient JSON hooks; same-event hooks run side by side and unrelated file events survive. CLI injection eliminates the need to generate a hooks file, but a temporary `CODEX_HOME` is still needed when the wrapper requires true isolation from the user's hooks. Exact commands and unabridged A/B inputs are under `probe/q6-isolation/cases/`.

## Q7 — Repo-local hooks

**VERDICT:** `<cwd>/.codex/hooks.json` does load under `codex exec`, but only when the project is trusted. `--dangerously-bypass-hook-trust` did **not** bypass project trust. In fresh homes with no `[hooks.state]`, trusted-without-bypass did not fire, while trusted-with-bypass did. Persisted-hash execution was not separately tested.

The repo hook registered `SessionStart`, `UserPromptSubmit`, and `Stop`; all three commands pointed at `probe/q7-repo-local/shared/logger.sh`. Four isolated homes were tested against the same `-C` directory. The two trusted homes contained:

```toml
[projects."/private/tmp/claude-501/-Users-johnlindquist-dev-mdflow/0f13f75c-ef37-4a85-bd8c-73fe70abeeed/scratchpad/probe/q7-repo-local/shared/cwd"]
trust_level = "trusted"
```

The exact command pattern was:

```sh
CODEX_HOME="$PWD/probe/q7-repo-local/homes/<case>" \
  codex exec [--dangerously-bypass-hook-trust] --skip-git-repo-check \
  -C "$PWD/probe/q7-repo-local/shared/cwd" "Reply with the word ok"
```

Observed matrix (every child exited 0 and printed `ok`):

| Project trusted | Hook-trust bypass | Hook log | Relevant stderr |
|---|---:|---:|---|
| no | no | absent | `sandbox: read-only`; no hook warning |
| no | yes | absent | bypass warning printed twice; still no hook lifecycle lines |
| yes | no | absent | `sandbox: workspace-write`; no hook warning |
| yes | yes | 3 lines | SessionStart, UserPromptSubmit, Stop all completed |

The successful case's stderr includes:

```text
warning: `--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation.
warning: `--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation.
hook: SessionStart
hook: SessionStart Completed
hook: UserPromptSubmit
hook: UserPromptSubmit Completed
codex
ok
hook: Stop
hook: Stop Completed
```

Its exact three payloads are preserved in `probe/q7-repo-local/events-trusted-bypass.ndjson`. The first begins:

```json
{"session_id":"019f4dbc-8d41-72a3-9a30-7a96e2e8ac92","transcript_path":"/private/tmp/claude-501/-Users-johnlindquist-dev-mdflow/0f13f75c-ef37-4a85-bd8c-73fe70abeeed/scratchpad/probe/q7-repo-local/homes/trusted-bypass/sessions/2026/07/10/rollout-2026-07-10T14-33-50-019f4dbc-8d41-72a3-9a30-7a96e2e8ac92.jsonl","cwd":"/private/tmp/claude-501/-Users-johnlindquist-dev-mdflow/0f13f75c-ef37-4a85-bd8c-73fe70abeeed/scratchpad/probe/q7-repo-local/shared/cwd","hook_event_name":"SessionStart","model":"gpt-5.6-sol","permission_mode":"bypassPermissions","source":"startup"}
```

The hook command's actual `pwd` was the `-C` directory for all three invocations. Raw stdout, stderr, status, event, and cwd files are under `probe/q7-repo-local/`.

## Q8 — Timeout and ordinary failure

**VERDICT:** For the tested `UserPromptSubmit` event, a hook exiting 1 and a hook exceeding its configured timeout both failed open. Codex labeled the hook `Failed`, continued to the model, printed the requested answer, and exited 0. The hook's own stderr was not relayed; the visible diagnostic was only the generic lifecycle failure line. The timed-out process was terminated before its post-sleep marker ran.

Exit-1 command:

```sh
CODEX_HOME="$PWD/probe/q8-failure-timeout/homes/exit1" \
  codex exec --dangerously-bypass-hook-trust --skip-git-repo-check \
  -C "$PWD/probe/q8-failure-timeout/shared/cwd" "Reply with the word ok"
```

The `UserPromptSubmit` script recorded stdin, wrote `EXIT1_SENTINEL: deliberate hook failure` to stderr, and exited 1. Captured result:

```text
status=0 elapsed=5s
hook: UserPromptSubmit
hook: UserPromptSubmit Failed
codex
ok
```

`exit1.stdout` contains `ok`. `exit1.stderr` does **not** contain `EXIT1_SENTINEL`; Codex suppressed the hook's stderr in this UI. The hook definitely fired: `exit1-events.ndjson` has one complete `UserPromptSubmit` payload.

Timeout command used the same invocation pattern with home `homes/timeout`. Its hook object contained `"timeout": 2`; the script logged `START <epoch>`, slept 5 seconds, then would log `END <epoch>`.

```text
status=0 elapsed=7s
hook: UserPromptSubmit
hook: UserPromptSubmit Failed
codex
ok
```

`timeout.stdout` contains `ok`, `timeout-events.ndjson` has the full input payload, and `timeout-timing.log` contains only:

```text
START 1783715687
```

There was no `END` marker and no remaining `timeout.sh`/`sleep 5` process after the child completed. This distinguishes “fired then timed out/killed” from “did not fire.” Raw evidence is under `probe/q8-failure-timeout/`.

## Q9 — Hook cwd and environment

**VERDICT:** Hook commands run with process cwd exactly equal to the `codex exec -C <dir>` directory. Hooks inherit ambient `CODEX_*` variables, including the explicitly set per-run `CODEX_HOME`; the npm launcher adds its two `CODEX_MANAGED_*` values. Codex does not synthesize a reliable child-session `CODEX_THREAD_ID`. Use stdin `session_id` as the session identity.

For all five Q3 invocations, the capture program reported:

```text
/private/tmp/claude-501/-Users-johnlindquist-dev-mdflow/0f13f75c-ef37-4a85-bd8c-73fe70abeeed/scratchpad/probe/q3-q9/work
```

That exactly matches the canonical command's `-C` argument. Every hook in that nested-launch run saw the same full `CODEX_*` set:

```json
{
  "CODEX_AGENT_ENV_SOURCED": "1",
  "CODEX_CI": "1",
  "CODEX_COMPANION_SESSION_ID": "6a53f592-af3a-4de2-9188-d4b2df314f2c",
  "CODEX_HOME": "/private/tmp/claude-501/-Users-johnlindquist-dev-mdflow/0f13f75c-ef37-4a85-bd8c-73fe70abeeed/scratchpad/probe/q3-q9/home-main",
  "CODEX_LOAD_ZSH_DSL": "1",
  "CODEX_MANAGED_BY_NPM": "1",
  "CODEX_MANAGED_PACKAGE_ROOT": "/Users/johnlindquist/.npm-global/lib/node_modules/@openai/codex",
  "CODEX_THREAD_ID": "019f4dba-1060-72c1-b65b-2b0d87654f43"
}
```

The same records correlate that env value with stdin session `019f4dbb-f2b6-7901-bf65-a92e5054be8c`; they are different. The `CODEX_THREAD_ID` was already exported by the parent launcher, so the child inherited it unchanged. The hook likewise inherited the `CODEX_HOME` value explicitly set on the child command.

A clean-launch control explicitly removed every ambient `CODEX_*` variable, then set only isolated `CODEX_HOME` and ran a SessionStart hook. Its complete captured set was:

```json
{
  "CODEX_HOME": "/private/tmp/claude-501/-Users-johnlindquist-dev-mdflow/0f13f75c-ef37-4a85-bd8c-73fe70abeeed/scratchpad/probe/q3-q9/home-cleanenv",
  "CODEX_MANAGED_BY_NPM": "1",
  "CODEX_MANAGED_PACKAGE_ROOT": "/Users/johnlindquist/.npm-global/lib/node_modules/@openai/codex"
}
```

The npm launcher added the two `CODEX_MANAGED_*` variables; there was no `CODEX_THREAD_ID`, `CODEX_SESSION_ID`, or other hook-specific session variable. The full correlated records—including cwd, env, stdin byte count, newline flag, and exact stdin—are in `probe/q3-q9/main-logs/invocations.ndjson` and `probe/q3-q9/cleanenv-logs/invocations.ndjson`.

## Summary for implementers

For a wrapper that needs deterministic, isolated per-run hooks, the minimal reliable 0.144.1 recipe is:

1. Create a fresh temporary `CODEX_HOME`.
2. Symlink only the real auth file into it: `ln -s ~/.codex/auth.json "$TEMP_HOME/auth.json"`.
3. Keep that home's `hooks.json` and `config.toml` absent unless the wrapper intentionally owns them.
4. Inject the complete hook table with one CLI override, using PascalCase event names and the required group nesting.
5. Pass `--dangerously-bypass-hook-trust`; otherwise fresh/unhashed hooks are silently skipped.
6. Use absolute hook command paths. Hook processes run from the `-C` directory, not from `CODEX_HOME` or the hook script's directory.
7. Log an independent wrapper receipt. Codex itself can exit 0 when a hook fails, times out, or blocks the prompt, and malformed/case-wrong hook definitions can silently no-op.

Concrete shape, validated with both events in a single `-c` value:

```sh
TEMP_HOME="$(mktemp -d "$RUN_ROOT/codex-home.XXXXXX")"
ln -s "$HOME/.codex/auth.json" "$TEMP_HOME/auth.json"

HOOKS_TOML='hooks={SessionStart=[{hooks=[{type="command",command="/absolute/path/session-start.sh",timeout=5}]}],UserPromptSubmit=[{hooks=[{type="command",command="/absolute/path/user-prompt-submit.sh",timeout=5}]}]}'

CODEX_HOME="$TEMP_HOME" codex exec \
  --dangerously-bypass-hook-trust \
  --skip-git-repo-check \
  -c "$HOOKS_TOML" \
  -C "$TARGET_CWD" \
  "$PROMPT"
```

Programmatically TOML-escape every command string; do not build the value by unsafe shell interpolation. A generated `hooks.json` is **not required** for injection. The temporary home **is still required for isolation**: CLI hooks aggregate with existing user JSON hooks, including same-event hooks, and `--ignore-user-config` does not disable that file. With a fresh home that does not trust the target project, repo-local `.codex/hooks.json` is also skipped even when hook-trust bypass is enabled.

Important operational notes:

- `--dangerously-bypass-hook-trust` bypasses hook hash review only. It does not grant project trust or change the sandbox. In these runs an untrusted `-C` project defaulted to read-only; set the intended sandbox/approval policy separately if the wrapped task needs writes.
- Avoid `--ephemeral` if hooks need `transcript_path`; it remains functional but makes that field `null` and writes no rollout.
- Use stdin `session_id` and `turn_id`. `CODEX_THREAD_ID` may be missing or inherited from a parent and can identify the wrong session.
- Supported working event keys exercised here were `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, and `Stop`. `SessionEnd` and `AgentTurnComplete` were silent no-ops in simple `codex exec` runs on 0.144.1.
- Exit semantics are event-sensitive: for the tested UserPromptSubmit hooks, exit 1 and timeout failed open while exit 2 blocked the model but left parent status 0; Stop block JSON forced continuation and another Stop call.
- A Stop continuation sets `stop_hook_active:true` on the re-entered Stop payload. Hooks should use that or their own sentinel to avoid endless block loops.

Canonical raw payloads are in `probe/q3-q9/main-logs/events.ndjson`. Every command's stdout, stderr, status, fixture, and auxiliary receipt remains under its corresponding `probe/q*` directory.
