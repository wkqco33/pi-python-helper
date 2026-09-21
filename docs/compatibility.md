# 호환성 매트릭스 (Compatibility matrix)

| 구성 요소 | 지원 버전 | CI 테스트 여부 |
|---|---|---|
| Node.js | 20, 22, 24 | 지원 (Yes) |
| pi coding agent | 0.86+ / 피어 의존성 범위 | 확장 패키지 스모크 테스트 |
| Python | 3.10, 3.11, 3.12, 3.13 | 4개 버전 매트릭스 |
| uv | 0.5+ (`uv.lock` revision 2/3) | CI 설치 후 스모크 테스트 |
| Ubuntu | `ubuntu-latest` (24.04) | CI 실행 환경 (22.04 미검증) |

## 지원 종료 일정 (End of life)

| 런타임 | 지원 상태 | 비고 |
|---|---|---|
| Python 3.9 | **미지원** | 2025-10 EOL. `sys.stdlib_module_names` 부재로 표준 라이브러리 판별 정확도가 떨어짐 |
| Python 3.10 | 지원 | `tomllib`이 없어 `tomli` 설치가 필요 |
| Python 3.11+ | 지원 | `tomllib` 내장, 모든 분석 기능 사용 가능 |
| Python 3.14 | 미검증 | CI 매트릭스 추가 전까지 best-effort |

매니페스트/락파일 분석은 Python 3.11+에서 가장 정확합니다. 3.10에서는 분석에 사용되는 인터프리터에 `tomli`가 설치되어 있어야 하며, 없으면 `TOML_PARSER_UNAVAILABLE` 경고 후 분석이 생략됩니다. 선언된 버전 제약과 `uv.lock`의 버전 비교에는 `packaging`이 필요하며, 없으면 `SPECIFIER_CHECK_UNAVAILABLE` 노트와 `python3 -m pip install packaging` 제안을 반환하고 이름 대조만 수행합니다.

## 분석 인터프리터 선택 (Which interpreter the scanner uses)

`<root>/.venv`에 인터프리터가 있으면 스캐너는 그것을 사용하고 `interpreterOrigin: 'venv'`를 반환합니다. 없을 때만 PATH의 `python3`/`python`으로 폴백하며 `'path'`로 표시합니다.

이는 정확도 문제입니다. `wconfig`처럼 import 이름과 배포 이름이 다른 모듈은 **실행 중인 인터프리터의 `site-packages`** 에서만 연결됩니다. 호스트 Python 3.14는 모듈 4개를 매핑하는 반면 프로젝트 `.venv`의 Python 3.12는 84개를 매핑하며 `wconfig → wpyconf`를 찾아냅니다. 호스트 인터프리터를 쓰면 모든 프로젝트 의존성이 "제공자 없음"으로 보이고, `providerMappingReliable`이 잘못 `true`로 남았습니다. 지금은 프로젝트의 import를 하나도 소유하지 못한 인터프리터를 신뢰하지 않으며(`providerMappingReliable: false`), 일부만 매핑되면 `UNMAPPED_IMPORTS` 노트로 범위를 좁혀 공개합니다.

같은 이유로 `py_environment`가 보고하는 Python 버전은 프로젝트 환경의 버전입니다(예: 호스트 3.14가 아니라 `.venv`의 3.12).

## 성능 특성 (Measured cost)

측정 환경: Linux, Python 3.12, `uv` 0.12, 이 저장소 기준.

| 작업 | 비용 | 비고 |
|---|---|---|
| `py_environment` 전체 | ~64 ms | 스캐너 1회 + `uv --version` 1회. 도구 가용성은 프로세스 실행 없이 판정 |
| 도구 가용성 판정 | ~2.3 ms | `.venv/bin` + PATH 파일시스템 탐색 + lock 버전 |
| `py_project_inspect` 매니페스트 스캔 | ~31 ms | `pyproject.toml` + `uv.lock` 파싱 |
| import 스캔 (`ast`) | ~76 ms | `py_dependency_plan`에만 사용 |
| 설치본 스캔 | ~3 ms / 22개 패키지 | `dist-info/METADATA` 헤더만 읽음 |

`py_environment`는 `--version` 실행을 도구마다 수행하지 않습니다. 과거 이 방식은 도구당 프로세스 1회(pytest만 154 ms)를 썼고 호스트 버전을 프로젝트 버전으로 잘못 보고했습니다.

## 저하 동작 (Degraded behaviour)

