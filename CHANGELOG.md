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
