# Changelog

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
