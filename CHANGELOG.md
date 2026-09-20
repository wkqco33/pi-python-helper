# Changelog

All notable changes are documented here.

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

### Fixed

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
