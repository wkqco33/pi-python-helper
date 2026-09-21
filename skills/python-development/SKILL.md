---
name: python-development
description: pi-python-helper를 활용한 uv 기반 Python 개발 워크플로. 인터프리터/가상환경 점검, pyproject.toml 및 uv.lock 분석, 의존성 드리프트 탐지, pytest 테스트 선별/실행, traceback 및 uv 실패 진단, 완료 게이트 검증 시 사용합니다.
license: Apache-2.0
---

# pi-python-helper를 활용한 uv 기반 Python 개발 워크플로

원시 쉘 명령어(`grep`, `python -c`, `pytest`)를 직접 실행하기 전에 Python 전용 도구를 우선 사용하세요.

## 조사 및 작업 순서 (Investigation order)

1. 인터프리터나 가상환경 상태가 불확실할 때는 `py_environment`를 실행하세요. 잘못된 Python으로 테스트를 실행하는 것이 가장 흔한 실패 원인입니다. `interpreterOrigin: 'venv'`이면 분석이 프로젝트 환경을 봤다는 뜻이고, `'path'`이면 호스트 PATH의 Python을 봤다는 뜻입니다. `available`은 "지금 실행 가능", `installable`은 "uv sync로 설치 가능"(선언되었지만 실행 파일 없음)입니다.
2. `pyproject.toml`이나 `uv.lock`을 편집하기 전에 `py_project_inspect`로 레이아웃(src/flat), 의존성 그룹, lockfile 드리프트, **환경 정합성**(선언 ↔ lock ↔ 실제 설치본)을 확인하세요. 정합성은 `consistent` / `drifted` / `unverifiable` 중 하나이며, `unverifiable`을 일치로 해석하지 마세요.
3. 의존성을 추가/이동하기 전에 `py_dependency_plan`을 사용하세요. `ast`로 실제 import를 스캔하여 다음을 구분합니다:
   - 선언되지 않은 import (런타임 오류로 이어짐)
   - `[project] dependencies`가 아니라 dev 그룹/extra에만 선언된 런타임 import
   - `uv.lock`에 없거나 스펙을 만족하지 않는 버전
4. import 이름과 배포 이름은 다를 수 있습니다(`PIL`/`pillow`, `yaml`/`PyYAML`). `py_dependency_plan`의 제안을 `uv add`로 적용하세요.
5. 소스 코드를 수정한 후에는 `py_test_select`로 변경 파일과 연관된 테스트를 선별하세요. 테스트가 변경 모듈을 **실제로 import**하면 가장 강한 근거이며, 이름 규약은 그 다음입니다. `narrowed: false`나 `NO_NARROWING`은 "30개 중 30개 선택"처럼 결과가 좁혀지지 않았다는 뜻이고, `SELECTION_WITHOUT_IMPORT_EVIDENCE`는 근거가 파일 이름뿐이라는 뜻이므로 변경이 넓다면 전체 스위트나 `lastFailed=true`를 사용하세요.
6. 테스트 실행은 `py_test`를 사용하세요. `execute=false`로 먼저 미리보기하고, 실제 실행 시에만 `execute=true`를 전달합니다. 커버리지 플래그나 `-m` 마커 선택처럼 도구가 모델링하지 않는 프로젝트 표준 옵션은 `extraArgs`로 넘기세요.
7. 실패 출력이 있을 때는 `py_failure_diagnose`를 사용하세요. `site-packages` 내부 프레임은 원인이 아니며, 도구는 첫 번째 프로젝트 프레임을 지목합니다. 실행 파일을 찾지 못해 명령이 시작되지 못한 경우(`Failed to spawn`, `command not found`)는 `tool_not_installed`로 분류됩니다.
8. 의존성이 바뀌었거나 `.venv`가 오래된 경우 `py_sync`로 `uv lock --check` 또는 `uv sync --frozen`을 미리보기/실행하세요. sync는 `[project.optional-dependencies]`의 extra를 함께 요청하므로 dev 도구가 extra로 선언된 프로젝트에서도 삭제되지 않습니다. `SYNC_REMOVED_PACKAGES`가 보이면 그것이 이후 "command not found"의 원인입니다.
9. 재현이 어려운 실패는 `py_test`의 `lastFailed=true`(`--lf`)로 직전 실패만 다시 실행하세요.
10. 작업 완료를 보고하기 전에 `py_validation_bundle`(lock 검사 → sync → pytest → 환경 정합성 → 오래된 아티팩트 검사)을 실행하고, `py_completion_evidence`로 근거가 충분한지 확인하세요. 정합성이 `drifted`나 `unverifiable`이면 테스트가 통과했어도 게이트는 실패합니다. 각 응답에서 조치 필요 여부는 `attention`으로 판단하세요.
11. `py_tdd_checkpoint`로 프로덕션 변경에 대응하는 테스트 변경이 있는지 확인하세요.

## 안전 규칙 (Safety)

