# pi-python-helper

[pi 코딩 에이전트](https://github.com/badlogic/pi-mono)를 위한 uv 기반 Python 개발 도구 확장 패키지입니다.

패키지 관리자는 **uv 단일 지원**이며, 린트/타입 진단(LSP)은 의도적으로 다루지 않습니다. 해당 영역은 `@narumitw/pi-python-lsp` 같은 별도 확장에 위임합니다.

## 현재 지원 현황

버전 `0.1.0`은 `python-development` 스킬에 정의된 범위 제한(bounded) 검사, 품질 게이트, 명시적 옵트인 기반 명령 실행 도구를 제공합니다.

### 환경 및 프로젝트 검사 (Environment & Project Inspection)

- `py_environment` — 활성 인터프리터(`python3`/`python`), 버전, 실행 파일 경로, `sys.prefix` vs `base_prefix`, `VIRTUAL_ENV`/`CONDA_PREFIX`, 프로젝트 루트, `.venv` 존재 여부, `uv`/`ruff`/`mypy`/`ty`/`pyright`/`pytest`/`pre-commit` 가용성
- `py_project_inspect` — `pyproject.toml`과 `uv.lock` 파싱, src/flat 레이아웃, importable 모듈, 의존성 그룹, 엔트리포인트, 빌드 백엔드, `[tool.*]` 설정, **lockfile 드리프트**(requires-python 불일치, lock에 없는 선언, 스펙 미충족 버전, `.gitignore` 누락, 레거시 `setup.py`/`requirements*.txt` 중복), 그리고 **환경 정합성**(선언 ↔ uv.lock ↔ `.venv` 실제 설치본)

### 의존성 분석 (Dependency Analysis)

- `py_dependency_plan` — Python `ast`로 실제 import를 스캔하여 선언된 의존성과 비교합니다. `sys.stdlib_module_names`로 표준 라이브러리를 제외하고, import 이름과 배포 이름의 차이(`PIL`↔`pillow`, `yaml`↔`PyYAML`)를 정적 별칭 테이블과 `importlib.metadata.packages_distributions()`로 해석합니다. 판정 항목:
  - 선언되지 않은 import (`UNDECLARED_IMPORT`)
  - `[project] dependencies`가 아니라 dev 그룹/extra에만 선언되었는데 프로덕션 코드가 import (`RUNTIME_DEPENDENCY_IN_DEV_GROUP`)
  - `TYPE_CHECKING` 블록 전용 import (`UNDECLARED_TYPE_ONLY_IMPORT` — 런타임 의존성으로 오탐하지 않음)
  - `uv.lock` 드리프트 (`LOCKFILE_DRIFT`)
  - `includeUnused=true`일 때만, 콘솔 전용 도구를 제외한 미사용 선언 보고

### 테스트 실행 및 선별 (Test Selection & Execution)

- `py_test_select` — pytest 규약(`tests/`, `test_*.py`, `*_test.py`, `conftest.py`)과 토큰 중복으로 변경 파일과 연관된 테스트 파일을 선별합니다. 매칭 실패 시 전체 스위트를 범위로 되돌리고 그 사실을 명시합니다.
- `py_test` — `uv run --frozen pytest` 미리보기 또는 실행. `--lf`(직전 실패만), `-k`, `--maxfail` 지원. pytest 요약 라인을 파싱하여 passed/failed/errors/skipped/xfailed/deselected/warning 카운트와 실패 노드 ID를 반환하고, 요약이 없는 실행은 통과로 간주하지 않습니다.
- `py_failure_diagnose` — 제한된 출력에서 **출력상 가장 먼저 등장하는** 원인을 선택합니다. `traceback` 프레임을 `site-packages`/표준 라이브러리와 프로젝트 코드로 분리하여 마지막 프로젝트 프레임을 지목합니다.

### 게이트 및 검증 (Gates & Validation)

- `py_sync` — `uv lock --check` 또는 `uv sync --frozen` 미리보기/실행. 실행은 명시적 `execute: true` 필요
- `py_validation_bundle` — `uv lock --check` → `uv sync --frozen` → `pytest` → 환경 정합성 → 오래된 아티팩트 검사를 하나의 증거 지향 시퀀스로 미리보기/실행
- `py_tdd_checkpoint` — 프로덕션 `.py` 변경에 대응하는 테스트 변경이 있는지 확인
- `py_completion_evidence` — 환경 동기화와 테스트가 실제로 실행·성공했는지에 대한 보수적 완료 판정

### 대화형 명령어 (Interactive Commands)

- `/py-status` — 간결한 인터프리터/uv/프로젝트 상태 알림

## 안전 모델 (Safety model)

ROS 2와 달리 Python에는 위험을 결정론적으로 알려주는 토픽 이름이 없습니다. 따라서 위험은 **명령 텍스트 자체**에서 분류하며, 복합 명령(`&&`, `||`, `;`, `|`)은 각 세그먼트 중 가장 높은 위험을 상속합니다.

- **되돌릴 수 없음(irreversible)**: `uv publish`/`twine upload`, `git push --force`, `git reset --hard`/`git clean -fd`, `alembic downgrade`, `rm -rf`, `conda env remove`, `curl ... | sh`
- **상태 변경(mutating)**: `uv add/remove/sync/lock`, `pip install/uninstall`, `git commit/push`, 마이그레이션 적용
- **읽기 전용(read)**: `uv lock --check`, `uv sync --dry-run`, `pytest`, `ruff check --diff`, `git diff/status/log`, `python -c`

`py_sync`와 `py_validation_bundle`은 `execute: true`가 명시적으로 전달되기 전까지 명령을 실행하지 않고 미리보기만 반환합니다. 이 패키지의 어떤 도구도 소스 파일을 쓰지 않습니다.

## 오래된 아티팩트 탐지 (Stale artifact detection)

Python은 바이트코드를 자동 무효화하고 pytest는 아무것도 설치하지 않으므로 남는 위험은 하나입니다.

- `STALE_COVERAGE_DATA` — `.coverage`/`coverage.xml`이 현재 소스보다 오래됨 → 커버리지 수치를 근거로 쓸 수 없음

프로젝트 자체가 오래된 복사본으로 설치되었는지는 mtime 비교가 아니라 `PROJECT_INSTALLED_NOT_EDITABLE` 구조적 검사가 담당합니다.

## 환경 정합성 검사 (Environment conformance)

세 개의 진실 원천을 비교합니다: `pyproject.toml`의 선언, `uv.lock`의 해석 결과, `.venv`에 실제로 설치된 배포판.

설치 버전은 Python을 실행하지 않고 `site-packages/<name>-<version>.dist-info/METADATA`의 헤더 블록(최대 8KB)만 읽어 얻습니다. 22개 패키지 기준 **약 3ms**이며 서브프로세스를 띄우지 않습니다.

| 코드 | 의미 |
|---|---|
| `INSTALLED_VERSION_MISMATCH` | lock의 버전과 설치된 버전이 다름 — `uv add`/`uv lock` 후 `uv sync`를 잊은 상태. `uv lock --check`는 이걸 **잡지 못합니다**(락은 최신) |
| `INSTALLED_PACKAGE_MISSING` | 무조건 필요한 패키지가 `.venv`에 없음 |
| `PROJECT_NOT_INSTALLED` | lock이 editable 설치를 기대하는데 프로젝트가 `.venv`에 없음(빌드 실패 포함). 테스트가 프로젝트를 import할 수 없음 |
| `PROJECT_INSTALLED_NOT_EDITABLE` | 프로젝트가 live link가 아니라 **복사본**으로 설치됨 → 테스트가 오래된 스냅샷을 import |
| `INSTALLED_PACKAGE_UNTRACKED` | `.venv`에 있지만 lock에 없는 패키지 (예: `uv pip install` 잔여물) |
| `INSTALLED_ENVIRONMENT_INDEPENDENT` | 설치본 대부분이 lock에 없음 — 이 `.venv`는 uv가 이 프로젝트용으로 만든 것이 아님 |

### 오탐 억제 (False-positive control)

- **조건부 항목**: `colorama`(`sys_platform == 'win32'`), `tomli`(`python_version < '3.11'`) 같은 항목은 lock에 있어도 해당 플랫폼에 설치되지 않는 것이 정상입니다. `uv.lock`의 각 의존성 엣지에 기록된 마커를 읽어 **무조건 필요하다고 증명된 이름만** 누락으로 보고합니다. 나머지는 `counts.conditional`과 `CONDITIONAL_PACKAGES_ABSENT` 노트로 집계합니다.
- **설치되지 않은 패키지의 의존성**은 required로 승격하지 않습니다(win32 전용 브랜치 등).
- **부트스트랩 배포판**(pip/setuptools/wheel 등)은 비교에서 제외합니다.
- **선택적 extra**는 `uv sync`가 설치하지 않으므로 required 집합에 넣지 않습니다. `[project] dependencies`와 기본 `dev` 그룹만 포함합니다.
- 검증 불가 상태(venv 없음, lock 없음, 스캔 잘림)는 `verdict: 'unverifiable'`로 반환하며 **일치한다고 주장하지 않습니다**.

`py_validation_bundle`은 정합성이 `consistent`일 때만 통과합니다. `drifted`와 `unverifiable`은 모두 게이트 실패입니다 — lock이 기술하지 않는 버전으로 통과한 테스트는 증거가 아니기 때문입니다.

## 개발용 설치 (Install for development)

```bash
pi -e /absolute/path/to/pi-python-helper
```

프로젝트 로컬 패키지로 사용하려면 `.pi/settings.json`에 경로를 추가하거나 npm 패키지를 설치합니다.

```bash
pi install npm:pi-python-helper@latest
```

## 개발 및 기여 (Development)

```bash
npm install
npm test
npm run typecheck
# 또는 전체 검사 실행
npm run check
```

네트워크와 uv가 있는 환경에서는 실제 uv 프로젝트를 생성해 전 경로를 검증하는 e2e 테스트를 실행할 수 있습니다:

```bash
npm run test:e2e
```

이 확장은 로드 시 Python이나 uv가 설치되어 있을 필요가 없습니다. Python 도구는 해석기나 uv를 사용할 수 없을 때 예외를 던지지 않고 구조화된 진단 오류를 반환합니다.

분석은 `helpers/scan_project.py`에 위임합니다. 이 스크립트는 stdin으로 JSON 요청을 받아 stdout으로 JSON을 출력하며 프로젝트를 수정하지 않습니다. import 스캔에는 `ast`, 매니페스트 파싱에는 `tomllib`(Python 3.11+) 또는 `tomli`가 필요하고, 둘 다 없으면 매니페스트 분석이 저하된 상태로 동작함을 명시적으로 경고합니다. 선언된 버전 제약과 `uv.lock`의 버전을 비교하는 기능은 분석 인터프리터의 `packaging`을 사용하며, 없으면 `SPECIFIER_CHECK_UNAVAILABLE` 노트를 남기고 이름 대조만 수행합니다.

스캐너는 독립 실행도 가능합니다:

```bash
python3 helpers/scan_project.py --help
python3 helpers/scan_project.py --mode environment,manifest --root . </dev/null
```

종료 코드는 `0` 성공, `1` 예상외 실패, `2` 잘못된 입력입니다. 결과는 stdout(JSON 문서 하나), 진단 메시지는 stderr로 분리됩니다.

## 성능 특성 (Measured cost)

측정 환경: Linux, Python 3.12, uv 0.12.

| 작업 | 비용 |
|---|---|
| `py_environment` 전체 | ~64 ms (스캐너 1회 + `uv --version` 1회) |
| 도구 가용성 판정 | ~2.3 ms (프로세스 실행 없음) |
| `py_project_inspect` 매니페스트 스캔 | ~31 ms |
| import 스캔 (`ast`) | ~76 ms (`py_dependency_plan`에만 사용) |
| 설치본 스캔 | ~3 ms / 22개 패키지 (`METADATA` 헤더만 읽음) |

도구 존재 여부는 `--version`을 실행해서 확인하지 않습니다. 그 방식은 도구당 프로세스 1회(pytest만 154 ms)를 썼고 호스트 버전을 프로젝트 버전으로 잘못 보고했습니다. 대신 `.venv/bin`과 PATH를 파일시스템으로 탐색하고 버전은 `uv.lock`에서 가져옵니다.

## 지원 및 호환성 (Support and compatibility)

- Node.js 20 이상
- Python 3.10 / 3.11 / 3.12 / 3.13 (CI 매트릭스에서 검증, 3.11+ 권장)
- uv 0.5+ 우선 지원, `uv.lock`(revision 2/3) 기준
- 정적 프로젝트/의존성 분석 도구는 uv나 `.venv` 없이도 작동합니다.
- 라이선스: Apache-2.0

릴리스 이력은 `CHANGELOG.md`, 개발 규칙은 `AGENTS.md`와 `CONTRIBUTING.md`, 지원 런타임 및 성능 정보는 `docs/compatibility.md`, 취약점 보고는 `SECURITY.md`를 참고하세요.

릴리스는 `v<version>` 태그를 푸시하면 `.github/workflows/publish.yml`이 태그와 `package.json` 버전을 검증한 뒤 npm provenance와 함께 배포합니다.

## 설계 원칙 (Design principles)

- 모호한 쉘 텍스트 대신 구조화된 결과(`PyToolResult`) 반환
- 타임아웃, 작업 취소, 출력 크기 제한을 통한 프로세스 경계 유지
- 사용자 입력 경로/패키지명의 쉘 문자열 보간 금지 (항상 인자 배열)
- 기본적으로 읽기 전용 진단 수행, 상태를 바꾸는 명령은 명시적 opt-in 요구
- 근거가 약한 판정은 경고하지 않고 `info` 노트로 내리거나 옵트인으로 제공
- 도구 수를 의도적으로 작게 유지하고, 린트/타입 진단은 다른 확장에 위임

## 출처 (Attribution)

이 패키지의 공통 코어(결과 규격, 범위 제한 실행기, 검증 게이트 골격)는 Apache-2.0 라이선스의 [pi-ros-helper](https://github.com/wkqco33/pi-ros-helper) 구조를 참고하여 작성되었습니다. ROS 2 전용 도메인 로직은 포함하지 않습니다.
