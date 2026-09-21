# pi-python-helper

[pi 코딩 에이전트](https://github.com/badlogic/pi-mono)를 위한 uv 기반 Python 개발 도구 및 워크플로우 확장 패키지입니다.

패키지 관리자는 **uv 단일 지원**이며, 린트/타입 진단(LSP)은 의도적으로 다루지 않습니다. 해당 영역은 `@narumitw/pi-python-lsp` 같은 별도 확장에 위임하고, 이 패키지는 **환경 점검, 매니페스트/락파일 정합성, 의존성 그래프 분석, 테스트 선별 및 실행, 완료 검증 게이트**에 집중합니다.

---

## 설치 및 설정 (Installation)

### 패키지 설치
pi 환경에 npm 패키지로 설치합니다:

```bash
pi install npm:pi-python-helper
```

### 개발용/로컬 설치
로컬에서 확장을 개발하거나 소스 코드로 직접 로드하려면 다음과 같이 실행합니다:

```bash
pi -e /absolute/path/to/pi-python-helper
```

또는 프로젝트의 `.pi/settings.json`에 확장 경로를 등록할 수 있습니다.

---

## 빠른 시작 (Quick Start)

설치 후 대화창에서 인터랙티브 명령어로 환경 상태를 즉시 확인할 수 있습니다:

```text
/py-status
```

활성 인터프리터, 가상환경(`.venv`), uv 가용성 및 프로젝트 매니페스트 상태를 간결하게 요약하여 보고합니다.

또한, 패키지에 내장된 `python-development` 스킬이 pi 에이전트에게 상황별 권장 도구 호출 순서와 해석 규칙을 자동으로 안내합니다.

---

## 개발 워크플로우 가이드 (Workflow Guide)

에이전트 또는 개발자가 Python 프로젝트를 다룰 때 다음 워크플로우에 따라 점검과 작업을 진행하는 것을 권장합니다.

### 1. 환경 및 프로젝트 진단 (Environment & Manifest Check)
원시 쉘 명령어로 환경을 탐색하기 전에 전용 도구로 런타임과 설정의 무결성을 먼저 확인합니다.
- **인터프리터 점검**: 잘못된 Python 실행 파일이나 가상환경 미활성화로 인한 혼란을 방지합니다 (`py_environment`).
- **3자 정합성 검사**: `pyproject.toml`(선언) ↔ `uv.lock`(해석) ↔ `.venv`(실제 설치)가 서로 일치하는지 검사하고, lockfile 드리프트나 동기화 누락을 감지합니다 (`py_project_inspect`).

### 2. 의존성 분석 및 관리 (Dependency Analysis)
소스 코드를 정적으로 분석하여 런타임 누락이나 잘못된 의존성 배치를 사전에 방지합니다 (`py_dependency_plan`).
- **코드 실제 import 스캔**: Python `ast`를 기반으로 실제 import된 모듈을 추출하고 배포 패키지 이름(`PIL` ↔ `pillow` 등)으로 변환합니다.
- **의존성 누락 및 분류 오류 탐지**:
  - 프로덕션 코드에서 선언되지 않은 패키지를 사용하는 경우 (`UNDECLARED_IMPORT`)
  - dev 그룹에만 선언된 패키지를 런타임 프로덕션 코드에서 import한 경우 (`RUNTIME_DEPENDENCY_IN_DEV_GROUP`)
  - `TYPE_CHECKING` 블록 내부의 타입 전용 import 여부 구분 (`UNDECLARED_TYPE_ONLY_IMPORT` — 런타임 의존성으로 오탐 방지)
- **반영 계획**: 분석 결과를 바탕으로 `uv add` 또는 `uv sync` 계획을 안전하게 수립합니다.

### 3. 스마트 테스트 선별 및 실패 진단 (Testing & Diagnostics)
전체 테스트를 매번 실행하지 않고, 변경 사항에 기반하여 효율적으로 테스트를 수행합니다.
- **테스트 자동 선별**: pytest 규약과 토큰 연관성을 기반으로 변경된 파일과 관련된 테스트만 선택합니다 (`py_test_select`). 매칭이 어려울 경우 안전하게 전체 스위트로 폴백합니다.
- **테스트 실행 및 요약**: `uv run --frozen pytest`를 안전하게 실행하고 passed/failed/errors 카운트 및 실패 노드를 구조화하여 추출합니다 (`py_test`). `--lf`(직전 실패만 재실행), `-k` 필터 등을 지원합니다.
- **원인 프레임 진단**: 테스트 실패 시 긴 traceback 속에서 `site-packages`나 표준 라이브러리 프레임을 배제하고, **실제 프로젝트 코드에서 가장 먼저 발생한 원인 프레임**을 지목합니다 (`py_failure_diagnose`).

### 4. 품질 검증 게이트 및 동기화 (Validation Gates)
작업을 완료했다고 보고하기 전에 확실한 증거를 수집합니다.
- **TDD 체크포인트**: 프로덕션 코드 변경에 대응하는 테스트 코드 수정이 있었는지 확인합니다 (`py_tdd_checkpoint`).
- **가상환경 동기화**: `uv lock --check` 및 `uv sync --frozen`을 통해 lock과 venv를 일치시킵니다 (`py_sync`).
- **종합 검증 번들**: lock 검사 → sync → pytest → 환경 정합성 → 오래된 아티팩트 검사를 하나의 검증 시퀀스로 실행하여 신뢰할 수 있는 완료 판정을 도출합니다 (`py_validation_bundle`, `py_completion_evidence`).

> 💡 각 도구의 상세 파라미터 스키마 및 반환값 규격은 [도구 레퍼런스 (docs/tools.md)](docs/tools.md)를 참고하세요.

---

## 핵심 원칙 및 안전 모델 (Core Principles & Safety)

### 1. 명시적 옵트인 기반 안전 모델 (Opt-in Safety)
- **읽기 전용 기본**: 환경/의존성/테스트 진단 도구는 기본적으로 읽기 전용으로 안전하게 동작합니다.
- **상태 변경 시 옵트인 요구**: 가상환경을 생성/갱신하거나 락파일을 수정하는 도구(`py_sync`, `py_validation_bundle`)는 `execute: true`가 명시적으로 지정되지 않으면 실행하지 않고 **명령 미리보기(preview)**만 반환합니다.
- **소스 파일 보호**: 이 패키지의 어떤 도구도 프로젝트 소스 코드를 임의로 수정하거나 덮어쓰지 않습니다.

### 2. 3자 환경 정합성 검사 (Environment Conformance)
`pyproject.toml`, `uv.lock`, `.venv`의 3자 일치 상태를 비교 및 판정합니다:
- **`consistent`**: 세 진실 원천이 완벽히 동기화된 상태.
- **`drifted`**: 버전 불일치(`INSTALLED_VERSION_MISMATCH`), 필수 패키지 누락(`INSTALLED_PACKAGE_MISSING`), 복사본 설치(`PROJECT_INSTALLED_NOT_EDITABLE`) 등의 불일치가 발견된 상태.
- **`unverifiable`**: 가상환경 부재, 락파일 부재, 권한 문제 등으로 검증을 완료할 수 없는 상태 (결코 일치로 승격하지 않음).

**오탐 억제 (False-positive Control)**:
- OS나 파이썬 버전 조건부 패키지(`sys_platform == 'win32'`, `python_version < '3.11'`)는 환경에 맞게 설치되지 않는 것이 정상이므로, 마커를 분석하여 무조건 필요한 패키지만 누락으로 판정합니다.
- pip, setuptools 등의 부트스트랩 배포판은 불일치 비교에서 제외합니다.

### 3. 오래된 아티팩트 탐지 (Stale Artifact Detection)
- 소스 코드 변경 시점보다 오래된 커버리지 데이터(`.coverage`, `coverage.xml`)가 남아 있는 경우(`STALE_COVERAGE_DATA`), 오래된 수치를 근거로 잘못 판단하지 않도록 경고합니다.

---

## 문서 및 참고 자료 (Documentation)

- 📖 **[도구 레퍼런스 (docs/tools.md)](docs/tools.md)** — 모든 등록 도구의 설명, 입력 파라미터 스키마, 반환 데이터 규격 (자동 생성 및 테스트 검증)
- 🧭 **[호환성 및 성능 매트릭스 (docs/compatibility.md)](docs/compatibility.md)** — Node.js, Python(3.10~3.13), uv 지원 범위, 저하 모드 동작 방식, 작업별 측정 비용
- 📝 **[변경 이력 (CHANGELOG.md)](CHANGELOG.md)** — 버전별 변경 내역 및 마이그레이션 안내
- 🤝 **[기여 가이드 (CONTRIBUTING.md)](CONTRIBUTING.md)** 및 **[개발 에이전트 규칙 (AGENTS.md)](AGENTS.md)** — 패키지 개발 지침 및 아키텍처 규칙

---

## 개발 및 기여 (Development)

```bash
# 의존성 설치
npm install

# 단위 테스트 및 타입 검사
npm test
npm run typecheck

# 전체 검증 (테스트, 타입 검사, 포맷, 문서 동기화, 패키징 검사)
npm run check
```

- 실제 uv 환경을 이용한 전 구간 검증: `npm run test:e2e`
- 도구 등록 정보나 스키마 수정 후 문서 재생성: `npm run docs` (이후 `npm run docs:check`로 확인)

---

## 라이선스 및 출처 (License & Attribution)

- **License**: Apache-2.0
- **Attribution**: 본 패키지의 공통 코어(구조화된 결과 규격, 프로세스 경계 래퍼, 검증 게이트 골격)는 Apache-2.0 라이선스의 [pi-ros-helper](https://github.com/wkqco33/pi-ros-helper) 구조를 참고하여 작성되었습니다.
