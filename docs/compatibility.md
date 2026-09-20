# 호환성 매트릭스 (Compatibility matrix)

| 구성 요소 | 지원 버전 | CI 테스트 여부 |
|---|---|---|
| Node.js | 20, 22, 24 | 지원 (Yes) |
| pi coding agent | 0.86+ / 피어 의존성 범위 | 확장 패키지 스모크 테스트 |
| uv | 0.5+ (`uv.lock` revision 2/3) | CI 설치 후 스모크 테스트 |
| Python | 3.11+ 권장, 3.9+ 동작 | 3.11/3.12/3.13 매트릭스 |
| 매니페스트 파싱 | `tomllib`(3.11+) 또는 `tomli` | 버전별 폴백 검증 |
| Ubuntu | 22.04, 24.04 | CI 실행 환경 |

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
## 릴리스 호환성 (Release compatibility)

본 패키지는 유의적 버전(Semantic Versioning)을 준수합니다. `0.y.z` 시리즈에서는 공개 도구 스키마가 변경될 수 있으며, 하위 호환성을 깨뜨리는 변경사항은 `CHANGELOG.md`에 명시됩니다. 릴리스 태그는 `package.json`에 명시된 버전과 반드시 일치해야 합니다 (예: `v0.1.0`).
