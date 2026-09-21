# 도구 레퍼런스 (Tool reference)

> 이 문서는 생성된 파일입니다. 직접 편집하지 마세요.
>
> ```bash
> npm run docs          # 이 문서와 docs/api-surface.json을 다시 생성
> ```
>
> 출처: `extensions/`의 도구 등록(설명·파라미터)과 `docs/api-surface.json`(반환 형태 스냅샷).

## 응답 규격 (Response envelope)

모든 도구는 동일한 `PyToolResult` 규격을 반환합니다. 반환 형태는 구조만 기록하며 값·경로·버전·소요시간은 스냅샷에서 제외합니다.

- `attention`: boolean
- `commands` (optional): array of
  - `args`: array<string>
  - `cwd`: string
  - `executable`: string
  - `risk`: string
- `data`: object
- `errors`: array of
  - `code`: string
  - `line` (optional): number
  - `message`: string
  - `path` (optional): string
  - `severity`: string
- `evidence`: array of object
- `metadata`: object
  - `cwd`: string
  - `durationMs`: number
  - `projectRoot` (optional): string
  - `pythonVersion` (optional): string
  - `toolVersion`: string
  - `truncated`: boolean
- `ok`: boolean
- `projectRoot` (optional): string
- `pythonVersion` (optional): string
- `suggestions`: array of
  - `command` (optional): string
  - `confidence`: string
  - `message`: string
- `summary`: string
- `warnings`: array of
  - `code`: string
  - `message`: string
  - `path` (optional): string
  - `severity`: string

`data`와 `evidence`의 내부 형태는 도구마다 다르며, 아래 각 도구 섹션에 기록되어 있습니다.

## 스냅샷 캡처 조건 (Capture conditions)

반환 형태는 다음 파라미터로 참조 프로젝트(`scripts/api-docs/fixture.ts`)를 진단해 캡처했습니다. 모든 호출은 읽기 전용입니다.

| 도구 | 파라미터 |
|---|---|
| `py_environment` | `{}` |
| `py_project_inspect` | `{}` |
| `py_dependency_plan` | `{"includeUnused":true}` |
| `py_tdd_checkpoint` | `{"changedPaths":["src/ledger/totals.py","tests/test_other.py"]}` |
| `py_completion_evidence` | `{"syncExecuted":false,"syncOk":false,"testExecuted":false,"testOk":false,"stale":false,"changedPaths":["src/le…` |
| `py_test_select` | `{"changedPaths":["src/ledger/totals.py"]}` |
| `py_test` | `{"execute":false}` |
| `py_failure_diagnose` | `{"output":"============================= test session starts ==============================\ncollected 2 items…` |
| `py_sync` | `{"mode":"check","execute":false}` |
| `py_validation_bundle` | `{"execute":false}` |

## 도구 (Tools)

### `py_completion_evidence`

Build a conservative completion report from environment sync and test execution results. Read-only.

- 시스템 프롬프트 한 줄: `Create evidence for a Python completion report`
- 라벨: Python Completion Evidence
- 프로젝트 상태 변경: 없음 (읽기 전용)

**파라미터**

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `changedPaths` | `array<string>` | 예 | maxItems 500 |
| `stale` | `boolean` | 예 | Whether stale artifacts were detected. |
| `syncExecuted` | `boolean` | 예 | Whether uv lock --check / uv sync actually ran. |
| `syncOk` | `boolean` | 예 | — |
| `testExecuted` | `boolean` | 예 | Whether pytest actually ran. |
| `testOk` | `boolean` | 예 | — |

**프롬프트 가이드라인**

- Use py_completion_evidence before claiming Python work is complete; a partial run is not evidence.

**반환 `data` 형태**

- `blockers`: array<string>
- `changedPaths`: array<string>
- `ok`: boolean

### `py_dependency_plan`

Compare imports found with ast against declared dependencies, dev groups, and uv.lock, and preview the uv commands that would fix the drift. Read-only.

- 시스템 프롬프트 한 줄: `Plan Python dependency changes from declared and imported packages`
- 라벨: Python Dependency Plan
- 프로젝트 상태 변경: 없음 (읽기 전용)

**파라미터**

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `includeUnused` | `boolean` | 아니오 | Also report declared packages that no file imports. Off by default because runtime plugins and console tools produce false positives. |
| `path` | `string` | 아니오 | Project directory to analyse. |

**프롬프트 가이드라인**

- Use py_dependency_plan before editing dependencies, and whenever an import fails or a package may be declared in the wrong group.
- Use py_dependency_plan to detect drift between pyproject.toml and uv.lock instead of reading the lockfile by hand.

