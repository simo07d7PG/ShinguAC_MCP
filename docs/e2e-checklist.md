# E2E 검증 체크리스트 (v1 완료 정의 AC-E1~E5)

- 스펙: `.omc/specs/deep-interview-shingu-portal-mcp.md`
- 실행일: 2026-10-26 (2026학년도 2학기, 학생 계정 1개, Windows 11, Node 24.20.0)
- 개인 값(학번·이름·성적)은 기재하지 않는다.

## 수행 방법

| AC | 방법 | 명령 |
|---|---|---|
| E1 | Claude Code에 MCP 등록 후 새 세션에서 "이번 주 과제 뭐 있어?" | `.mcp.json`(로컬) + `~/.shingu-mcp/config.json` → `claude` |
| E2 | 빌드된 서버를 stdio로 띄워 7개 도구 순차 호출 + 전체 단위/통합 테스트 | `npm run build && npm run smoke`, `npm test` |
| E3 | 큐 단위 테스트(순차·간격·타임아웃·재시도) + 실측 요청 로그 | `npx vitest run tests/unit/request-queue.test.ts` |
| E4 | ~~실패하는 fetch를 주입해 스냅샷 fallback 확인~~ (2026-10-27 스냅샷·fallback 제거로 폐기) | ~~`npm run smoke:stale`~~ |
| E5 | README 3요소, 커밋 메시지 규칙, 금지 경로·PII 미추적 | `npm run check:pii`, `git ls-files`, `git log` |

## 실행 기록

### AC-E1 — 실제 포털 데이터로 "이번 주 과제" 응답 (첫 호출 로그인 포함)
- [x] 2026-10-26 사용자 확인: 새 Claude Code 세션에서 "이번 주 과제 뭐 있어?" → 실제 과목·제목·마감·제출 상태로 응답.
- 소요(stdio 스모크, 세션 없는 첫 호출): `get_assignments({due_within_days: 7})` **15.5초**(로그인 7요청 + E클래스 홈 1 + 과목 4×2 + 상세 11). 기준 15초에 대해 경계값 — 사용자 결정으로 요청 간격 500→200ms 적용 후 측정치. 제출 시작 전 과제의 상세 생략(97615d3) 이후 재측정은 미실시.
- 결과 11건: 미제출 9 / 제출 1 / 기간 아님 1.

### AC-E2 — 7개 도구 실계정 성공 + 테스트 통과
- [x] `npm run smoke` (dist/index.js, 실계정): `tools/list` 7개, 7/7 성공, stdout에 JSON-RPC 외 출력 없음.
  - get_assignments 15.5s · get_timetable 0.3s(19 entries) · get_courses 1.2s(7) · get_notices 0.4s(5) · get_notice 0.7s(본문 542자, 첨부 1) · get_grades 1.5s(학기 1·학점 3·현재 7) · refresh_snapshots 46s(5범주 ok)
- [x] `npm test`: 20 files / 169 tests 통과. `npm run typecheck`, `npm run build` 통과.

### AC-E3 — 요청 예절 (순차, ≥200ms, 15초 타임아웃, 재시도 1회)
- [x] `tests/unit/request-queue.test.ts`: 동시 5건 → 동시성 1·간격 ≥200ms, 15초 미응답 → TimeoutError·재시도 1회(fetch 2회), 5xx→200 성공, 4xx 재시도 없음.
- [x] 모든 포털 요청(리다이렉트 hop 포함)이 `RequestQueue`를 경유함(`src/http/http-client.ts` `sendOnce`).
- 간격 기준은 스펙 원안 500ms에서 2026-10-26 사용자 결정으로 200ms로 변경(`docs/portal-pages.md` §4.2).

### AC-E4 — 포털 장애 시 stale 스냅샷 응답 (폐기)
- 2026-10-27 사용자 결정으로 JSON 스냅샷과 fallback을 제거했다. 아래는 당시 기록.
- [x] `npm run smoke:stale` (ECONNREFUSED를 던지는 fetch 주입, `~/.shingu-mcp/snapshots` 사용): getAssignments / getTimetable / getGrades / getNotices 모두 `stale: true`, `source: "snapshot"`, 이전 `fetchedAt` 유지, `warning`에 원인 요약.
- [x] 스냅샷 없음 + 실패 → 에러: `tests/unit/category-service.test.ts`.
- 실제 네트워크 차단(Wi-Fi off) 수동 검증은 미실시(동등한 주입 테스트로 대체).

### AC-E5 — README·커밋 위생
- [x] README: 설치 절차 / 자격증명 설정(env → config.json) / "브라우저 포털 로그인이 풀릴 수 있음" 주의 — WI-10 (`README.md`).
- [x] `git log --format=%B | grep -Ei 'claude|anthropic|generated with'` → 0건. 모든 제목 `[Type] 한국어` 형식.
- [x] `git ls-files`에 `.env`, `dist/`, `node_modules/`, `tests/fixtures/raw/`, `.mcp.json` 없음.
- [x] `npm run check:pii` 통과. `git log -p --all`에 `.env`의 학번·비밀번호 값 0건. 추적 파일에 학생 실명 0건.

## 알려진 한계
- 과제 제출 상태는 상세 페이지를 열어야 알 수 있어 마감 임박 과제 수에 비례해 시간이 늘어난다(과제 1건당 약 0.7초).
- 교수 연락처(`include_contacts: true`)는 포털 서버가 느려 과목당 약 7초.
- 학업성적표(SSJ038P)는 출력기간에만 데이터가 있어 사용하지 않음. 출석은 포털에 화면이 없어 제외(사용자 결정).