| 상황 | 동작 |
|---|---|
| Python 3 해석기 없음 | `PYTHON_NOT_FOUND` 구조화 오류 반환, 모든 도구가 예외 없이 종료 |
| `tomllib`/`tomli` 없음 | `TOML_PARSER_UNAVAILABLE` 경고 후 매니페스트 분석 생략 |
| `sys.stdlib_module_names` 없음 | `STDLIB_LIST_HEURISTIC` 노트와 함께 축소된 표준 라이브러리 목록 사용, 과다 보고 가능성 명시 |
| uv 미설치 | `UV_NOT_AVAILABLE` 경고, 커맨드 미리보기는 계속 생성 |
| `uv.lock` 없음 | `LOCKFILE_MISSING` 노트와 `uv lock` 제안, 드리프트 검사 불가 명시, 정합성은 `unverifiable` |
| `.venv` 없음 | `VENV_MISSING` 노트, 정합성은 `unverifiable` (일치로 간주하지 않음) |
| site-packages 스캔 잘림 | `truncated: true` 표시 후 정합성을 `unverifiable`로 반환 |
| `METADATA` 손상/부재 | dist-info 디렉터리 이름에서 버전 복구, `VERSION_FROM_DIRECTORY_NAME` 노트 |
| 마커 조건부 lock 항목 | `counts.conditional`과 `CONDITIONAL_PACKAGES_ABSENT` 노트로 집계, 누락으로 보고하지 않음 |
| 부트스트랩 배포판(pip 등) | 비교 대상에서 제외 |
| `packaging` 미설치 | `SPECIFIER_CHECK_UNAVAILABLE` 노트, 이름 대조만 수행 |
| import 스캔 중 구문 오류 파일 | `UNPARSABLE_FILE` 노트로 보고하고 나머지 스캔은 계속 |
| 스캔 파일 수 초과 | `truncated: true` 표시 |
| 스캐너 프로토콜 불일치 | `SCANNER_VERSION_MISMATCH` 오류 반환 (문서를 해석하지 않음). 현재 프로토콜 버전은 **2**이며, 1은 `importModules`가 없어 거부됩니다 |
| `.venv` 인터프리터 실행 불가 | PATH 인터프리터로 폴백하고 `interpreterOrigin: 'path'`로 표시 |
| 선언된 도구의 실행 파일 부재 | `TOOL_NOT_INSTALLED` 경고와 `--all-extras` 제안 (`available: false`, `installable: true`) |
| sync가 패키지를 제거함 | `SYNC_REMOVED_PACKAGES` 경고; pytest가 사라졌으면 테스트 단계를 건너뛰고 그 이유를 반환 |
| 마커별로 분할된 lock 항목 | 설치 버전이 항목 중 하나와 일치하면 일치로 판정, `MARKER_SPLIT_LOCK_ENTRIES` 노트 |
| `[build-system]` 없는 프로젝트 | `PROJECT_VIRTUAL_SOURCE` 노트, 누락으로 보고하지 않음 |
| 테스트가 패키지 안에 있음 | 패키지 루트와 최대 3단계 하위까지 테스트 디렉터리 탐색 (`TESTS_DIRECTORY_FOUND`) |
| import 이름의 배포판 미확인 | `UNMAPPED_IMPORTS` 노트, `uv add` 명령을 만들지 않고 배포 이름 확인을 요청 |
| 테스트 선별이 전부를 선택 | `narrowed: false`와 `NO_NARROWING` 경고; import 근거가 없으면 `SELECTION_WITHOUT_IMPORT_EVIDENCE` |
| 읽을 수 없는 디렉터리 | 해당 항목만 "없음"으로 처리, 전체 스캔은 계속 |

## 릴리스 호환성 (Release compatibility)

본 패키지는 유의적 버전(Semantic Versioning)을 준수합니다. `0.y.z` 시리즈에서는 공개 도구 스키마가 변경될 수 있으며, 하위 호환성을 깨뜨리는 변경사항은 `CHANGELOG.md`에 명시됩니다. 릴리스 태그는 `package.json`에 명시된 버전과 반드시 일치해야 하며(예: `v0.1.0`), 배포는 `.github/workflows/publish.yml`이 태그를 검증한 뒤 npm provenance와 함께 수행합니다.

### Deprecation 정책

- 도구 이름이나 필수 파라미터를 제거할 때는 최소 1개 마이너 버전 동안 유지하면서 `CHANGELOG.md`에 `Deprecated` 항목과 마이그레이션 안내를 남깁니다.
- 파라미터는 additive하게 추가하고, 기존 이름은 `prepareArguments`로 흡수하는 방식을 우선합니다.
- `1.0.0` 이전에는 위 정책을 권고 사항으로 운영하며, 예외는 `CHANGELOG.md`에 사유와 함께 기록합니다.
