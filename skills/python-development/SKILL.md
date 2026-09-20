---
name: python-development
description: pi-python-helper를 활용한 uv 기반 Python 개발 워크플로. 인터프리터/가상환경 점검, pyproject.toml 및 uv.lock 분석, 의존성 드리프트 탐지, pytest 테스트 선별/실행, traceback 및 uv 실패 진단, 완료 게이트 검증 시 사용합니다.
license: Apache-2.0
---

# pi-python-helper를 활용한 uv 기반 Python 개발 워크플로

원시 쉘 명령어(`grep`, `python -c`, `pytest`)를 직접 실행하기 전에 Python 전용 도구를 우선 사용하세요.

## 조사 및 작업 순서 (Investigation order)

1. 인터프리터나 가상환경 상태가 불확실할 때는 `py_environment`를 실행하세요. 잘못된 Python으로 테스트를 실행하는 것이 가장 흔한 실패 원인입니다.
2. `pyproject.toml`이나 `uv.lock`을 편집하기 전에 `py_project_inspect`로 레이아웃(src/flat), 의존성 그룹, lockfile 드리프트, **환경 정합성**(선언 ↔ lock ↔ 실제 설치본)을 확인하세요. 정합성은 `consistent` / `drifted` / `unverifiable` 중 하나이며, `unverifiable`을 일치로 해석하지 마세요.
3. 의존성을 추가/이동하기 전에 `py_dependency_plan`을 사용하세요. `ast`로 실제 import를 스캔하여 다음을 구분합니다:
   - 선언되지 않은 import (런타임 오류로 이어짐)
   - `[project] dependencies`가 아니라 dev 그룹/extra에만 선언된 런타임 import
   - `uv.lock`에 없거나 스펙을 만족하지 않는 버전
4. import 이름과 배포 이름은 다를 수 있습니다(`PIL`/`pillow`, `yaml`/`PyYAML`). `py_dependency_plan`의 제안을 `uv add`로 적용하세요.
5. 소스 코드를 수정한 후에는 `py_test_select`로 변경 파일과 연관된 테스트를 선별하세요. 매칭이 실패하면 전체 스위트가 범위가 되며, 선택 이유가 함께 반환됩니다.
6. 테스트 실행은 `py_test`를 사용하세요. `execute=false`로 먼저 미리보기하고, 실제 실행 시에만 `execute=true`를 전달합니다.
7. 실패 출력이 있을 때는 `py_failure_diagnose`를 사용하세요. `site-packages` 내부 프레임은 원인이 아니며, 도구는 첫 번째 프로젝트 프레임을 지목합니다.
8. 의존성이 바뀌었거나 `.venv`가 오래된 경우 `py_sync`로 `uv lock --check` 또는 `uv sync --frozen`을 미리보기/실행하세요.
9. 재현이 어려운 실패는 `py_test`의 `lastFailed=true`(`--lf`)로 직전 실패만 다시 실행하세요.
10. 작업 완료를 보고하기 전에 `py_validation_bundle`(lock 검사 → sync → pytest → 환경 정합성 → 오래된 아티팩트 검사)을 실행하고, `py_completion_evidence`로 근거가 충분한지 확인하세요. 정합성이 `drifted`나 `unverifiable`이면 테스트가 통과했어도 게이트는 실패합니다.
11. `py_tdd_checkpoint`로 프로덕션 변경에 대응하는 테스트 변경이 있는지 확인하세요.

## 안전 규칙 (Safety)

- `py_sync`와 `py_validation_bundle`은 `execute: true`가 명시적으로 전달되기 전까지 명령을 실행하지 않고 미리보기만 반환합니다. `execute=true`는 `.venv`를 생성/갱신하므로 사용자 확인 없이 반복 실행하지 마세요.
- Python에는 ROS의 `cmd_vel`처럼 위험을 결정론적으로 알려주는 이름이 없습니다. 다음은 되돌릴 수 없는 작업으로 취급하세요: `uv publish`/`twine upload`(공개 불가 회수), `git push --force`, `git reset --hard`/`git clean -fd`, `alembic downgrade`, `DROP`/`DELETE`(WHERE 없는), `rm -rf`, `conda env remove`.
- 가상환경을 파괴하는 명령(`rm -rf .venv`, `uv venv --clear`)이나 전역 Python에 패키지를 설치하는 명령(`pip install` without a venv)을 임의로 실행하지 마세요.
- 도구는 파일을 쓰지 않습니다. `pyproject.toml`/`uv.lock` 수정은 항상 명시적인 편집 도구로 수행하세요.

## 해석 규칙 (Interpretation rules)

- `PROJECT_INSTALLED_NOT_EDITABLE`는 프로젝트가 환경에 live link가 아니라 복사본으로 설치되어, 소스 변경이 테스트에 반영되지 않음을 의미합니다. `uv sync`로 해결하세요.
- `PROJECT_NOT_INSTALLED`는 lock이 editable 설치를 기대하는데 `.venv`에 프로젝트가 없다는 뜻입니다. `uv sync`를 실행하고, 그래도 실패하면 빌드 백엔드가 패키지를 찾지 못한 것입니다(`[project] name`과 모듈 디렉터리 이름이 일치하는지 확인).
- `INSTALLED_VERSION_MISMATCH`는 `uv add`/`uv lock` 후 `uv sync`를 잊은 상태입니다. `uv lock --check`는 이걸 잡지 못하니(락은 최신) 테스트를 신뢰하기 전에 `uv sync --frozen`을 실행하세요.
- `INSTALLED_PACKAGE_UNTRACKED`는 `.venv`에만 있고 lock에 없는 패키지입니다. 에이전트가 `uv pip install`로 임의 설치했을 가능성을 의심하세요.
- `CONDITIONAL_PACKAGES_ABSENT`는 정상입니다. `sys_platform == 'win32'`나 `python_version < '3.11'` 같은 마커 때문에 해당 플랫폼에 설치되지 않은 항목이며, 드리프트로 취급하지 마세요.
- `STALE_COVERAGE_DATA`는 커버리지 결과가 현재 소스보다 오래되었음을 의미합니다. 커버리지 수치를 근거로 사용하지 마세요.
- `RUNTIME_DEPENDENCY_IN_DEV_GROUP`은 프로덕션 코드가 dev 그룹 의존성을 import한다는 뜻이며, 배포 시 `ModuleNotFoundError`로 이어집니다.
- `LOCKFILE_DRIFT`가 있으면 `uv lock` 전에는 어떤 테스트 결과도 신뢰하지 마세요.
- `TYPE_CHECKING` 블록 안의 import는 런타임 의존성이 아니므로 dev 그룹 선언이 정상입니다.
