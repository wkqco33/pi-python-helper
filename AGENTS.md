# 개발 가이드 (Development guide)

## 적용 범위 (Scope)

`pi-python-helper`는 uv 단일 지원을 전제로 한 범위 제한(bounded) Python 검사 및 명시적 옵트인 기반 명령 실행 도구를 제공하는 TypeScript 기반 pi 패키지입니다. Python이나 uv가 설치되어 있지 않은 환경에서도 확장 로드 시 예외를 던지지 않고 구조화된 오류를 반환해야 합니다.

린트/포맷/타입 진단(LSP)은 이 패키지의 범위가 아닙니다. 해당 기능은 별도 확장에 위임합니다. 여기서 다루는 것은 **환경, 매니페스트/락파일, 의존성 그래프, 테스트 실행, 검증 게이트**입니다.

## 개발 명령어 (Commands)

```bash
npm install
npm test
npm run typecheck
npm run check
npm run test:e2e   # 실제 uv 프로젝트 대상, 네트워크 필요
pi -e ./extensions/index.ts --list-models
```

헬퍼 스크립트를 직접 확인할 때:

```bash
echo '{"mode":"all","root":"."}' | python3 helpers/scan_project.py | python3 -m json.tool
```

## 구조 (Layout)

- `extensions/index.ts` — 도구 등록 진입점. 도구 정의는 `extensions/tools/*.ts`에 분리합니다.
- `src/core/` — 결과 규격, 범위 제한 실행기, 버전, 위험도 분류
- `src/project/` — 프로젝트 루트 탐색, 스캐너 호출, 매니페스트 진단, 경로 규칙, 설치본 읽기(`installed.ts`), 3자 정합성(`conformance.ts`)
- `src/dependencies/` — import↔배포명 매핑과 의존성 계획
- `src/build/` — uv/pytest 커맨드 빌더, 파일 탐색, pytest 파싱, 실패 진단, 오래된 아티팩트
- `src/validation/` — 완료 게이트, TDD 체크포인트, 검증 번들 요약
- `helpers/scan_project.py` — `ast` 및 `tomllib` 기반 읽기 전용 스캐너

`extensions/index.ts`를 단일 대형 파일로 키우지 마세요. 로직은 `src/`의 순수 함수로 두고 단위 테스트를 붙입니다.

## 구현 규칙 (Implementation rules)

- 사용자 입력을 쉘 문자열로 직접 보간하지 말고 **항상 인자 배열**로 전달하세요. uv/pytest/git 호출은 `runCommand` 또는 `src/build/commands.ts`의 빌더를 사용합니다.
- 모든 서브프로세스는 타임아웃, `AbortSignal`, 출력 크기 제한을 적용하세요.
- 모든 도구는 공통 `PyToolResult` 규격을 반환하세요.
- 읽기 전용 작업은 자동 실행 가능하지만, `uv sync`/`uv lock`처럼 상태를 바꾸는 작업은 `execute: true` 옵트인을 요구하세요. 이 패키지는 소스 파일을 쓰지 않습니다.
- 프로젝트를 수정하는 헬퍼를 추가하지 마세요. `helpers/scan_project.py`는 읽기 전용을 유지해야 합니다.
- 헬퍼의 파일 시스템 접근은 `safe_is_file`/`safe_is_dir`/`safe_iterdir`를 통해서만 하세요. 읽을 수 없는 디렉터리 하나가 전체 스캔을 중단시켜서는 안 됩니다(`PermissionError`는 실제로 흔한 조건입니다).
- 파일을 파싱할 때는 실제 파서를 사용하세요(`ast`, `tomllib`). 정규식 기반 TOML/Python 파싱을 새로 작성하지 마세요.
- 판정 신뢰도가 낮으면 경고하지 말고 `notes`(`info`)로 내리거나 옵트인 파라미터로 분리하세요. 오탐은 도구 신뢰도를 떨어뜨립니다.
- 실패 진단은 **출력상 가장 먼저 등장하는 원인**을 선택해야 합니다. `site-packages` 프레임을 원인으로 지목하지 마세요.
- 정합성 검사에서 새 규칙을 넣을 때는 먼저 “이 항목이 이 플랫폼에서 설치되지 않는 것이 정상인가?”를 물으세요. 조건부 항목을 누락으로 보고하면 신뢰도를 잃습니다. 검증 불가 상태는 항상 `unverifiable`로 반환하고 `consistent`로 승격하지 마세요.
- 판정을 느슨하게 만들지 말고 **증명 범위를 좁히세요**. 어떤 항목이 확실하지 않으면 `counts`에 별도 집계하고 `notes`로 공개하는 편이, 경고를 삭제하는 것보다 낫습니다.
- Python 3.9 환경에서도 동작해야 하며, `tomllib` 부재 시 저하 상태를 명시적으로 경고하세요.

## 테스트 규칙 (Testing rules)
모든 파서, 정규화기, 안전 규칙, 순수 생성기 변경에 대해 단위 테스트를 작성하세요. `helpers/scan_project.py`의 계약을 바꾸면 `test/scanner-integration.test.ts`를 함께 갱신하세요. 환경 정합성 로직을 바꾸면 `test/conformance.test.ts`(순수 비교)와 `test/installed.test.ts`(파일시스템 리더)를 모두 갱신하세요. 정합성은 오탐이 발생하기 쉬운 영역이므로 마커 조건부 항목에 대한 회귀 테스트를 반드시 남기세요.

커밋 전 반드시 `npm test`, `npm run typecheck`, `npm run check`를 실행하세요. Python이 없는 환경이라는 이유로 검증 강도를 약화하지 마세요. Python 해석기를 사용할 수 없을 때는 해당 테스트가 `t.skip()`으로 건너뛰어야 하며, 조용히 통과해서는 안 됩니다.

`test/manual/e2e-uv.ts`는 실제 uv 프로젝트를 만들어 스캐너, pytest 파서, 실패 진단기, uv 커맨드 빌더를 함께 검증합니다. 이 중 하나를 변경하면 `npm run test:e2e`를 실행하세요. 이 스크립트는 `test/*.test.ts` 글롭 밖에 있으므로 `npm test`에 포함되지 않습니다.

## 커밋 규칙 (Commit rules)

`feat:`, `fix:`, `test:`, `docs:`, `chore:` 등 명확한 목적의 Conventional Commits 형식을 사용하세요. `node_modules`, `.venv`, `__pycache__`, `*.pyc`, `.coverage`, 로그, 비밀 정보 및 인증 정보는 절대 커밋하지 마세요.
