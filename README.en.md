# dsh-selftest

[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4B67B4?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-amber?style=flat-square)](https://github.com/topics/dsh-plugin)
[![npm](https://img.shields.io/npm/v/dsh-selftest?style=flat-square&logo=npm)](https://www.npmjs.com/package/dsh-selftest)
[![npm downloads](https://img.shields.io/npm/dm/dsh-selftest?style=flat-square&logo=npm)](https://www.npmjs.com/package/dsh-selftest)
[![CI](https://github.com/Tirpitz-39/dsh-selftest/actions/workflows/ci.yml/badge.svg)](https://github.com/Tirpitz-39/dsh-selftest/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933.svg)](package.json)

[中文](README.md) | English

Derive checks from *what changed*, instead of relying on the model remembering to check.

Registers a `selftest` tool and ships the same logic as a command line entry point.

## What it solves

The "always test your changes" rule in an AGENTS.md is a rule written for humans: forget it or fake it and nothing notices.
This plugin turns it into code:

- **Collect changes**: `git status --porcelain` (including untracked files) ∪ files whose mtime changed in the last N minutes (works outside git too)
- **Derive a checker from the extension**: unknown extensions are recorded as `skip` with a reason, never silently passed
- **Find the tests that own the change**: walk up to 3 levels and run the changed plugin's / project's own test suite
- **Changed plugin source with no tests at all → FAIL**, not "looks fine"
- **A whistle speaks at turn end** after files were written, naming the changes that were never verified

## How it differs from similar tools

Many tools check "the things you changed", but trigger and verdict rules differ:

| Tool | Trigger | Input | Coverage | Key difference from selftest |
|---|---|---|---|---|
| [lint-staged](https://github.com/okonet/lint-staged) | `git commit` | staged files | configured linters | runs no tests; configured types only; requires git |
| [pre-commit](https://github.com/pre-commit/pre-commit) | `git commit` | staged files | any hook | hook framework, does not derive "what to check" |
| [lefthook](https://github.com/evilmartians/lefthook) | git hooks | per glob | fast hook orchestration | scheduler, no check derivation |
| [nx affected](https://github.com/nrwl/nx) | CI / local | project graph | build + test | requires nx adoption, heavy |
| [danger-js](https://github.com/danger/danger-js) | PR / CI | changed files | custom rules | CI-side, not local-instant |
| **dsh-selftest** | **any moment (tool / CLI call)** | git status + mtime | syntax + owning tests + no-test failure | no git hook needed; unknown extensions skip with a reason; built for AI agent sessions |

In short: it is for "an AI just edited code, check it right now", not a commit hook and not a CI system.

## Check matrix

| Change | Check | Verdict |
|---|---|---|
| `.ps1` `.psm1` `.psd1` | PowerShell parser + Windows PowerShell 5.1 encoding rule (non-ASCII without BOM is a defect) | parse error or encoding defect → fail |
| `.js` `.mjs` `.cjs` | one batch process: `vm.Script`/`vm.SourceTextModule` syntax check + relative import resolution | syntax error or unresolved relative import → fail |
| `.json` | `JSON.parse` (BOM tolerated) | parse error → fail |
| `.ts` `.tsx` | `tsc -p <tsconfig> --noEmit` when `tsconfig.json` exists, else per-file `tsc --noEmit`; only when `tsc` is configured | not configured → skip |
| `.py` | `ruff check`, or `python -m py_compile` when ruff is absent | non-zero exit → fail |
| `.sh` `.bash` | `bash -n` (discovered on PATH) | non-zero exit → fail; no bash → skip |
| `.yml` `.yaml` | optional: configure `DSH_SELFTEST_YAML` (e.g. python3 + PyYAML) | not configured → skip |
| Anything else | — | skip, with the reason attached |
| Owning tests | `<dir>/test/*.mjs` (prefers `test.*` / `*.test.*` / `*.spec.*`), or `package.json` `scripts.test` | non-zero exit → fail |

Test discovery walks up at most 3 levels: changing `plugins/dsh-guard/lib/index.js` finds and runs `plugins/dsh-guard/test/test.mjs`.

## Installation

Requires Node.js 18+.

**From npm** (recommended):

```bash
npm i -g dsh-selftest@0.2.1     # global CLI
npx dsh-selftest@0.2.1           # or run it once
```

**As a DSH plugin**: `dsh plugin add dsh-selftest` (or place the package in the profile's `node_modules`) and enable it in DSH; the `selftest` tool is then available.

**Standalone CLI**:

```bash
node lib/cli.js                 # check the current directory's changes
node lib/cli.js --explain       # print the plan only
node lib/cli.js --files a.ps1,b.json
node lib/cli.js --quick         # syntax/JSON checks only
node lib/cli.js --summary       # short output for a phone chat pane
```

**Optional dependencies** (install on demand; the matching check is skipped when absent):

- PowerShell 7 (for `.ps1`): `winget install Microsoft.PowerShell`
- git (for change collection): usually already present
- `tsc` / `ruff`: only needed to enable `.ts` / `.py` checks

Every external program is **discovered**, never hard-coded: environment variable → PATH → common install locations (including the runtime bundled under `$DSH_HOME`).

## Usage

Tool:

```
selftest                          # check the session workspace's changes
selftest { action: "plan" }       # print the plan, execute nothing
selftest { root: "/path/to/tools", since: 60 }
selftest { files: ["a.ps1"] }     # check only these files
selftest { prove: true }          # health-check the checkers before trusting them
```

CLI:

```
node lib/cli.js [root] [--explain] [--json] [--quiet] [--no-persist] [--prove] [--audit]
```

`--prove` is the checker health check: 11 known samples (broken JS, broken JSON, an encoding-defective `.ps1`, a failing test, a missing file / root, an unknown extension, an unresolved relative import, a changed plugin with no tests, clean code, an empty directory) verify that "what should go red does go red, and what should go green does go green". A checker that has not been checked itself has no business checking your code. Only 11/11 counts as healthy.

Exit codes: `0` passed / nothing to check / `--explain`; `1` at least one failure; `2` bad arguments.

The tool result carries a neutral `checks` list that any consumer can use:

```json
{ "id": "selftest", "kind": "command", "title": "selftest passed: …", "command": "<node> …cli.js --root … --no-persist --quiet [--files …]" }
```

> A claim/acceptance plugin (e.g. `claim_plan` in dsh-claimcheck), a CI job or an in-house scheduler can run that command or read the whole JSON as-is; Harnesses without a consumer just use the exit code. `claimChecks` is the old field name and carries the same content.

## Language

User-facing text is available in Chinese and English. Resolution order:

1. `DSH_SELFTEST_LANG` (`zh` / `en`)
2. `LC_ALL` / `LC_MESSAGES` / `LANG` / `LANGUAGE`
3. the system locale from `Intl` (a Chinese system defaults to `zh`, everything else to `en`)

The `--help` text, `--json` `text`, `--quiet` line, `--prove` output, error messages and `checks` titles all follow the selected language.

## Evidence

`<root>/.dsh/selftest/latest.json` and `runs/<id>.json`, keeping the most recent 50 (`keepRuns`).

Each run records a content signature per checked file (`files[].signature`: size + mtime + the first 16 hex chars of sha256); the whistle uses it to tell "changed but never verified". A signature is a freshness signal, not a security boundary.

The result's `checks` is a neutral list: `[{ id, kind: 'command', title, command, required: true }]`. Any consumer — a claim/acceptance plugin, CI, an in-house scheduler — can run the command or read the whole JSON without knowing this plugin's internals. (`claimChecks` is kept as the old field name; its content is identical.)

## Whistle (it speaks up on its own)

Tools wait to be called; the whistle speaks at the end of a DSH turn, so the check no longer depends on the model remembering it:

1. it watches this turn's tool results: `write` / `edit`, or shell commands that write files, mark the turn as changed;
2. at `agent/turn-stopping` it compares the currently changed files against the signatures recorded in `latest.json`;
3. files that were "changed but never verified" (or verified and then edited again) are named in one follow-up message.

Boundaries (deliberate):

- it only speaks: never runs checks, never edits, never blocks;
- read-only turns never trigger it; at most `maxWhistlesPerSession` (default 2) per session;
- the same file at the same content is named once; new content speaks again;
- every failure path stays silent — a whistle never breaks a turn;
- `whistleMode: off` (or `DSH_SELFTEST_WHISTLE_MODE=off`) disables it.

Configuration in the profile's `cordis.patch.yml`:

```yaml
- id: dsh-selftest
  config:
    whistleMode: warn            # warn | off
    maxWhistlesPerSession: 2
    requireWhistleAfterWrite: true
```

## Enforcement (rejecting unverified flows)

Reminders are soft; enforcement needs an exit code. Three layers, from universal to hard.

### 1) Data-consumer entry: `--audit`

```
node lib/cli.js --root <dir> --audit [--json]
```

Evidence only, no checks: it compares the signatures recorded in `.dsh/selftest/latest.json` with the changed files on disk right now.

| Exit | Meaning |
|---|---|
| `0` | `fresh` / `partial` / `nothing` — continue |
| `1` | `unverified` (never checked, or changed since) or `stale` (last verdict was not pass) — **rejected** |
| `2` | bad arguments |

`--json` prints `{ verdict, total, verified, unverified: [{ rel, reason }], artifactPath }`. CI, git hooks and in-house schedulers can just read the exit code; scripts that need detail parse the JSON.

### 2) In-session: `whistleMode: strict`

With unverified files at turn end it keeps rejecting every turn (bounded by `maxWhistlesPerSession`) until selftest passes. `warn` speaks once; `strict` speaks every turn.

### 3) Hard gate: `hardGate: nag` (on by default)

After a file write, the next non-read-only call is **denied once** with a reason telling you to run selftest:

- allowed: `selftest`, read-only tools (read / grep / glob …), `write` / `edit` (so fixing a failing check is never deadlocked)
- denied once: shell commands (including `git commit`, `npm install`), unknown tools
- only one denial per pending cycle; running `selftest` clears it

Configuration:

```yaml
- id: dsh-selftest
  config:
    whistleMode: strict          # warn | strict | off
    maxWhistlesPerSession: 10
    hardGate: nag                # nag | off
```

> All three switch independently. `--audit` alone never touches a session; for in-session enforcement turn on `strict` + `hardGate`.

## Configuration (environment variables, all with defaults)

| Variable | Default | Meaning |
|---|---|---|
| `DSH_SELFTEST_NODE` | auto-detected | node used for syntax checks and tests |
| `DSH_SELFTEST_PWSH` | auto-detected | PowerShell used to parse `.ps1` (`pwsh` → `powershell` on Windows) |
| `DSH_SELFTEST_PARSE_PS1` | bundled `lib/parse-ps1.ps1` | batch parser script (shipped with the package, no external file needed) |
| `DSH_SELFTEST_TSC` | empty | enables TypeScript checks when set |
| `DSH_SELFTEST_RUFF` | empty | enables ruff when set, otherwise `py_compile` |
| `DSH_SELFTEST_GIT` | auto-detected | git executable |
| `DSH_SELFTEST_STRICT_PLUGINS` | `1` | `0` disables "changed plugin without tests is a failure" |
| `DSH_SELFTEST_LANG` | system locale | UI language: `zh` / `en` (also honours `LC_ALL`/`LANG`; Chinese systems default to `zh`, others to `en`) |
| `DSH_SELFTEST_SINCE_MINUTES` | 10 (Linux 30) | mtime lookback, minutes |
| `DSH_SELFTEST_TIMEOUT_MS` | 120000 (Linux 30000) | per-step timeout |
| `DSH_SELFTEST_MAX_FILES` | 500 (Linux 200) | collected file cap |
| `DSH_SELFTEST_MAX_DEPTH` | 4 (Linux 6) | mtime scan depth |
| `DSH_SELFTEST_EVIDENCE_DIR` | `<root>/.dsh/selftest` (Linux `$DSH_HOME/cache/selftest`) | evidence directory |
| `DSH_SELFTEST_PLUGIN_ROOTS` | empty | extra plugin roots (comma-separated absolute paths; direct children are plugins) |
| `DSH_SELFTEST_QUICK` | `0` | `1` is the same as `--quick` |
| `DSH_SELFTEST_BASH` | auto-detected | bash for `bash -n` on `.sh` |
| `DSH_SELFTEST_YAML` | empty | YAML validator executable (e.g. `python3` with PyYAML); empty = skip YAML |
| `DSH_SELFTEST_WHISTLE_MODE` | `warn` | whistle: `warn` / `strict` / `off` |
| `DSH_SELFTEST_MAX_WHISTLES` | 2 | whistle messages per session |
| `DSH_SELFTEST_HARD_GATE` | `nag` | hard gate: `nag` / `off` |

## Phones / low-power platforms

On `process.platform === 'linux'` the defaults switch to a phone profile: 30-minute mtime window, depth 6, 30-second per-step timeout, 200-file cap, and evidence under `$DSH_HOME/cache/selftest` (the workspace may be read-only or a mount).

- `.ps1` without a usable PowerShell → explicit skip (not a spawn failure); `--prove` marks that case inconclusive instead of counting it as verified
- `.py` without `python`/`python3` → explicit skip
- `npm test` is not run by default (process startup is expensive); runnable `test/*.mjs` files are still executed with node
- the tool layer passes `--summary` automatically on Linux: verdict line, failures (max 8), skip count and evidence path
- `selftest { quick: true }` (or `--quick`) runs syntax/JSON checks only, for "check what I just changed"
- `.dsh`, `build`, `dist` directory names are only skipped below the root; a root that itself lives under `/root/.dsh/...` works normally
- files passed explicitly via `--files` are never skipped

## Coverage completeness (partial)

When a result is incomplete the verdict is `partial` (exit code stays 0 — it does not fake failure): files were truncated by `maxFiles`, `maxDepth` cut off deeper directories, or a check was skipped for a missing tool/runner. The `coverage` field reports `{ truncated, depthLimited, skippedTools }`; `sources.truncated` / `sources.depthLimited` mirror it.

**Node discovery**: the Harness host is Electron, so `process.execPath` is `DSH NEXT.exe` and is not node; feeding it `--check` always fails. Discovery order is `DSH_SELFTEST_NODE` → self is node → PATH → runtime bundled under `$DSH_HOME`.

## The tool layer is a thin shell

The `selftest` tool executes no check logic itself: it translates arguments into CLI arguments, spawns `lib/cli.js --json` with a real node, and returns the JSON.

Two reasons:

1. the Harness host is Electron, so `process.execPath` is `DSH NEXT.exe`, not node — the tool layer must discover a usable node;
2. the Harness loads plugin modules statically, so **editing logic under `lib/` would not hot-reload**. Running the logic in a child process means edits take effect on the next call without restarting the Harness.

Only changing `lib/index.js` itself (argument mapping, tool description) requires a restart.

### Results must be lossless JSON

Tool return values cannot contain `undefined` or `NaN`: `JSON.stringify` drops them and the Harness rejects the whole call with `value is not lossless JSON`. `toLossless()` in `lib/core.js` converts `undefined` and non-finite numbers to `null` at the boundary.

## Degradation in restricted sandboxes

Checks triggered from inside a restricted sandbox (for example by an external acceptance tool) run where named pipes **cannot be created** (`spawn EPERM`) and writes outside the workspace may be denied.

Handling:

- pipe spawn fails → retry with `stdio: 'inherit'`; the child's output passes through and **the exit code still decides pass/fail**
- temp files (`.ps1` batch lists) fall back through `%TEMP%` → cwd → step directory
- `--no-persist` keeps sandboxed runs from writing evidence files

Hence `lib/parse-ps1.ps1` also `exit 1`s when it finds a broken file — even if stdout cannot be captured, the verdict is not lost.

Cost: in restricted environments a `.ps1` batch collapses to one line (no per-file detail), but the verdict stays correct.

## Known limits

- **It cannot verify user-visible behaviour.** Syntax being correct does not mean behaviour is correct; after changing a UI or command you still have to run it once yourself.
- File collection relies on git + mtime; a change that is neither committed nor touched within N minutes is not discovered.
- Test discovery only knows convention directories; it does not parse in-code test markers.
- In a sandbox that forbids `spawn` outright it cannot work (currently only piped stdio is restricted; inherit mode works). Tests that need piped children skip explicitly there instead of pretending to pass.
- **Local evidence can be forged**: `.dsh/selftest/latest.json` is a plain JSON file with no secret; anyone who can read the files can compute the same signatures and forge a `pass`. `--audit` does prevent "changed a file but did not update the evidence" (including rolling mtime back or deleting a file — it re-checks every file the evidence recorded), but it does not prevent "forge the evidence too". There is a dedicated case in `test/attack.mjs`; this is stated, not hidden.
- `--audit` reports a file that was recorded in the evidence and is now **deleted** as `unverified` (`auditDeletedSince`); it never silently passes it.
- Only plugin directories whose absolute path contains `\dev\plugins\<name>\` are scanned; plugins elsewhere do not trigger "no tests is a failure".
- A file explicitly passed via `--files` that does not exist is judged fail (never quietly treated as "nothing to check").
- **It executes code from the workspace**: `scripts.test` and `test/*.mjs` are spawned directly. On an untrusted repository, read the tests before running.
- No YAML parser is bundled: `.yml`/`.yaml` are skipped by default. Configure `DSH_SELFTEST_YAML` (an interpreter that can `import yaml`) to validate them; a broken validator fails instead of pretending to pass.

## Development & tests

```bash
node test/test.mjs       # unit + end-to-end, 28 cases
node test/i18n.mjs       # UI language (zh / en), 11 cases
node test/mobile.mjs     # phone/portability regressions, 12 cases
node test/gauntlet.mjs   # "order fried rice at a bar" group 1, 24 assertions
node test/gauntlet2.mjs  # group 2 (git/input/output contract), 20 scenarios, 28 assertions
node test/gauntlet3.mjs  # group 3 (--prove health check and flag combinations), 21 assertions
node test/whistle.mjs    # whistle (signature diff, event flow, budget, neutral checks field), 15 cases
node test/force.mjs      # enforcement (--audit exit codes, strict rejection, hard-gate decisions), 14 cases
```

`gauntlet*.mjs` does not test features, it tests **whether the tool lies**: an unknown extension must be skipped rather than silently passed, an explicitly requested missing file must fail, a binary file must not be misjudged, a hung test must time out as a failure, a 500+ file truncation must be marked explicitly, `--explain` must not secretly execute.

The second group also covers: git untracked/modified/deleted, `node_modules` skipping, `.ts` without a compiler explaining itself, a missing root must error, strictly parseable `--json`, the exit-code contract (1=fail, 2=bad args), single-line `--quiet`, `--no-persist` not writing, evidence file shape, Chinese and emoji paths, relative path inputs, Windows case de-duplication, a 5MB JSON, read-only files, a corrupted `.git`.

The third group hammers `--prove`: health results must be really red and really green (not claimed), no evidence writes, no dirtying of the git workspace, temp directories cleaned up, idempotent, and defined behaviour with a missing root / `--files` / `--plan`.

28 cases: prove health check, git output parsing, grouping by extension, test discovery (test files before `scripts.test`), plugin policy, report persistence and pruning, real `.ps1` parsing (skipped without pwsh), end-to-end pass / fail / plan / no changes, missing-file fail, tool registration shape.

All fixtures are created under the OS temp directory; the suite never "passes" by inspecting the real workspace instead of the code.

## Release

Pushing a tag (`v*`, matching `package.json`) triggers `.github/workflows/release.yml`:
full test suite → `npm pack --dry-run` to verify the tarball → tag/version check → `npm publish`.
A normal push never publishes.

Pick one auth path before the first release:

- add `NPM_TOKEN` (an npm automation token) to the repository secrets;
- or configure npm trusted publishing (OIDC) and drop `NODE_AUTH_TOKEN` from the workflow.

CI runs Ubuntu + Windows on Node 18/20/22/24, and a single macOS job on Node 22
(portability only, not the full matrix).

## Author

大肥鱼 (the whale girl living inside DSH) · built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

## License

MIT
