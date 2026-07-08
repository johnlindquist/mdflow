# [4.1.0](https://github.com/johnlindquist/mdflow/compare/v4.0.2...v4.1.0) (2026-07-08)


### Bug Fixes

* make evolve lifecycle errors predictable ([b4f87e3](https://github.com/johnlindquist/mdflow/commit/b4f87e35a646364ed0d678527196f0a136b026b5))
* preserve terminal stdio for interactive flows ([c69cbf9](https://github.com/johnlindquist/mdflow/commit/c69cbf997506d58036f374ed4cbdcb41f7b314ca))
* tighten evolve consent and policy reporting ([f48337a](https://github.com/johnlindquist/mdflow/commit/f48337a49c7186215f8c3ad3f3b04d815a4c7acb))


### Features

* make evolve proposal-first and verifiable ([90de31f](https://github.com/johnlindquist/mdflow/commit/90de31f24cc53134b5de9d42febf6d8ed96bb7a0))

## [4.0.2](https://github.com/johnlindquist/mdflow/compare/v4.0.1...v4.0.2) (2026-07-08)


### Bug Fixes

* **release:** keep generated site facts in sync ([f1d10d7](https://github.com/johnlindquist/mdflow/commit/f1d10d7262ae3064d4aa126309f689c08d7aa89c))

## [4.0.1](https://github.com/johnlindquist/mdflow/compare/v4.0.0...v4.0.1) (2026-07-08)


### Bug Fixes

* harden trust gates and release contract ([09cfc20](https://github.com/johnlindquist/mdflow/commit/09cfc20b1a6188612a5787eaddcebc8eb9b4c50d))

# [4.0.0](https://github.com/johnlindquist/mdflow/compare/v3.1.0...v4.0.0) (2026-07-07)


* feat!: isolate every engine by default and add first-class system prompt override ([20a9fe0](https://github.com/johnlindquist/mdflow/commit/20a9fe0f636bd5fa53cc12c8bd48bce6c6d0cd92))


### Bug Fixes

* **site:** tighten hero CTA layout ([e0380da](https://github.com/johnlindquist/mdflow/commit/e0380da1947beb8b7e8ddf956620b97ac212a86b))


### BREAKING CHANGES

* flows on claude/codex/gemini/copilot/opencode that
implicitly relied on ambient skills, MCP servers, or CLAUDE.md/AGENTS.md
memory now run isolated by default. Add `_isolated: false` to restore
the previous behavior, or declare the needed context explicitly in
frontmatter.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

# [3.1.0](https://github.com/johnlindquist/mdflow/compare/v3.0.0...v3.1.0) (2026-07-07)


### Bug Fixes

* **compat:** stamp _compat only on major/minor upgrades ([11cf84b](https://github.com/johnlindquist/mdflow/commit/11cf84b66dcfbdae91d20d0cd1212afc6ab70b05))
* **pkg:** whitelist published files; add site facts generator ([909812b](https://github.com/johnlindquist/mdflow/commit/909812bd27a82d30b4fcd254502849d789f7cb1c))


### Features

* **compat:** automatic frontmatter version/compatibility stamps ([df0e2b9](https://github.com/johnlindquist/mdflow/commit/df0e2b90aca929e87862eda508e4674e7edbb4fb))

# [3.0.0-next.6](https://github.com/johnlindquist/mdflow/compare/v3.0.0-next.5...v3.0.0-next.6) (2026-07-07)


### Bug Fixes

* **pkg:** whitelist published files; add site facts generator ([909812b](https://github.com/johnlindquist/mdflow/commit/909812bd27a82d30b4fcd254502849d789f7cb1c))

# [3.0.0-next.5](https://github.com/johnlindquist/mdflow/compare/v3.0.0-next.4...v3.0.0-next.5) (2026-07-07)


### Bug Fixes

* **compat:** stamp _compat only on major/minor upgrades ([11cf84b](https://github.com/johnlindquist/mdflow/commit/11cf84b66dcfbdae91d20d0cd1212afc6ab70b05))

# [3.0.0-next.4](https://github.com/johnlindquist/mdflow/compare/v3.0.0-next.3...v3.0.0-next.4) (2026-07-07)


### Features

* **compat:** automatic frontmatter version/compatibility stamps ([df0e2b9](https://github.com/johnlindquist/mdflow/commit/df0e2b90aca929e87862eda508e4674e7edbb4fb))

# [3.0.0-next.3](https://github.com/johnlindquist/mdflow/compare/v3.0.0-next.2...v3.0.0-next.3) (2026-07-06)


* feat!: mdflow v3 — markdown agents that evolve ([7d521a6](https://github.com/johnlindquist/mdflow/commit/7d521a6a46033bd8a8a718321fd1e422dd0dada3))


### Features

* **guardrails:** enforce _max_prompt_tokens; adhoc engines match the ladder ([f7ebb68](https://github.com/johnlindquist/mdflow/commit/f7ebb68181cdfb79f560fefc156323b5de066814))


### BREAKING CHANGES

* engine: replaces tool:, bare .md files run on the resolved
engine or print as documents, description/route are reserved frontmatter
keys. See the v3 commit series for details.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

# [3.0.0](https://github.com/johnlindquist/mdflow/compare/v2.35.5...v3.0.0) (2026-07-06)


* docs(v3)!: terminology sweep + v3 docs; retire MA_COMMAND references ([fcaf4c2](https://github.com/johnlindquist/mdflow/commit/fcaf4c2983288b9071c5d79a251bdd0c0774627b))
* feat!: mdflow v3 — markdown agents that evolve ([7d521a6](https://github.com/johnlindquist/mdflow/commit/7d521a6a46033bd8a8a718321fd1e422dd0dada3))
* feat(engine)!: resolution ladder with a default engine; engine: replaces tool: ([0889b9f](https://github.com/johnlindquist/mdflow/commit/0889b9f5ec250e253130bb27b8f430f6cdf22168))


### Bug Fixes

* **command:** dedupe shell arg escaping ([bbbc9d0](https://github.com/johnlindquist/mdflow/commit/bbbc9d0213c6109025b6ba2f365a074d862bf5ec))
* **core:** wire MdflowError handling in config and entrypoint ([5af774b](https://github.com/johnlindquist/mdflow/commit/5af774b881fc7d67c1bb0405c5f10f30f1faeb90))
* **imports:** constrain markerless root fallback ([fb0af00](https://github.com/johnlindquist/mdflow/commit/fb0af000bd18bc0f60ed8b83f2f6025a053f17d9))
* **imports:** harden path and URL import validation ([06e0a1a](https://github.com/johnlindquist/mdflow/commit/06e0a1a2a25ae062bfedd418e818027faaabc8e7))
* **tests:** restore green baseline before v3 work ([9ab4620](https://github.com/johnlindquist/mdflow/commit/9ab4620a5fc26f0e17f721d305e0373aac8b7175)), closes [#13](https://github.com/johnlindquist/mdflow/issues/13)


### Features

* **adapters:** add portable agent spec with provider-agnostic frontmatter translation ([0497bd1](https://github.com/johnlindquist/mdflow/commit/0497bd130f7479407511b9fce26a22583fd845e0))
* **adapters:** pi (hermetic default engine), cursor-agent, and agy (Antigravity) ([d421ae8](https://github.com/johnlindquist/mdflow/commit/d421ae8d827b63c0845fbcefe80b5c62f0e2c702))
* **cli:** add --json output mode for scripting and CI integration ([cb0b4a7](https://github.com/johnlindquist/mdflow/commit/cb0b4a7e8f5811774bc10592813a8a3f5fbbb609))
* **context:** add context provider registry with git, tree, and rg providers ([f7b4671](https://github.com/johnlindquist/mdflow/commit/f7b4671d37deeb6353ad7459a32be886b5d34091))
* **context:** wire context providers into import parser and expansion ([f598322](https://github.com/johnlindquist/mdflow/commit/f598322b570a085a72b6cffa96e23320e11a7de1))
* **engine:** filename rung only claims runnable engines; eval --filter guardrail ([b7a245f](https://github.com/johnlindquist/mdflow/commit/b7a245fd3314d8c531aafbcca51fb692bf0982eb))
* **errors:** add MdflowError base and ValidationError ([b866d59](https://github.com/johnlindquist/mdflow/commit/b866d5971555d264b29c01bb82726c2a1e51eb83))
* **eval,engine:** repo-bound eval cases; description/route are reserved keys ([6bff9af](https://github.com/johnlindquist/mdflow/commit/6bff9af16ac54b70880d4d35efb1e09f847e872e))
* **eval:** md eval — behavioral eval suites for flows with a trust ledger ([ebb5082](https://github.com/johnlindquist/mdflow/commit/ebb5082d80817e2563f01163018f3bc2d2bb795f))
* **guardrails:** enforce _max_prompt_tokens; adhoc engines match the ladder ([f7ebb68](https://github.com/johnlindquist/mdflow/commit/f7ebb68181cdfb79f560fefc156323b5de066814))
* **output:** add structured output extraction, validation, and sink module ([53dd2ff](https://github.com/johnlindquist/mdflow/commit/53dd2ff6ac4bf23dac072d68b3818e1b7ab4a11e))
* **output:** wire structured output processing into CLI runner and post-run menu ([a250771](https://github.com/johnlindquist/mdflow/commit/a250771c829d894f442c2c4c03e6e61c2afaccbb))
* **pi:** Codex-subscription auth bridge + adapter prepareEnv hook ([07668c4](https://github.com/johnlindquist/mdflow/commit/07668c4a637677909090db8abcffb9b06cc1afa9))
* **registry:** add agent registry with install/remove/list and lockfile integrity ([b54807d](https://github.com/johnlindquist/mdflow/commit/b54807d393b1cb5d76c392a7e6fdaa803f2dfd2f))
* **schema:** enforce typed _inputs and parse result unions ([28dfcc1](https://github.com/johnlindquist/mdflow/commit/28dfcc1fbaee00ea20537ac0a8122ea9e10898c6))
* **skill:** installable agent skill — npx skills add johnlindquist/mdflow ([ad2b0e8](https://github.com/johnlindquist/mdflow/commit/ad2b0e833eac752ba610f3c380d5ad7e4d814bbc))
* **spike:** add Bun p-queue compatibility PoC ([b3887cd](https://github.com/johnlindquist/mdflow/commit/b3887cdf8bb26f883380369777989709ec59cbaf))
* **telemetry:** add run telemetry logging ([7bd4781](https://github.com/johnlindquist/mdflow/commit/7bd47814d7046adc1395fc0aaf9c9038c832d032))
* **workflow:** add multi-step workflow engine with DAG execution and step caching ([5287827](https://github.com/johnlindquist/mdflow/commit/52878272a79191a9e2936245443a0f1592721c9b))


### BREAKING CHANGES

* engine: replaces tool:, bare .md files run on the resolved
engine or print as documents, description/route are reserved frontmatter
keys. See the v3 commit series for details.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

* docs and examples now describe v3 semantics (engine:,
default engine pi, document rule for frontmatter-less files).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
* bare .md files no longer error with COMMAND_MISSING — they
either run on the resolved engine (frontmatter present) or print as
documents (no frontmatter). Frontmatter tool:/_tool: still resolve but warn;
use engine:. --engine is the canonical flag; --_command/-_c/--tool remain as
deprecated aliases. resolveCommand() no longer throws for missing commands.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

# [3.0.0-next.2](https://github.com/johnlindquist/mdflow/compare/v3.0.0-next.1...v3.0.0-next.2) (2026-07-05)


### Features

* **eval,engine:** repo-bound eval cases; description/route are reserved keys ([6bff9af](https://github.com/johnlindquist/mdflow/commit/6bff9af16ac54b70880d4d35efb1e09f847e872e))

# [3.0.0-next.1](https://github.com/johnlindquist/mdflow/compare/v2.35.4...v3.0.0-next.1) (2026-07-05)


* docs(v3)!: terminology sweep + v3 docs; retire MA_COMMAND references ([fcaf4c2](https://github.com/johnlindquist/mdflow/commit/fcaf4c2983288b9071c5d79a251bdd0c0774627b))
* feat(engine)!: resolution ladder with a default engine; engine: replaces tool: ([0889b9f](https://github.com/johnlindquist/mdflow/commit/0889b9f5ec250e253130bb27b8f430f6cdf22168))


### Bug Fixes

* **command:** dedupe shell arg escaping ([bbbc9d0](https://github.com/johnlindquist/mdflow/commit/bbbc9d0213c6109025b6ba2f365a074d862bf5ec))
* **core:** wire MdflowError handling in config and entrypoint ([5af774b](https://github.com/johnlindquist/mdflow/commit/5af774b881fc7d67c1bb0405c5f10f30f1faeb90))
* **imports:** constrain markerless root fallback ([fb0af00](https://github.com/johnlindquist/mdflow/commit/fb0af000bd18bc0f60ed8b83f2f6025a053f17d9))
* **imports:** harden path and URL import validation ([06e0a1a](https://github.com/johnlindquist/mdflow/commit/06e0a1a2a25ae062bfedd418e818027faaabc8e7))
* stop spinner before streaming output to prevent double-rendering ([48af0af](https://github.com/johnlindquist/mdflow/commit/48af0af6fdcb3b7d0d8206670678316fad8d7be0))
* **tests:** restore green baseline before v3 work ([9ab4620](https://github.com/johnlindquist/mdflow/commit/9ab4620a5fc26f0e17f721d305e0373aac8b7175)), closes [#13](https://github.com/johnlindquist/mdflow/issues/13)


### Features

* **adapters:** add portable agent spec with provider-agnostic frontmatter translation ([0497bd1](https://github.com/johnlindquist/mdflow/commit/0497bd130f7479407511b9fce26a22583fd845e0))
* **adapters:** pi (hermetic default engine), cursor-agent, and agy (Antigravity) ([d421ae8](https://github.com/johnlindquist/mdflow/commit/d421ae8d827b63c0845fbcefe80b5c62f0e2c702))
* **cli:** add --json output mode for scripting and CI integration ([cb0b4a7](https://github.com/johnlindquist/mdflow/commit/cb0b4a7e8f5811774bc10592813a8a3f5fbbb609))
* **context:** add context provider registry with git, tree, and rg providers ([f7b4671](https://github.com/johnlindquist/mdflow/commit/f7b4671d37deeb6353ad7459a32be886b5d34091))
* **context:** wire context providers into import parser and expansion ([f598322](https://github.com/johnlindquist/mdflow/commit/f598322b570a085a72b6cffa96e23320e11a7de1))
* **engine:** filename rung only claims runnable engines; eval --filter guardrail ([b7a245f](https://github.com/johnlindquist/mdflow/commit/b7a245fd3314d8c531aafbcca51fb692bf0982eb))
* **errors:** add MdflowError base and ValidationError ([b866d59](https://github.com/johnlindquist/mdflow/commit/b866d5971555d264b29c01bb82726c2a1e51eb83))
* **eval:** md eval — behavioral eval suites for flows with a trust ledger ([ebb5082](https://github.com/johnlindquist/mdflow/commit/ebb5082d80817e2563f01163018f3bc2d2bb795f))
* **output:** add structured output extraction, validation, and sink module ([53dd2ff](https://github.com/johnlindquist/mdflow/commit/53dd2ff6ac4bf23dac072d68b3818e1b7ab4a11e))
* **output:** wire structured output processing into CLI runner and post-run menu ([a250771](https://github.com/johnlindquist/mdflow/commit/a250771c829d894f442c2c4c03e6e61c2afaccbb))
* **pi:** Codex-subscription auth bridge + adapter prepareEnv hook ([07668c4](https://github.com/johnlindquist/mdflow/commit/07668c4a637677909090db8abcffb9b06cc1afa9))
* **registry:** add agent registry with install/remove/list and lockfile integrity ([b54807d](https://github.com/johnlindquist/mdflow/commit/b54807d393b1cb5d76c392a7e6fdaa803f2dfd2f))
* **schema:** enforce typed _inputs and parse result unions ([28dfcc1](https://github.com/johnlindquist/mdflow/commit/28dfcc1fbaee00ea20537ac0a8122ea9e10898c6))
* **skill:** installable agent skill — npx skills add johnlindquist/mdflow ([ad2b0e8](https://github.com/johnlindquist/mdflow/commit/ad2b0e833eac752ba610f3c380d5ad7e4d814bbc))
* **spike:** add Bun p-queue compatibility PoC ([b3887cd](https://github.com/johnlindquist/mdflow/commit/b3887cdf8bb26f883380369777989709ec59cbaf))
* **telemetry:** add run telemetry logging ([7bd4781](https://github.com/johnlindquist/mdflow/commit/7bd47814d7046adc1395fc0aaf9c9038c832d032))
* **workflow:** add multi-step workflow engine with DAG execution and step caching ([5287827](https://github.com/johnlindquist/mdflow/commit/52878272a79191a9e2936245443a0f1592721c9b))


### BREAKING CHANGES

* docs and examples now describe v3 semantics (engine:,
default engine pi, document rule for frontmatter-less files).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
* bare .md files no longer error with COMMAND_MISSING — they
either run on the resolved engine (frontmatter present) or print as
documents (no frontmatter). Frontmatter tool:/_tool: still resolve but warn;
use engine:. --engine is the canonical flag; --_command/-_c/--tool remain as
deprecated aliases. resolveCommand() no longer throws for missing commands.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

## [Unreleased]

### Features

* standardize typed error model with stable `errorCode` metadata and helper utilities ([b866d59](https://github.com/johnlindquist/mdflow/commit/b866d59))
* enforce typed `_inputs` schemas and add non-throwing parse result unions for schema validation ([28dfcc1](https://github.com/johnlindquist/mdflow/commit/28dfcc1))

### Bug Fixes

* wire structured `MdflowError` handling through config loading and top-level CLI entrypoint ([5af774b](https://github.com/johnlindquist/mdflow/commit/5af774b))
* harden local/URL import validation and tighten markerless fallback behavior ([06e0a1a](https://github.com/johnlindquist/mdflow/commit/06e0a1a), [fb0af00](https://github.com/johnlindquist/mdflow/commit/fb0af00))
* dedupe shell argument escaping to reduce platform-specific quoting drift ([bbbc9d0](https://github.com/johnlindquist/mdflow/commit/bbbc9d0))

### Tests

* expand security, path, command escaping, and error metadata coverage for release hardening ([902ed97](https://github.com/johnlindquist/mdflow/commit/902ed97), [3e530f8](https://github.com/johnlindquist/mdflow/commit/3e530f8), [c4e3fe4](https://github.com/johnlindquist/mdflow/commit/c4e3fe4))

## [2.35.5](https://github.com/johnlindquist/mdflow/compare/v2.35.4...v2.35.5) (2025-12-19)


### Bug Fixes

* stop spinner before streaming output to prevent double-rendering ([48af0af](https://github.com/johnlindquist/mdflow/commit/48af0af6fdcb3b7d0d8206670678316fad8d7be0))

## [2.35.4](https://github.com/johnlindquist/mdflow/compare/v2.35.3...v2.35.4) (2025-12-19)


### Bug Fixes

* split comma-separated values for variadic flags ([5d394c8](https://github.com/johnlindquist/mdflow/commit/5d394c83ddfb9935858fa6f016bbb99f2604f59f))

## [2.35.3](https://github.com/johnlindquist/mdflow/compare/v2.35.2...v2.35.3) (2025-12-19)


### Bug Fixes

* use --flag=value syntax for variadic CLI flags ([12422cd](https://github.com/johnlindquist/mdflow/commit/12422cd58b40fd8292dad7e4866e69a93bb260bf))

## [2.35.2](https://github.com/johnlindquist/mdflow/compare/v2.35.1...v2.35.2) (2025-12-16)


### Bug Fixes

* support parent directory glob patterns in imports (closes [#13](https://github.com/johnlindquist/mdflow/issues/13)) ([89bbda9](https://github.com/johnlindquist/mdflow/commit/89bbda9f1dc42c545421250616a8f1f1bef2ca11))

## [2.35.1](https://github.com/johnlindquist/mdflow/compare/v2.35.0...v2.35.1) (2025-12-16)


### Bug Fixes

* update README and GUIDE with correct CLI usage and new features ([7155be1](https://github.com/johnlindquist/mdflow/commit/7155be143c4f068a5be6d88c09dd5b3730363075))

# [2.35.0](https://github.com/johnlindquist/mdflow/compare/v2.34.0...v2.35.0) (2025-12-16)


### Features

* support piping between agents (foo.md | bar.md) ([a5466cf](https://github.com/johnlindquist/mdflow/commit/a5466cf700930f11c84f69de4d19f6b2a17088bc))

# [2.34.0](https://github.com/johnlindquist/mdflow/compare/v2.33.0...v2.34.0) (2025-12-16)


### Bug Fixes

* remove broken countdown from post-run menu ([4571c2a](https://github.com/johnlindquist/mdflow/commit/4571c2a70dd4e31a1f66914fee55ea96e6998253))


### Features

* add --_edit flag for edit-before-execute workflow ([3434ab4](https://github.com/johnlindquist/mdflow/commit/3434ab477e4545d6b0991185d2861f3f1c7d8616))
* add auto-heal retry loop on command failure ([396ebf6](https://github.com/johnlindquist/mdflow/commit/396ebf64e6517ef9879117a0c9376249a818d126))
* add auto-heal retry loop on command failure ([1e589a5](https://github.com/johnlindquist/mdflow/commit/1e589a5bad953ea5925d9bac787d4d282564d0c9))
* add content search mode with auto-scroll to matches ([55f8a95](https://github.com/johnlindquist/mdflow/commit/55f8a9538ace02d3a7f0cc13363760a930cc76cf))
* add edit-before-execute interceptor ([fe6c6c3](https://github.com/johnlindquist/mdflow/commit/fe6c6c3a5cb613392695437d737f1dfcc8badac0))
* add interactive form inputs ([8df1f52](https://github.com/johnlindquist/mdflow/commit/8df1f52aa59c1ae1112c931fb0bfc65beb26c2da))
* add interactive form inputs with typed prompts ([7e566b1](https://github.com/johnlindquist/mdflow/commit/7e566b135917c6ea44cd0588c142ee759f8c76e7))
* add one-shot ad-hoc execution via md.command aliases ([0e06c7d](https://github.com/johnlindquist/mdflow/commit/0e06c7d4a1ab558cdb8730bfcb320b484f3e51d0))
* add one-shot ad-hoc execution via md.command aliases ([156ff94](https://github.com/johnlindquist/mdflow/commit/156ff942c7e2b776e5f1d7e5bedf7ebe74b5998c))
* add post-run action menu ([09859a0](https://github.com/johnlindquist/mdflow/commit/09859a06d72abed9169c367762c601c89eafa3ee))
* add post-run action menu for output handling ([7e25214](https://github.com/johnlindquist/mdflow/commit/7e25214a6cd799fde4eec5be58bbded97e554b7d))
* add rich terminal markdown rendering ([9f4780c](https://github.com/johnlindquist/mdflow/commit/9f4780ca70981932e134136c77c763e0b25ee58b))
* add rich terminal markdown rendering with syntax highlighting ([b0bf725](https://github.com/johnlindquist/mdflow/commit/b0bf725bc164e72d87b3c38764a81c2be57c6d4c))
* add secret masking and redaction ([7eb2a06](https://github.com/johnlindquist/mdflow/commit/7eb2a06ee9d456b4aa04bf980e48aebfdcd20fc1))
* add secret masking and redaction ([d9f9260](https://github.com/johnlindquist/mdflow/commit/d9f92600353af2da254bbb43b00b7ac1a9e4b1bc))
* add semantic agent picker with descriptions ([c9e0577](https://github.com/johnlindquist/mdflow/commit/c9e0577e3e856a74682e26e36dbe930897f87a27))
* add semantic agent picker with descriptions ([ee6b346](https://github.com/johnlindquist/mdflow/commit/ee6b346ad72b4ddeb6a93e20c55d6f95b3675952))
* add smart variable persistence with history ([7dde139](https://github.com/johnlindquist/mdflow/commit/7dde13958c3e84c07526cff6f4e4c59346d80648))
* add smart variable persistence with history ([2929245](https://github.com/johnlindquist/mdflow/commit/2929245905f03feb2ed9a3f4457f348b6e26560b))
* add Tab/Shift+Tab to cycle through matches in content search ([8934eb4](https://github.com/johnlindquist/mdflow/commit/8934eb4b091f97b8e5aefb4e6f823440cc1f6c93))
* add visual context tree and cost dashboard ([f21e880](https://github.com/johnlindquist/mdflow/commit/f21e880e0b9fb4b6c618f52d3f76a5b873807efd))
* add visual context tree and cost dashboard ([3400e41](https://github.com/johnlindquist/mdflow/commit/3400e41257a07e54d0132217010cd3246251a281))

# [2.33.0](https://github.com/johnlindquist/mdflow/compare/v2.32.0...v2.33.0) (2025-12-14)


### Features

* show command preview in spinner instead of filename ([487d5ad](https://github.com/johnlindquist/mdflow/commit/487d5ad5c765f4e2ff3c27bf08bca390b1ee10c6))

# [2.32.0](https://github.com/johnlindquist/mdflow/compare/v2.31.1...v2.32.0) (2025-12-14)


### Features

* open editor after md create, fix TypeScript errors ([c221015](https://github.com/johnlindquist/mdflow/commit/c2210154fd0f8cc64f3c5d8c55e865581313ee92))

## [2.31.1](https://github.com/johnlindquist/mdflow/compare/v2.31.0...v2.31.1) (2025-12-14)


### Bug Fixes

* log errors instead of silent failures in config.ts ([8b2e738](https://github.com/johnlindquist/mdflow/commit/8b2e7385c1a41fd8035e2744904c79cb2ed836ed))

# [2.31.0](https://github.com/johnlindquist/mdflow/compare/v2.30.1...v2.31.0) (2025-12-14)


### Bug Fixes

* centralize process lifecycle and cancellation handling ([f5ad522](https://github.com/johnlindquist/mdflow/commit/f5ad5228ad8ebb10d92a6c2ed16abc2349a44d6c))
* cross-platform PATH delimiter and file resolution ([a3f1b99](https://github.com/johnlindquist/mdflow/commit/a3f1b99d40e5f2f66b771537eba431daab553c56))
* implement proper LRU cache and HTTP conditional requests ([7249579](https://github.com/johnlindquist/mdflow/commit/7249579ea5d1bc448c82debd70dec686b0506f6c))


### Features

* add config validation and md explain command ([1ff8006](https://github.com/johnlindquist/mdflow/commit/1ff80061cdc5b28d9f0296a99c4947d929052b7c))
* add frecency-based sorting for agent file picker ([5d077e4](https://github.com/johnlindquist/mdflow/commit/5d077e424dd21e5b4662e82bb4ac7557f1f2d207))
* add loading spinner after interactive file selection ([89ea9c9](https://github.com/johnlindquist/mdflow/commit/89ea9c9ebc7bb2a24bd61ec39022c721ee91f955))
* improve spinner UX and add dry-run from file selector ([7ca8bc8](https://github.com/johnlindquist/mdflow/commit/7ca8bc89ade47873c325cd9a9cb9e82b8dc7bc5a))


### Performance Improvements

* lazy-load heavy dependencies for faster cold start ([54a3563](https://github.com/johnlindquist/mdflow/commit/54a3563c9407f6992a56867d6d53f1af4652cd4f))

## [2.30.1](https://github.com/johnlindquist/mdflow/compare/v2.30.0...v2.30.1) (2025-12-13)


### Bug Fixes

* update types.ts comment to reflect underscore prefix convention ([1b51ba9](https://github.com/johnlindquist/mdflow/commit/1b51ba9a896143f654c18fdec96086670ce8256b))

# [2.30.0](https://github.com/johnlindquist/mdflow/compare/v2.29.0...v2.30.0) (2025-12-13)


### Features

* add executable code fence support ([99df5b0](https://github.com/johnlindquist/mdflow/commit/99df5b0fb4acddc24838ffaca9980ec79aff99f5))

# [2.29.0](https://github.com/johnlindquist/mdflow/compare/v2.28.0...v2.29.0) (2025-12-12)


### Bug Fixes

* resolve all TypeScript strict null check errors ([fed464a](https://github.com/johnlindquist/mdflow/commit/fed464a95706d029bb4dde3610b43355d6e6229e))


### Features

* add parallel command dashboard and standardize internal flags ([d431196](https://github.com/johnlindquist/mdflow/commit/d43119601fb6b108d55badbf0f769a6778a8a2da))
* show spinner dashboard for single inline commands too ([8c44e0c](https://github.com/johnlindquist/mdflow/commit/8c44e0c3fe4328111ad3ccb3a80b58432a6b564d))

# [2.28.0](https://github.com/johnlindquist/mdflow/compare/v2.27.1...v2.28.0) (2025-12-12)


### Features

* add droid and opencode adapters with multi-agent examples ([fa5fe32](https://github.com/johnlindquist/mdflow/commit/fa5fe324e9a72fa9e20cc086de225d763935caaf))

## [2.27.1](https://github.com/johnlindquist/mdflow/compare/v2.27.0...v2.27.1) (2025-12-12)


### Bug Fixes

* clear screen after editing to prevent selector duplication ([b0d9618](https://github.com/johnlindquist/mdflow/commit/b0d96184e6fcbe4847e1852562d896a50cd07f59))

# [2.27.0](https://github.com/johnlindquist/mdflow/compare/v2.26.0...v2.27.0) (2025-12-11)


### Features

* add Ctrl+E shortcut to open files in $EDITOR from selector ([fdb5896](https://github.com/johnlindquist/mdflow/commit/fdb5896b48158b5926dd2875affc229630db2593))

# [2.26.0](https://github.com/johnlindquist/mdflow/compare/v2.25.1...v2.26.0) (2025-12-11)


### Features

* support --_key=value syntax for template variables ([f467342](https://github.com/johnlindquist/mdflow/commit/f4673422ff344243b711d4d8c98794259b61d2e5))

## [2.25.1](https://github.com/johnlindquist/mdflow/compare/v2.25.0...v2.25.1) (2025-12-11)


### Bug Fixes

* clean up and update examples ([afe4815](https://github.com/johnlindquist/mdflow/commit/afe48151cf861fa9ec5ff2ffb6fb3012cc2b6fb9))

# [2.25.0](https://github.com/johnlindquist/mdflow/compare/v2.24.0...v2.25.0) (2025-12-11)


### Features

* allow --_varname CLI flags without frontmatter declaration ([42af75a](https://github.com/johnlindquist/mdflow/commit/42af75aed65e4be2ce285dc6648caedf660455cc))

# [2.24.0](https://github.com/johnlindquist/mdflow/compare/v2.23.0...v2.24.0) (2025-12-11)


### Features

* add _args template variable for numbered list of all positional args ([9d7b93f](https://github.com/johnlindquist/mdflow/commit/9d7b93f6dd4b876be7f64dc4a7f855d24337ac21))

# [2.23.0](https://github.com/johnlindquist/mdflow/compare/v2.22.0...v2.23.0) (2025-12-11)


### Features

* support positional args as template variables (_1, _2, etc.) ([f2c97a3](https://github.com/johnlindquist/mdflow/commit/f2c97a3e35eb5dfaea82dc0d5c34c68bb7c6d66f))

# [2.22.0](https://github.com/johnlindquist/mdflow/compare/v2.21.1...v2.22.0) (2025-12-11)


### Features

* add multi-directory file resolution for agent files ([f4ba887](https://github.com/johnlindquist/mdflow/commit/f4ba88744d693bf82b7af54d08050ef6bdd48182))

## [2.21.1](https://github.com/johnlindquist/mdflow/compare/v2.21.0...v2.21.1) (2025-12-10)


### Bug Fixes

* enable true parallel execution of inline commands ([8bd0421](https://github.com/johnlindquist/mdflow/commit/8bd0421682729b3646a569f17f23a92f90d9f9ba))

# [2.21.0](https://github.com/johnlindquist/mdflow/compare/v2.20.0...v2.21.0) (2025-12-10)


### Features

* support template variables in inline commands (!`cmd`) ([902954e](https://github.com/johnlindquist/mdflow/commit/902954ee214c2a10105fcb914940142271dbd98a))

# [2.20.0](https://github.com/johnlindquist/mdflow/compare/v2.19.1...v2.20.0) (2025-12-10)


### Features

* add GitHub Pages landing page for mdflow.dev ([bbad4cb](https://github.com/johnlindquist/mdflow/commit/bbad4cbea142b0d43aace5bc32361e672a2eedb3))

## [2.19.1](https://github.com/johnlindquist/mdflow/compare/v2.19.0...v2.19.1) (2025-12-09)


### Bug Fixes

* add _i shorthand to internalKeys set ([704ccd9](https://github.com/johnlindquist/mdflow/commit/704ccd9840e4e5f6788fc95837ed5bf60af678e1))

# [2.19.0](https://github.com/johnlindquist/mdflow/compare/v2.18.1...v2.19.0) (2025-12-09)


### Features

* **cache:** add persistent remote URL caching with TTL support ([d731cfc](https://github.com/johnlindquist/mdflow/commit/d731cfcc630b1dfd0660c6b74f749f295f1d7ad7))
* **imports:** parallelize import resolution with concurrency limiting ([9831e97](https://github.com/johnlindquist/mdflow/commit/9831e970428c94beac9416834011bcb94c5aad47))

## [2.18.1](https://github.com/johnlindquist/mdflow/compare/v2.18.0...v2.18.1) (2025-12-09)


### Bug Fixes

* **setup:** search PATH for .md files in suffix alias handler ([e5dea16](https://github.com/johnlindquist/mdflow/commit/e5dea16bb9a079f659c798cbc5e772a6117aad4d))

# [2.18.0](https://github.com/johnlindquist/mdflow/compare/v2.17.1...v2.18.0) (2025-12-09)


### Features

* **selector:** add split-pane file preview to interactive picker ([8441d38](https://github.com/johnlindquist/mdflow/commit/8441d383c000f4346fc9e63439f8f009179d792e))

## [2.17.1](https://github.com/johnlindquist/mdflow/compare/v2.17.0...v2.17.1) (2025-12-09)


### Bug Fixes

* **setup:** improve md alias detection with interactive shell ([03353bb](https://github.com/johnlindquist/mdflow/commit/03353bbd512f667b768d423d5c6dabe41ebd1d58))

# [2.17.0](https://github.com/johnlindquist/mdflow/compare/v2.16.2...v2.17.0) (2025-12-09)


### Bug Fixes

* use mdflow binary instead of md for inline command auto-run ([5f6360d](https://github.com/johnlindquist/mdflow/commit/5f6360dd91a89e0fb8a3545cc1cd2f59792b11b8))


### Features

* **setup:** use mdflow binary and handle md alias conflicts ([0cfd8a2](https://github.com/johnlindquist/mdflow/commit/0cfd8a2151d678dfdc7e6b8de9773b94e8567bde))

## [2.16.2](https://github.com/johnlindquist/mdflow/compare/v2.16.1...v2.16.2) (2025-12-09)


### Bug Fixes

* update remaining markdown-agent references to mdflow ([604d214](https://github.com/johnlindquist/mdflow/commit/604d2140264e8bc90fb4e031be1d302f0480c451))

## [2.16.1](https://github.com/johnlindquist/mdflow/compare/v2.16.0...v2.16.1) (2025-12-09)


### Bug Fixes

* trigger build ([b0de400](https://github.com/johnlindquist/mdflow/commit/b0de400e00b8a45330e415c5d7b93d9c3bc39bb9))
* update repository URL from markdown-agent to mdflow ([8a49ecd](https://github.com/johnlindquist/mdflow/commit/8a49ecde6486297be0421625274adefb77583dd3))

# [2.16.0](https://github.com/johnlindquist/markdown-agent/compare/v2.15.2...v2.16.0) (2025-12-09)


### Features

* auto-run .md files with ma in inline commands ([e535bfc](https://github.com/johnlindquist/markdown-agent/commit/e535bfc6ddfbf0c07a569868a0e192b0897cf7c9))

## [2.15.2](https://github.com/johnlindquist/markdown-agent/compare/v2.15.1...v2.15.2) (2025-12-09)


### Bug Fixes

* make interactive-selector tests resilient to ~/.ma files ([50c1a49](https://github.com/johnlindquist/markdown-agent/commit/50c1a4965368db2e814b5732a9580d63f66fc68f))
* run inline commands in invocation directory, add _cwd override ([79332b5](https://github.com/johnlindquist/markdown-agent/commit/79332b51fbd76479944d8fb1b9ae4696d9b4fbb4))

## [2.15.1](https://github.com/johnlindquist/markdown-agent/compare/v2.15.0...v2.15.1) (2025-12-09)


### Bug Fixes

* wrap command output in {% raw %} to prevent template interpretation ([37a584a](https://github.com/johnlindquist/markdown-agent/commit/37a584a38b9d1bee45d30e9efb8314239c0108b8))

# [2.15.0](https://github.com/johnlindquist/markdown-agent/compare/v2.14.1...v2.15.0) (2025-12-08)


### Features

* add _i alias and CLI flags for interactive mode ([679047f](https://github.com/johnlindquist/markdown-agent/commit/679047fe7d7204fc5e5ad2e352a1044ccb88a8f0))

## [2.14.1](https://github.com/johnlindquist/markdown-agent/compare/v2.14.0...v2.14.1) (2025-12-08)


### Bug Fixes

* improve _subcommand docs example ([426a2d7](https://github.com/johnlindquist/markdown-agent/commit/426a2d7484cf9ede1ef6719d53fa0abd46703f9f))

# [2.14.0](https://github.com/johnlindquist/markdown-agent/compare/v2.13.1...v2.14.0) (2025-12-08)


### Bug Fixes

* update runtime test for print-mode defaults ([57f2027](https://github.com/johnlindquist/markdown-agent/commit/57f2027d1ed7ba9ca278e4c9ad25c29c3c23dc31))


### Features

* print mode by default with $interactive and .i. filename support ([660a8fb](https://github.com/johnlindquist/markdown-agent/commit/660a8fb22daf6adc53ee001a998314dd718fa490))

## [2.13.1](https://github.com/johnlindquist/markdown-agent/compare/v2.13.0...v2.13.1) (2025-12-08)


### Bug Fixes

* show positional mappings in dry-run output ([357d92a](https://github.com/johnlindquist/markdown-agent/commit/357d92a46f1a311fc8bf1319ecacb0729dcc5f62))

# [2.13.0](https://github.com/johnlindquist/markdown-agent/compare/v2.12.1...v2.13.0) (2025-12-08)


### Features

* change copilot defaults to --interactive and --silent ([d8080bd](https://github.com/johnlindquist/markdown-agent/commit/d8080bd41d88008f0be5190e4b88b4e3de743a6a))

## [2.12.1](https://github.com/johnlindquist/markdown-agent/compare/v2.12.0...v2.12.1) (2025-12-08)


### Bug Fixes

* create command now generates empty agent files ([95fe448](https://github.com/johnlindquist/markdown-agent/commit/95fe448da49f4e420df4d0edbf64359f41581f26))

# [2.12.0](https://github.com/johnlindquist/markdown-agent/compare/v2.11.0...v2.12.0) (2025-12-08)


### Features

* add CLI subcommands (create, setup, logs, help) ([96daa68](https://github.com/johnlindquist/markdown-agent/commit/96daa6840b29d0438261381355465b4f21b671c1))

# [2.11.0](https://github.com/johnlindquist/markdown-agent/compare/v2.10.0...v2.11.0) (2025-12-08)


### Features

* add PATH setup option to ma --setup command ([ed876cf](https://github.com/johnlindquist/markdown-agent/commit/ed876cf294870356053a0f473d363ebe4638bb4d))

# [2.10.0](https://github.com/johnlindquist/markdown-agent/compare/v2.9.0...v2.10.0) (2025-12-08)


### Features

* add ma create command for interactive agent creation ([0cf60d1](https://github.com/johnlindquist/markdown-agent/commit/0cf60d1c5afebc6e586a170e9a9edb86eff82bed))

# [2.9.0](https://github.com/johnlindquist/markdown-agent/compare/v2.8.0...v2.9.0) (2025-12-08)


### Features

* add structured ExecutionPlan for dry-run mode ([8dea17c](https://github.com/johnlindquist/markdown-agent/commit/8dea17ccc6e66e24c0ffb0a46c06c62c6d3f6256))
* add SystemEnvironment adapter pattern for dependency injection ([921b7ca](https://github.com/johnlindquist/markdown-agent/commit/921b7ca56543161be79399109a6a7dac7f5d5b85))
* add typed error classes to eliminate process.exit() in library code ([0916afb](https://github.com/johnlindquist/markdown-agent/commit/0916afb6571860758b8f00a950f194ded36461b7))
* merge testability architectural improvements from parallel branches ([5305dc0](https://github.com/johnlindquist/markdown-agent/commit/5305dc007341a82d0f0819cfb1a06dc79ef36090))

# [2.8.0](https://github.com/johnlindquist/markdown-agent/compare/v2.7.0...v2.8.0) (2025-12-08)


### Bug Fixes

* add missing gpt-tokenizer dependency ([f5a680e](https://github.com/johnlindquist/markdown-agent/commit/f5a680e27f47e3d821af82521f9da27e01dd8f31))
* replace httpbin.org with jsonplaceholder.typicode.com ([d19c822](https://github.com/johnlindquist/markdown-agent/commit/d19c8221d7dfe3fc8bc95ba96280438304db9eca))


### Features

* add .ma/ agent discovery for user and project levels ([e99c2f1](https://github.com/johnlindquist/markdown-agent/commit/e99c2f18906944921c68b776ee6d3cfc1522dae7))
* add project-level configuration support ([5639260](https://github.com/johnlindquist/markdown-agent/commit/5639260209fc3611793547b949456ce0ea85de70))
* add Trust on First Use (TOFU) security for remote URL execution ([82204cb](https://github.com/johnlindquist/markdown-agent/commit/82204cb02413b0034b99e2a270eef45e9b5610bb))
* implement output stream teeing for simultaneous display and capture ([e5a9fef](https://github.com/johnlindquist/markdown-agent/commit/e5a9fef00dd7871b5d9ff96840543c5e12d17cfc))
* replace length/4 token heuristic with real tokenization ([bfef712](https://github.com/johnlindquist/markdown-agent/commit/bfef7127343df7be92823d9fcc5da48558f03ce7))

# [2.7.0](https://github.com/johnlindquist/markdown-agent/compare/v2.6.0...v2.7.0) (2025-12-07)


### Bug Fixes

* route system/status messages to stderr for clean piping ([e2351a8](https://github.com/johnlindquist/markdown-agent/commit/e2351a8898b105004d7df3990c968ec21396eed0))
* update dry-run test paths after worktree merge ([fc72c6a](https://github.com/johnlindquist/markdown-agent/commit/fc72c6a7671de0de3f636f06c8371915445e87c8))
* use canonical paths for cycle detection to handle symlinks ([0cf60ab](https://github.com/johnlindquist/markdown-agent/commit/0cf60ab0547e31efd55214f07b9fd324d01e16aa))


### Features

* add --dry-run flag for visual preview mode ([5117372](https://github.com/johnlindquist/markdown-agent/commit/51173728e5f60eef5f7dc682af8309f4dc285cac))
* add --dry-run flag for visual preview mode ([b68eade](https://github.com/johnlindquist/markdown-agent/commit/b68eadef9cc241baf4c42944b49a952783e12984))
* add binary file detection to prevent garbage in imports ([8da964a](https://github.com/johnlindquist/markdown-agent/commit/8da964a11265599ecb55d19e1cead96fe67d4dfe))
* add crash log pointer for better error debugging ([cd37c2d](https://github.com/johnlindquist/markdown-agent/commit/cd37c2d1c3bff4622b3784ba5f5da41a9ca9c414))
* add EPIPE error handling for graceful pipe closure ([2ecf869](https://github.com/johnlindquist/markdown-agent/commit/2ecf869aa5f92e03269034aa103a269513f52014))
* add graceful signal handling for SIGINT/SIGTERM ([8dec439](https://github.com/johnlindquist/markdown-agent/commit/8dec4398a8700cb4f081bf499ec75c62598d0ce6))
* add import feedback logging and 50k token warning ([31ec36c](https://github.com/johnlindquist/markdown-agent/commit/31ec36c38ea1d21607c163416214307a4f811aea))
* add input size limits for OOM protection ([8a96609](https://github.com/johnlindquist/markdown-agent/commit/8a9660994fd4596dfc82d9214ba7a567c136b847))
* add interactive agent selector for no-args mode ([6dc646f](https://github.com/johnlindquist/markdown-agent/commit/6dc646fde6f21c68fef4700b7230de4f03a093b6))
* add interactive agent selector for no-args mode ([8154a45](https://github.com/johnlindquist/markdown-agent/commit/8154a454cefaea5db61f84a5a4e970d8dd4aaf1f))
* add interactive recovery for missing template variables ([6cf94ec](https://github.com/johnlindquist/markdown-agent/commit/6cf94ec6415c508d0a344c422f666bb7bdd56293))
* add network timeout and retry support for fetch calls ([5646e98](https://github.com/johnlindquist/markdown-agent/commit/5646e980778d8427c3d10852ed88ed55d202bb92))
* add pre-flight binary check before command execution ([800a7bd](https://github.com/johnlindquist/markdown-agent/commit/800a7bdbc85e0a9f5b63960631e9a4b48a89dac9))
* add pre-flight binary check before command execution ([cc6f214](https://github.com/johnlindquist/markdown-agent/commit/cc6f214a609b298255e18195dc1131205c968ef7))
* extract template variables from Liquid logic tags ([bcf1f27](https://github.com/johnlindquist/markdown-agent/commit/bcf1f276b3719c6a0c977268c507738240b3be7a))
* show log file path on agent errors ([f8fc9f5](https://github.com/johnlindquist/markdown-agent/commit/f8fc9f5b8aef8067d7bc54222ee69fcdf17f9c16))

# [2.6.0](https://github.com/johnlindquist/markdown-agent/compare/v2.5.0...v2.6.0) (2025-12-07)


### Features

* add --command flag hijacking for generic markdown files ([24d2028](https://github.com/johnlindquist/markdown-agent/commit/24d2028f58ebec4cd41dfa64c33867741fd391dc))

# [2.5.0](https://github.com/johnlindquist/markdown-agent/compare/v2.4.0...v2.5.0) (2025-12-07)


### Bug Fixes

* pass unknown CLI flags through to command ([926b426](https://github.com/johnlindquist/markdown-agent/commit/926b426c83fd2c661461e8cb6dfed619f12be448))
* remove duplicate fileDir declaration ([2be9cd9](https://github.com/johnlindquist/markdown-agent/commit/2be9cd92eb6f76bef9fb2af25a34a8d67127c3d5))


### Features

* enhanced import system with globs, line ranges, symbol extraction, and env loading ([2fd6503](https://github.com/johnlindquist/markdown-agent/commit/2fd6503add94a12b04d77e552b549068e10efb85)), closes [./file.ts#InterfaceName](https://github.com/./file.ts/issues/InterfaceName)

# [2.4.0](https://github.com/johnlindquist/markdown-agent/compare/v2.3.0...v2.4.0) (2025-12-07)


### Features

* always-on logging with per-agent log directories ([8b000f9](https://github.com/johnlindquist/markdown-agent/commit/8b000f97908d292c219c760ed546117ac2bcab7e))

# [2.3.0](https://github.com/johnlindquist/markdown-agent/compare/v2.2.0...v2.3.0) (2025-12-07)


### Features

* add structured logging with pino ([65bdf56](https://github.com/johnlindquist/markdown-agent/commit/65bdf56837f50fb7de82ebf8b631a71776273240))

# [2.2.0](https://github.com/johnlindquist/markdown-agent/compare/v2.1.1...v2.2.0) (2025-12-07)


### Features

* add $1 positional-to-flag mapping for commands ([43e6c54](https://github.com/johnlindquist/markdown-agent/commit/43e6c54e4697bdf4e37480414c034f909d5fc76f))

## [2.1.1](https://github.com/johnlindquist/markdown-agent/compare/v2.1.0...v2.1.1) (2025-12-07)


### Bug Fixes

* remove incorrect runner references from flags ([f33b83b](https://github.com/johnlindquist/markdown-agent/commit/f33b83bda34bafb505980ae5afd3b0e230208383))

# [2.1.0](https://github.com/johnlindquist/markdown-agent/compare/v2.0.0...v2.1.0) (2025-12-06)


### Features

* **docs:** add docs: frontmatter key for external documentation via into.md ([c7a7d7a](https://github.com/johnlindquist/markdown-agent/commit/c7a7d7ab2ab70027a7b3a4127160310374d0baf2))

# [2.0.0](https://github.com/johnlindquist/markdown-agent/compare/v1.0.0...v2.0.0) (2025-12-06)


### Features

* rename runners to harnesses and implement new unified frontmatter keys ([66ad305](https://github.com/johnlindquist/markdown-agent/commit/66ad305ed8b3df4afb2a010b33513ca284705abd))


### BREAKING CHANGES

* The 'runners' directory is now 'harnesses'. Old names still work via aliases.

New unified frontmatter keys with backward-compatible deprecated aliases:
- `approval`: enum ("ask" | "sandbox" | "yolo") replaces `allow-all-tools`
- `tools`: nested `{ allow, deny }` replaces `allow-tool`/`deny-tool`
- `dirs`: replaces `add-dir`
- `session`: unified `{ resume, fork }` replaces `resume`/`continue`
- `output`: replaces `output-format`

All harnesses (Claude, Codex, Gemini, Copilot) updated with:
- New key handling with `??` fallback to deprecated keys
- Consistent approval mode mapping across backends
- Session resume support via unified object
- Output format standardization

Tests updated with 95 passing tests covering both new and deprecated keys.

# 1.0.0 (2025-12-06)


### Bug Fixes

* **ci:** add Node.js 22 setup for semantic-release ([6a31cf6](https://github.com/johnlindquist/markdown-agent/commit/6a31cf68bf8003152271399f9ce62d3d8c04fd39))
* **copilot:** default --silent flag to on for session metadata suppression ([04f55f7](https://github.com/johnlindquist/markdown-agent/commit/04f55f7bfd610fddb77f7522fdb31b9669c1f7f8))


### Features

* add argument templating with {{ variable }} syntax ([205475b](https://github.com/johnlindquist/markdown-agent/commit/205475b2c3810fcf23bf810f28bca987e9f3c7ff))
* add batch/swarm mode and shell setup wizard ([7320397](https://github.com/johnlindquist/markdown-agent/commit/73203973a5fbc2ca1d2af0e85605d5b8f807b944))
* add dry-run / audit mode ([0c95390](https://github.com/johnlindquist/markdown-agent/commit/0c95390796e5094154c09fd6b16805720c60c044))
* add interactive input schema (wizard mode) ([0d3526d](https://github.com/johnlindquist/markdown-agent/commit/0d3526de51600f3452c51247b6b0f0ae604ddc19))
* add native context globs for file inclusion ([d60965f](https://github.com/johnlindquist/markdown-agent/commit/d60965f6395eafc8e57f156c48b3c45b3896b12b))
* add prerequisite guardrails for binaries and env vars ([bb00f9e](https://github.com/johnlindquist/markdown-agent/commit/bb00f9eb0181831985e007851ac1579a7c53a420))
* add remote execution from URLs (npx style) ([796dea8](https://github.com/johnlindquist/markdown-agent/commit/796dea87050315061cdc354482981b09f8c04015))
* add result caching for expensive LLM calls ([f1923d2](https://github.com/johnlindquist/markdown-agent/commit/f1923d2c600ecf3311aee3240db847366af41601))
* add robust YAML parsing with js-yaml and zod validation ([59aad98](https://github.com/johnlindquist/markdown-agent/commit/59aad98bc13ed5e0fa797c253193318a6b67d2e4))
* add structured output extraction ([56cb733](https://github.com/johnlindquist/markdown-agent/commit/56cb733d479a2bc5a2f9d57e800fdf70dfd40832))
* add true shebang support (#!) ([6093204](https://github.com/johnlindquist/markdown-agent/commit/6093204ee7c9dd10ffe57280d93d79b54b06cf3a))
* enhance CLI with multi-backend support and runner architecture ([86b1eb9](https://github.com/johnlindquist/markdown-agent/commit/86b1eb921db582362b0180d198aec1bbd3948d0f))
* **imports:** add [@file](https://github.com/file) imports and !`cmd` command inlines ([7d2bc2c](https://github.com/johnlindquist/markdown-agent/commit/7d2bc2c3585fa358f85249fd41c18012f64d32d7))
* rename to markdown-agent with ma alias ([ceddcc7](https://github.com/johnlindquist/markdown-agent/commit/ceddcc7f6d5e1f7403d550bc629b66e7e7b907ef))
