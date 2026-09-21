# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html); the `0.y.z` series
does not guarantee a stable public tool schema.

## [Unreleased]

## [0.2.0] - 2026-09-22

### Fixed

- `py_sync` and `py_validation_bundle` no longer delete the project's own dev tooling. `uv sync --all-groups` covers `[dependency-groups]` only, so a project declaring pytest/ruff/pyright in `[project.optional-dependencies]` had them **uninstalled**; the sync now also passes `--all-extras`, and `extras: 'none'` is available when that is not wanted. The destructive behaviour used to report `ok: true`.
- `py_validation_bundle` re-checks that pytest is runnable between the sync and the test step instead of trusting the sync exit code, and reports the skip reason rather than an unclassified failure.
- The scanner now runs under `<root>/.venv`'s interpreter when one exists, so import-to-distribution mapping describes the project environment. A host `python3` mapped 4 modules while the project interpreter mapped 84, which made `import wconfig` look unowned and produced a `uv add wconfig` suggestion for a distribution that does not exist. `py_environment` also reports the project's Python version instead of the host's.
- `providerMappingReliable` is no longer `true` when an interpreter could see an environment but owned none of the project's imports; partial mappings add an `UNMAPPED_IMPORTS` note.
- `py_project_inspect` no longer reports a false `INSTALLED_VERSION_MISMATCH` for marker-split lock entries. uv writes one entry per marker branch, and comparing a single arbitrary entry flagged a correctly synced 3.12 environment for having 25.1.0 where the 3.14 branch said 21.2.0.
- `py_project_inspect` no longer reports `PROJECT_NOT_INSTALLED` for a project uv records as `source = { virtual = "." }`. Such a project is intentionally never installed into `.venv`; the finding also claimed "no test can exercise it", which was false. Disclosed as the `PROJECT_VIRTUAL_SOURCE` note instead.
- `py_project_inspect` finds tests that live inside the package under test (`<package>/tests/`), not only `./tests`, and detects pytest configuration in `pytest.ini`, `tox.ini`, and `setup.cfg` rather than `pyproject.toml` alone.
- `py_failure_diagnose` classifies `Failed to spawn: \`pytest\`` and `command not found` as `tool_not_installed` instead of `unknown`, keeping the positional first-cause rule.
- `py_test_select` no longer matches every candidate when tests live inside the package under test. Signals shared by all candidates (the package name and its tokens) are discarded, so a package-rooted test tree narrows instead of selecting 30 of 30 files.
- `py_test_select` excludes test infrastructure (`tests/__init__.py`, `tests/utils.py`) from pytest targets and reports it separately, and discloses when a selection was not narrowed.
- `py_dependency_plan` no longer fabricates `uv add <import name>` when the providing distribution is unknown; it names the distribution from installed metadata when available and asks the caller to look it up otherwise.

### Added

- `py_test_select` matches a test file to a changed module by the modules the test **imports**, which is the strongest available signal: `test_db_session.py` gives no naming hint that it covers `db/database.py`. The scanner reports `importModules` per file for this (protocol version 2).
- `py_validation_bundle` runs the lint/type tools the project declares (`quality: true` by default): `ruff` and `pyright` when declared, `mypy` only when `[tool.mypy]` exists. The bundle previously ignored the checks CI actually runs.
- `py_test` accepts `extraArgs` so project-standard pytest flags such as coverage options can be passed without the tool modelling each one.
- `py_sync` accepts `extras` (`all` by default) and reports the installed/uninstalled inventory from uv's output.
- `py_environment` reports `interpreterOrigin` and splits tool availability into `available` (runnable now), `installed` (console script in the project environment), and `installable` (declared in `uv.lock` but absent), with a `TOOL_NOT_INSTALLED` warning.
- `py_tdd_checkpoint` records which paths matched and on which tokens (`associations`) and flags a match that rests only on the shared package prefix (`weakAssociation`).

### Changed

- **Breaking:** `py_environment.tools[].available` now means "an executable was found", not "declared or found". A distribution recorded in `uv.lock` is `installable`, so a broken environment no longer looks healthy. Read `installable` for the previous meaning.
- **Breaking:** scanner protocol `SCANNER_VERSION` is now 2; a scanner reporting version 1 is rejected with `SCANNER_VERSION_MISMATCH`.

## [0.1.1] - 2026-09-21

### Changed

- Refactored `src/dependencies/plan.ts` by extracting static import aliases and console-only distribution tables into `src/dependencies/aliases.ts`.
- Refactored `src/build/failure.ts` by extracting Python and pytest traceback frame parsing and library frame detection into `src/build/traceback.ts`.
- Decomposed monolithic `inspectProject` in `src/project/inspect.ts` into focused diagnostic collectors for manifest, lockfile, and environment rules.
- Moved `py_tdd_checkpoint` and `py_completion_evidence` tools from `extensions/tools/dependencies.ts` to `extensions/tools/validation.ts` to align tool registration with module responsibilities.

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