- `py_sync`와 `py_validation_bundle`은 `execute: true`가 명시적으로 전달되기 전까지 명령을 실행하지 않고 미리보기만 반환합니다. `execute=true`는 `.venv`를 생성/갱신하므로 사용자 확인 없이 반복 실행하지 마세요. `extras: 'none'`은 프로젝트가 요청할 때만 사용하세요: extra로 선언된 dev 도구를 삭제할 수 있습니다.
- Python에는 ROS의 `cmd_vel`처럼 위험을 결정론적으로 알려주는 이름이 없습니다. 다음은 되돌릴 수 없는 작업으로 취급하세요: `uv publish`/`twine upload`(공개 불가 회수), `git push --force`, `git reset --hard`/`git clean -fd`, `alembic downgrade`, `DROP`/`DELETE`(WHERE 없는), `rm -rf`, `conda env remove`.
- 가상환경을 파괴하는 명령(`rm -rf .venv`, `uv venv --clear`)이나 전역 Python에 패키지를 설치하는 명령(`pip install` without a venv)을 임의로 실행하지 마세요.
- 도구는 파일을 쓰지 않습니다. `pyproject.toml`/`uv.lock` 수정은 항상 명시적인 편집 도구로 수행하세요.

## 해석 규칙 (Interpretation rules)

- `ok`는 도구의 **판정**이며 "도구가 실행됐다"는 뜻이 아닙니다. 검사 도구는 문제를 찾으면 도구 자체가 실패하지 않았어도 `ok: false`를 반환합니다. 조치가 필요한지는 `attention`을 읽으세요: `ok: false`이거나 경고·오류가 하나라도 있으면 `true`입니다.
- `ok: false`에는 항상 그것을 설명하는 진단(`warnings` 또는 `errors`)이 함께 옵니다. 설명 없는 `ok: false`를 보면 도구 결함이므로 그대로 보고하세요. 게이트 도구는 판정을 `data.ok`(`checkpoint.ok`, `evidence.ok`, `summary.ok`)에도 노출합니다.
- `PROJECT_INSTALLED_NOT_EDITABLE`는 프로젝트가 환경에 live link가 아니라 복사본으로 설치되어, 소스 변경이 테스트에 반영되지 않음을 의미합니다. `uv sync`로 해결하세요.
- `PROJECT_NOT_INSTALLED`는 lock이 editable 설치를 기대하는데 `.venv`에 프로젝트가 없다는 뜻입니다. `uv sync`를 실행하고, 그래도 실패하면 빌드 백엔드가 패키지를 찾지 못한 것입니다(`[project] name`과 모듈 디렉터리 이름이 일치하는지 확인).
- `PROJECT_VIRTUAL_SOURCE`는 정상입니다. `[build-system]`이 없으면 uv는 프로젝트를 `virtual` 소스로 기록하고 `.venv`에 설치하지 않습니다. 누락(`PROJECT_NOT_INSTALLED`)으로 취급하지 말고 `[build-system]` 추가 여부만 검토하세요.
- `MARKER_SPLIT_LOCK_ENTRIES`는 정상입니다. uv가 같은 배포판을 마커별로 여러 버전으로 기록한 것이며, 설치 버전이 그중 하나와 일치하면 드리프트가 아닙니다.
- `TOOL_NOT_INSTALLED`는 lock에는 있지만 `.venv`에 실행 파일이 없다는 뜻입니다. `uv sync` 직후에 발생했다면 sync가 extra를 삭제한 것이므로 `uv sync --frozen --all-groups --all-extras`로 복구하세요.
- `SYNC_REMOVED_PACKAGES`는 sync가 `.venv`에서 패키지를 제거했음을 뜻하며, 같은 실행에서 이어지는 "command not found"의 원인입니다.
- `UNMAPPED_IMPORTS`는 분석한 인터프리터가 import를 배포판에 연결하지 못했다는 뜻입니다. 이 상태에서는 `UNDECLARED_IMPORT`가 "선언 누락"이 아니라 "배포 이름 미확인"일 수 있으므로, 제안된 `uv add` 명령이 없으면 배포 이름을 직접 확인하세요.
- `INSTALLED_VERSION_MISMATCH`는 `uv add`/`uv lock` 후 `uv sync`를 잊은 상태입니다. `uv lock --check`는 이걸 잡지 못하니(락은 최신) 테스트를 신뢰하기 전에 `uv sync --frozen`을 실행하세요.
- `INSTALLED_PACKAGE_UNTRACKED`는 `.venv`에만 있고 lock에 없는 패키지입니다. 에이전트가 `uv pip install`로 임의 설치했을 가능성을 의심하세요.
- `CONDITIONAL_PACKAGES_ABSENT`는 정상입니다. `sys_platform == 'win32'`나 `python_version < '3.11'` 같은 마커 때문에 해당 플랫폼에 설치되지 않은 항목이며, 드리프트로 취급하지 마세요.
- `STALE_COVERAGE_DATA`는 커버리지 결과가 현재 소스보다 오래되었음을 의미합니다. 커버리지 수치를 근거로 사용하지 마세요.
- `RUNTIME_DEPENDENCY_IN_DEV_GROUP`은 프로덕션 코드가 dev 그룹 의존성을 import한다는 뜻이며, 배포 시 `ModuleNotFoundError`로 이어집니다.
- `LOCKFILE_DRIFT`가 있으면 `uv lock` 전에는 어떤 테스트 결과도 신뢰하지 마세요.
- `TYPE_CHECKING` 블록 안의 import는 런타임 의존성이 아니므로 dev 그룹 선언이 정상입니다.