**반환 `data` 형태**

- `declared`: array of
  - `groups`: array<string>
  - `name`: string
  - `normalized`: string
- `declaredCount`: number
- `drift`: object
  - `lockPresent`: boolean
  - `missingFromLock`: array<string>
  - `requiresPythonMismatch`: null
  - `unsatisfiedInLock`: array of
    - `locked`: string
    - `name`: string
    - `specifier`: string
- `misplaced`: array of
  - `declaredIn`: array<string>
  - `distribution`: string
  - `import`: string
  - `runtimeFiles`: array<string>
- `notes`: array of
  - `code`: string
  - `message`: string
  - `severity`: string
- `providerMappingReliable`: boolean
- `suggestions`: array of
  - `command`: string
  - `confidence`: string
  - `message`: string
- `thirdPartyImportCount`: number
- `undeclared`: array of
  - `fileCount`: number
  - `files`: array<string>
  - `import`: string
  - `providerKnown`: boolean
  - `providers`: array<…>
  - `reason`: string
  - `suggestedDistribution`: string
  - `typeCheckingOnly`: boolean
- `unmappedImports`: number
- `unparsable`: array<…>
- `unused`: array of
  - `groups`: array<string>
  - `name`: string
  - `normalized`: string
- `warnings`: array of
  - `code`: string
  - `message`: string
  - `path`: string
  - `severity`: string

### `py_environment`

Inspect the active Python interpreter, virtual environment, uv availability, and project root. Read-only.

- 시스템 프롬프트 한 줄: `Inspect the current Python interpreter and uv environment`
- 라벨: Python Environment
- 프로젝트 상태 변경: 없음 (읽기 전용)

**파라미터**

(파라미터 없음)

**프롬프트 가이드라인**

- Use py_environment before running Python commands when the active interpreter, virtual environment, or uv availability is unknown.

**반환 `data` 형태**

- `interpreter`: string
- `interpreterOrigin`: string
- `projectRoot`: string
- `python`: object
  - `basePrefix`: string
  - `candidateVenvDir`: string
  - `condaPrefix`: null
  - `executable`: string
  - `implementation`: string
  - `inVirtualEnvironment`: boolean
  - `platform`: string
  - `prefix`: string
  - `stdlibModuleNames`: boolean
  - `tomlAvailable`: boolean
  - `version`: string
  - `versionInfo`: array<number>
  - `virtualEnv`: null
- `suggestions`: array<…>
- `tools`: array of
  - `available`: boolean
  - `declared`: boolean
  - `executable`: string
  - `installable`: boolean
  - `installed`: boolean
  - `name`: string
  - `origin`: string
  - `preferredInvocation`: string
  - `version` (optional): string
  - `versionSource`: string
- `uv`: object
  - `available`: boolean
  - `lockPresent`: boolean
  - `version`: string
- `venvDir`: string
- `warnings`: array<…>

### `py_failure_diagnose`

Classify the first actionable cause in bounded Python, pytest, or uv output and point at the first non-library traceback frame. Read-only.

- 시스템 프롬프트 한 줄: `Diagnose the first actionable Python failure`
- 라벨: Python Failure Diagnose
- 프로젝트 상태 변경: 없음 (읽기 전용)

**파라미터**

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `output` | `string` | 예 | Bounded stdout/stderr from the failing command. |
| `path` | `string` | 아니오 | Project directory used to classify the missing module. |

**프롬프트 가이드라인**

- Use py_failure_diagnose on bounded command output instead of reading a full traceback in context; traceback frames inside site-packages are never the cause.

**반환 `data` 형태**

- `evidence`: array of
  - `file`: string
  - `line`: number
  - `message`: string
- `exceptionType`: string
- `firstUserFrame`: object
  - `func`: string
  - `library`: boolean
  - `line`: number
  - `path`: string
- `frames`: array of
  - `func`: string
  - `library`: boolean
  - `line`: number
  - `path`: string
- `kind`: string
- `libraryFrameCount`: number
- `suggestions`: array of
  - `confidence`: string
  - `message`: string
- `summary`: string
- `totalFrameCount`: number

### `py_project_inspect`

Inspect pyproject.toml, uv.lock, dependency groups, layout, and tool configuration, and report lockfile drift. Read-only.

- 시스템 프롬프트 한 줄: `Inspect a Python project manifest and lockfile`
- 라벨: Python Project Inspect
- 프로젝트 상태 변경: 없음 (읽기 전용)

**파라미터**

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `path` | `string` | 아니오 | Project directory, pyproject.toml path, or uv.lock path. |

