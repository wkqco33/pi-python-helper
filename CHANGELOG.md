# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html); the `0.y.z` series
does not guarantee a stable public tool schema.

## [Unreleased]

## [0.1.0] - 2026-09-21

### Added

- `py_project_inspect` reports environment conformance: the declared, locked, and actually-installed versions are compared in one place.
- `src/project/installed.ts` reads installed distributions from `.venv` without running Python, using only the bounded `METADATA` header block (~3 ms for 22 packages).
- `src/project/conformance.ts` classifies lock-versus-installed drift as version mismatch, missing required package, absent or non-editable project, untracked package, or an environment no lockfile describes.
- `py_validation_bundle` gained a conformance check: a passing test run against versions the lockfile does not describe fails the gate, and an unverifiable environment fails it too.
- `py_environment` reports the resolved interpreter, virtual-environment state, project root, and uv/tool availability.
- `py_project_inspect` analyses `pyproject.toml` and `uv.lock`, including layout, dependency groups, tool configuration, and lockfile drift.
- `py_dependency_plan` compares `ast`-scanned imports with declared dependencies, dev groups, extras, and `uv.lock`.
- `py_test_select` selects focused pytest targets from changed files using pytest naming conventions.
- `py_test` previews or runs `uv run --frozen pytest` and summarises counts, failing node ids, and the first project frame.
- `py_failure_diagnose` classifies the first actionable cause in Python, pytest, or uv output by position in the output.
- `py_sync` previews or runs `uv lock --check` and `uv sync --frozen`.
- `py_validation_bundle` chains lock check, sync, pytest, environment conformance, and a stale-artifact check into one evidence-oriented gate.
- `py_tdd_checkpoint` and `py_completion_evidence` provide conservative development and completion gates.
- `/py-status` reports a concise interpreter and project status.
- `helpers/scan_project.py` provides read-only `ast` import scanning and `tomllib` manifest parsing.
- Risk classification for shell commands, including compound-command segment inheritance and pipe-to-shell detection.
- `npm run test:e2e` verifies the scanner, pytest parser, failure diagnoser, and uv command builders against a real uv project.
- `docs/tools.md`, a generated tool reference, and `docs/api-surface.json`, a structure-only snapshot of every tool's parameters and return payload.
- `test/api-surface.test.ts` guards the public surface: the exact tool set, the parameter schemas, the captured return shapes, and the freshness of the reference document.
- `CONTRIBUTING.md` and a release workflow that publishes to npm with provenance after verifying the tag matches `package.json`.
- Tests for the environment probe (`test/environment.test.ts`) and the scanner CLI contract (`test/helper-cli.test.ts`), and a Python 3.10–3.13 CI matrix.

### Changed

- `py_environment` resolves tool availability from the project environment, PATH, and `uv.lock` instead of running `--version` for every tool. It went from ~210 ms to ~64 ms and now reports the *project's* version from the lockfile instead of the host's.
- `helpers/scan_project.py` accepts `--mode`, `--root`, `--max-files`, `--help`, and `--version`, validates the requested sections, and separates diagnostics (stderr) from results (stdout). Exit codes are now documented and stable: 0 success, 1 failure, 2 invalid input.
- The scanner emits `scannerVersion` and the extension refuses to interpret a document from an unknown protocol version.
- `mode` accepts a comma-separated section list, so a caller can request `environment,manifest` without running the import scan.
- `tsconfig.json` enables `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride`, and `noFallthroughCasesInSwitch`.

### Fixed

- A directory under `src/` is only reported as an importable module when it actually contains Python code. A TypeScript tree under `src/` was previously listed as a Python package's modules.
- Removed dead declarations in `src/build/failure.ts` and an unused import in `src/project/paths.ts`, both surfaced by the stricter compiler settings.
- `helpers/scan_project.py` no longer aborts the whole scan when a directory cannot be stat-ed. Layout detection, legacy manifest probing, and requirement discovery now degrade to "absent" instead of raising `PermissionError` (reproduced against `/tmp`, which contains a root-owned sibling).
- An unexpected scanner exception is now reported as structured JSON instead of a bare traceback on stderr.
- `py_failure_diagnose` now recognises pytest `--tb=short` frames (`path:line: in func`) and `E `-prefixed exception lines, which previously left real failures unclassified with no project frame.
- Failure diagnosis now selects the cause that appears first in the output instead of using a fixed pattern priority.
- `curl ... | sh` is classified as irreversible; it was previously masked by pipe-based segment splitting.

### Notes

- Package manager support is intentionally limited to uv; lint and type diagnostics are delegated to other extensions.
- `TYPE_CHECKING`-guarded imports are excluded from runtime dependency checks to avoid false positives.
- Unused-dependency reporting is opt-in because runtime plugins and console tools are not imported.
- Conformance compares only names that are provably required: declarations and lock edges with no marker, reached from the root project or from an installed package. Marker-guarded entries (`colorama` on Linux, `tomli` before 3.11) are counted as conditional instead of reported as missing, and interpreter-seeded distributions such as pip are excluded.
- The stale-installed-package mtime heuristic was replaced by the structural `PROJECT_INSTALLED_NOT_EDITABLE` check; coverage staleness remains the only mtime-based artifact check.
