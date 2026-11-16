# Changelog

## 0.3.1

- **`--audit` and the whistle now read the configured evidence directory.**
  On Linux the default evidence directory lives under the DSH home
  (`~/.dsh/cache/selftest`), but `readLatest` hard-coded `<root>/.dsh`, so on
  every Linux host `--audit` returned `nothing` and the whistle never saw
  evidence. `readLatest` now takes the evidence directory.
- **CI Linux runners are not phones.** The phone default landing in the
  runner's home made in-tree evidence assertions invisible; the external
  default now applies only outside CI (`CI=true` keeps evidence in-tree).
- Node 18: the enforcement suite uses `fileURLToPath(import.meta.url)` instead
  of `import.meta.dirname` (Node >= 20.11), and pins its own evidence
  directory instead of inheriting the platform default.
- `test/support/sandbox.mjs` now ships with the package, so `npm test` works on
  an unpacked tarball as well as in a checkout.
- Tests: 9 suites / 167 cases; CI green on ubuntu/windows × node 18/20/22/24
  plus macOS.

## 0.3.0

- **Whistle** — the plugin now speaks on its own. At the end of a DSH turn that wrote
  files, it compares the currently changed files against the content signatures recorded
  by the last run and names the ones never verified in a single follow-up message.
  It only speaks: never runs checks, never edits, never blocks. Read-only turns never
  trigger it; at most `maxWhistlesPerSession` (default 2) per session; the same file at
  the same content is never named twice; every failure path stays silent. Config:
  `whistleMode: warn|off`, `requireWhistleAfterWrite`.
- **Neutral `checks` field** — every result exposes
  `[{ id, kind: 'command', title, command, required: true }]`. Any consumer (a
  claim/acceptance plugin, CI, an in-house scheduler) can run the command or read the
  whole JSON without knowing this plugin's internals. `claimChecks` remains as the
  deprecated alias with identical content.
- Each run records a **content signature per checked file** (`files[].signature`:
  size + mtime + sha256 prefix); the whistle uses it to tell "changed but never
  verified" from "verified, then untouched".
- i18n/mobile test cases that need piped child processes now **skip explicitly with a
  reason** in restricted sandboxes (`spawn EPERM`) instead of reporting a false failure.
- JavaScript import scanning ignores import-looking text inside **strings and comments**
  (a test fixture quoting `import './nope.js'`, or this repo's own regex comments, no
  longer registers as an unresolved import).
- **Enforcement (three layers)**:
  - `--audit` CLI for data consumers: exit `0` fresh/partial/nothing, `1`
    unverified/stale, `2` bad arguments; `--json` gives
    `{ verdict, total, verified, unverified, artifactPath }`. CI, git hooks and
    in-house schedulers gate on it.
  - `whistleMode: strict` keeps rejecting every turn while unverified files remain.
  - `hardGate: nag` (default): after a file write, the next non-read-only call is
    denied once until selftest runs. File writes and read-only calls are always
    allowed, so fix loops cannot deadlock; one denial per pending cycle; fail-open.
- **Attack hardening** (12 adversarial cases in `test/attack.mjs`):
  - `--audit` re-checks every file the evidence recorded, so rolling a file's
    mtime back (outside the scan window) or deleting a verified file no longer
    slips through.
  - The hard gate only accepts a `selftest` aimed at the session's own tree; a
    call with an unrelated `root` can no longer disarm it.
  - Documented known boundary: correctly forged local evidence is accepted — it
    is a plain JSON file with no secret, tested explicitly rather than hidden.

## 0.2.1

- Fix the red CI on Linux: platform-aware test assertions (missing PowerShell, npm test
  skipped on phones, evidence directory), and the gauntlet evidence test now pins
  `DSH_SELFTEST_EVIDENCE_DIR`.
- `verdict: partial` now also reports files that were **not checked** (unknown
  extensions) instead of returning a green pass for a tree where nothing ran.
- `--prove` covers relative-import resolution and the plugin-policy rule (11 cases).
- `--summary` lists the skipped files, not just their count.
- Optional `.sh` check via `bash -n`, and optional YAML validation through
  `DSH_SELFTEST_YAML` (e.g. a `python3` with PyYAML).
- `npm test` runs every suite; the CI matrix includes Node 24.

## 0.2.0

- Batch JavaScript checks in one child process (`lib/parse-js.mjs`) with relative
  import resolution — about 17x faster than one `node --check` per file on 20 files.
- `tsc -p <tsconfig> --noEmit` when `tsconfig.json` exists, instead of per-file tsc
  that ignored the project config.
- The batch exits 1 when any file fails, so the inherit-stdio sandbox fallback keeps
  the verdict.
- Shorter tool description (fewer characters in every session's context).

## 0.1.1

- Skip rules only apply below the root; explicit `--files` are never skipped.
- Git subdirectory roots via `rev-parse`/realpath (Windows short names included).
- Missing PowerShell/Python become explicit skips; `--prove` marks them inconclusive.
- `verdict: partial` + `coverage` for truncated, depth-limited and skipped checks.
- Linux phone defaults (30-minute window, depth 6, 30s timeout, 200 files, evidence
  under `$DSH_HOME/cache`), `quick` mode and `--summary`.

## 0.1.0

- Initial release: derived self-check for changed files, `selftest` tool + CLI.
