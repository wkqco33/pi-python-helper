# 기여 가이드 (Contributing)

## 시작하기 (Getting started)

```bash
npm install
npm test
npm run typecheck
npm run check        # 테스트 + 타입 + 포맷 + 패키지 내용 검사
```

네트워크와 uv가 있는 환경에서는 실제 uv 프로젝트를 만들어 전 경로를 검증할 수 있습니다.

```bash
npm run test:e2e
```

확장이 실제로 로드되는지 확인:

```bash
pi -e ./extensions/index.ts --list-models
```

## 개발 규칙 (Development rules)

자세한 구현 규칙은 `AGENTS.md`를 참고하세요. 요약:

- `extensions/`는 도구 **등록**만 담당하고, 로직은 `src/`의 순수 함수로 두세요. `extensions/index.ts`를 단일 대형 파일로 키우지 마세요.
- 사용자 입력을 쉘 문자열로 보간하지 말고 항상 인자 배열로 전달하세요. 모든 서브프로세스는 타임아웃, `AbortSignal`, 출력 크기 제한을 적용해야 합니다.
- 이 패키지의 도구는 프로젝트 파일을 쓰지 않습니다. 상태를 바꾸는 명령(`uv sync`/`uv lock`)은 `execute: true` 옵트인을 요구하세요.
- `helpers/scan_project.py`는 읽기 전용을 유지하세요. 파일시스템 접근은 `safe_is_file`/`safe_is_dir`/`safe_iterdir`를 통해서만 하고, 한 디렉터리의 `PermissionError`가 전체 스캔을 중단시켜서는 안 됩니다.
- 도구 판정을 느슨하게 만들지 말고 **증명 범위를 좁히세요**. 불확실한 항목은 `counts`에 별도 집계하고 `notes`로 공개하는 편이 경고를 삭제하는 것보다 낫습니다.
- 새 도구를 추가하기 전에 기존 도구에 파라미터로 흡수할 수 있는지 먼저 검토하세요. 도구 표면적은 의도적으로 작게 유지합니다.

## 테스트 요구사항 (Testing requirements)

- 모든 파서, 정규화기, 안전 규칙, 순수 생성기 변경에 단위 테스트를 작성하세요.
- `helpers/scan_project.py`의 계약(요청/결과 문서, 종료 코드)을 바꾸면 `test/helper-cli.test.ts`와 `test/scanner-integration.test.ts`를 함께 갱신하세요. 스캐너 프로토콜을 깨는 변경은 `SCANNER_VERSION`과 `SUPPORTED_SCANNER_VERSION`을 함께 올려야 합니다.
- 환경 정합성 로직을 바꾸면 `test/conformance.test.ts`(순수 비교)와 `test/installed.test.ts`(파일시스템 리더)를 모두 갱신하고, 마커 조건부 항목에 대한 회귀 테스트를 남기세요.
- 커밋 전 `npm test`, `npm run typecheck`, `npm run check`를 실행하세요. Python이 없는 환경이라는 이유로 검증 강도를 약화하지 말고 해당 테스트를 `t.skip()`으로 건너뛰세요.

## 도구 레퍼런스 (Tool reference)

`docs/tools.md`는 생성 파일입니다. 도구의 이름, 설명, `promptSnippet`, `promptGuidelines`, 파라미터 스키마를 변경하면 반드시 다시 생성하세요.

```bash
npm run docs
```

- `docs/api-surface.json` — 반환 형태 스냅샷. 구조만 기록하고 값·경로·버전·소요시간은 제외하므로 머신과 릴리스 간에 안정적입니다.
- `docs/tools.md` — 위 스냅샷과 실시간 등록 정보로 렌더링한 사람이 읽는 레퍼런스.
- 스냅샷 캡처는 python3와 uv가 필요합니다. 둘 중 하나라도 없으면 스냅샷은 도구 목록과 파라미터만 담고 반환 형태는 비워둡니다(경고 출력). CI의 `python-scanner` job이 두 가지를 모두 갖춘 상태에서 반환 형태를 검증합니다.

`test/api-surface.test.ts`가 다음을 강제합니다.

1. 등록된 도구 집합이 명시적 목록과 일치
2. 파라미터 스키마가 스냅샷과 일치
3. `docs/tools.md`가 최신
4. 캡처한 반환 형태가 스냅샷과 일치

도구를 추가·이름 변경·제거하는 것은 에이전트 프롬프트와 레퍼런스에 대한 파괴적 변경이므로, 테스트의 `EXPECTED_TOOLS` 목록도 함께 수정해야 합니다.

## 커밋과 릴리스 (Commits and releases)

`feat:`, `fix:`, `test:`, `docs:`, `chore:` 등 Conventional Commits를 사용하세요.

릴리스 순서:

1. `package.json`의 `version`을 올립니다.
2. `CHANGELOG.md`의 `[Unreleased]` 항목을 새 버전 섹션으로 옮기고 날짜를 기록합니다.
3. `v<version>` 태그를 푸시합니다. `.github/workflows/publish.yml`이 태그와 `package.json` 버전이 일치하는지 확인한 뒤 npm provenance와 함께 배포합니다.

`node_modules`, `.venv`, `__pycache__`, `*.pyc`, `.coverage`, 로그, 비밀 정보는 커밋하지 마세요.

## 보안 (Security)

취약점은 공개 이슈가 아니라 `SECURITY.md`에 안내된 비공개 채널로 제보해 주세요.