**프롬프트 가이드라인**

- Use py_project_inspect before editing pyproject.toml or uv.lock, and whenever the project layout or dependency groups are unclear.

**반환 `data` 형태**

- `buildBackend`: string
- `conformance`: object
  - `checks`: object
    - `installedScanned`: boolean
    - `lockPresent`: boolean
    - `projectEditable`: boolean
    - `projectInstallable`: boolean
    - `projectInstalled`: boolean
    - `venvPresent`: boolean
  - `complete`: boolean
  - `counts`: object
    - `conditional`: number
    - `installedPackages`: number
    - `lockPackages`: number
    - `markerSplitNames`: number
    - `mismatched`: number
    - `missing`: number
    - `untracked`: number
  - `findings`: array of
    - `code`: string
    - `expected`: string
    - `message`: string
    - `name`: string
  - `notes`: array<…>
  - `reason`: string
  - `verdict`: string
  - `warnings`: array of
    - `code`: string
    - `message`: string
    - `severity`: string
- `dependencyCounts`: object
  - `groups`: object
    - `dev`: number
  - `optional`: object
    - `aws`: number
  - `runtime`: number
- `entryPoints`: array<…>
- `importName`: string
- `installed`: object
  - `count`: number
  - `editableCount`: number
  - `sitePackages`: string
- `layout`: string
- `lock`: object
  - `packageCount`: number
  - `path`: string
  - `present`: boolean
- `modules`: array<string>
- `name`: string
- `notes`: array of
  - `code`: string
  - `message`: string
  - `severity`: string
- `pyproject`: string
- `requirementsFiles`: array<…>
- `requiresPython`: string
- `root`: string
- `suggestions`: array of
  - `command`: string
  - `confidence`: string
  - `message`: string
- `toolConfiguration`: object
  - `coverage`: boolean
  - `hatch`: boolean
  - `mypy`: boolean
  - `pyright`: boolean
  - `pytest`: boolean
  - `ruff`: boolean
  - `ty`: boolean
- `uvLock`: string
- `uvSources`: array<…>
- `uvWorkspaceMembers`: array<…>
- `venvDir`: string
- `version`: string
- `warnings`: array of
  - `code`: string
  - `message`: string
  - `path` (optional): string
  - `severity`: string

### `py_sync`

Preview or run uv lock --check or uv sync --frozen. Execution is opt-in because it modifies .venv. Does not edit sources.

- 시스템 프롬프트 한 줄: `Preview or run the uv environment sync`
- 라벨: Python Sync
- 프로젝트 상태 변경: `execute: true` 옵트인 필요

**파라미터**

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `execute` | `boolean` | 아니오 | — |
| `extras` | `"all" | "none"` | 아니오 | Whether sync requests every [project.optional-dependencies] extra. Defaults to all: without it uv removes extras such as the dev tooling. |
| `mode` | `"check" | "sync"` | 아니오 | check runs uv lock --check; sync runs uv sync --frozen --all-groups --all-extras. |
| `path` | `string` | 아니오 | — |
| `timeoutSeconds` | `integer` | 아니오 | 1..1800 |

**프롬프트 가이드라인**

- Use py_sync with execute=false to preview the uv command, and execute=true only when the environment must be created or refreshed.
- Use py_sync after changing pyproject.toml or uv.lock; a sync that removed packages is reported because later steps cannot run without them.

**반환 `data` 형태**

- `command`: object
  - `args`: array<string>
  - `cwd`: string
  - `executable`: string
  - `risk`: string
- `executed`: boolean
- `extras`: string
- `lockPresent`: boolean
- `mode`: string

### `py_tdd_checkpoint`

Check whether production Python changes have related test changes before implementation is considered complete. Read-only.

- 시스템 프롬프트 한 줄: `Check the Python TDD checkpoint for changed files`
- 라벨: Python TDD Checkpoint
- 프로젝트 상태 변경: 없음 (읽기 전용)

**파라미터**

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `changedPaths` | `array<string>` | 아니오 | maxItems 500 |
| `testChangedPaths` | `array<string>` | 아니오 | maxItems 500 |

**프롬프트 가이드라인**

- Use py_tdd_checkpoint before reporting Python implementation work as complete.

**반환 `data` 형태**

- `associations`: array<…>
- `changedPaths`: array<string>
- `ok`: boolean
- `reasons`: array<string>
- `source`: string
- `sourceChanges`: array<string>
- `testChanges`: array<string>
- `weakAssociation`: boolean

### `py_test`

Preview or run pytest through uv run --frozen and summarise failures by test, file, and first project frame. Does not modify sources.

- 시스템 프롬프트 한 줄: `Preview or run Python tests and summarise failures`
- 라벨: Python Test
- 프로젝트 상태 변경: `execute: true` 옵트인 필요

**파라미터**

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `execute` | `boolean` | 아니오 | — |
| `extraArgs` | `array<string>` | 아니오 | Extra pytest arguments passed verbatim as an argument array, e.g. ["--cov=my_pkg", "--cov-branch"] or ["-m", "unit"]. |
| `keyword` | `string` | 아니오 | pytest -k expression. |
| `lastFailed` | `boolean` | 아니오 | Rerun only tests that failed last time (--lf). |
| `maxFail` | `integer` | 아니오 | 1..1000 |
| `path` | `string` | 아니오 | — |
| `targets` | `array<string>` | 아니오 | — |
| `timeoutSeconds` | `integer` | 아니오 | 1..3600 |

**프롬프트 가이드라인**

- Use py_test with execute=false first; a preview is never a passing test run.
- Use py_test after changing Python sources; it does not rebuild anything, so run py_sync first when dependencies changed.
- Use py_test with extraArgs to run project-standard pytest flags such as coverage options that the tool does not model directly.

**반환 `data` 형태**

- `command`: object
  - `args`: array<string>
  - `cwd`: string
  - `executable`: string
  - `risk`: string
- `executed`: boolean

### `py_test_config`

Audit pytest configuration against the declared plugins and the tests on disk, and report options that make tests pass without running. Read-only.

- 시스템 프롬프트 한 줄: `Validate pytest configuration and detect tests that never run`
- 라벨: Python Test Config
- 프로젝트 상태 변경: 없음 (읽기 전용)

**파라미터**

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `path` | `string` | 아니오 | Project directory to audit; defaults to the project root. |

**프롬프트 가이드라인**

- Use py_test_config when a test run reports fewer tests than expected, when async tests may be silently skipped, or before trusting a green run.
- Use py_test_config after changing pyproject.toml, pytest.ini, or the test layout to confirm the configuration still matches the project.

**반환 `data` 형태**: 캡처되지 않음

### `py_test_select`

Select focused pytest targets from changed files using pytest naming conventions, without running tests. Read-only.

- 시스템 프롬프트 한 줄: `Select focused Python tests from changed files`
- 라벨: Python Test Select
- 프로젝트 상태 변경: 없음 (읽기 전용)

**파라미터**

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `changedPaths` | `array<string>` | 아니오 | Changed paths; defaults to git diff plus untracked files. |
| `path` | `string` | 아니오 | Project directory to scan for test files. |
| `testFiles` | `array<string>` | 아니오 | Known test files; defaults to a project scan. |

**프롬프트 가이드라인**

- Use py_test_select after changing Python source to choose a focused pytest target instead of running the whole suite.

**반환 `data` 형태**

- `changedSourceFiles`: array<string>
- `changedTestFiles`: array<…>
- `consideredTestFiles`: array<string>
- `fellBackToAll`: boolean
- `importEvidenceUsed`: boolean
- `narrowed`: boolean
- `noNarrowing`: boolean
- `pytestTargets`: array<string>
- `selected`: array of
  - `path`: string
  - `reason`: string
  - `score`: number
- `supportFiles`: array<…>

### `py_validation_bundle`

Preview or run one evidence-oriented sequence: uv lock --check, uv sync --frozen, pytest, and a stale-artifact check. Execution is opt-in.

- 시스템 프롬프트 한 줄: `Run the Python sync and test validation bundle`
- 라벨: Python Validation Bundle
- 프로젝트 상태 변경: `execute: true` 옵트인 필요

**파라미터**

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `execute` | `boolean` | 아니오 | — |
| `path` | `string` | 아니오 | — |
| `quality` | `boolean` | 아니오 | Run the lint/type tools the project declares (ruff, pyright, and mypy when [tool.mypy] exists). Defaults to true. |
| `targets` | `array<string>` | 아니오 | — |
| `timeoutSeconds` | `integer` | 아니오 | 1..3600 |

**프롬프트 가이드라인**

- Use py_validation_bundle with execute=false first; a preview is never a passing validation.
- Use py_validation_bundle as the single completion gate after changing Python sources or dependencies.

**반환 `data` 형태**

- `executed`: boolean
- `lockPresent`: boolean
- `quality`: array<string>
- `steps`: array of
  - `args`: array<string>
  - `cwd`: string
  - `executable`: string
  - `risk`: string

## 대화형 명령어 (Commands)

- `/py-status` — Show a concise Python interpreter and uv project status
