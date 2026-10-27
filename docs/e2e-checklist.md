# E2E 검증 체크리스트 (v1 완료 정의 AC-E1~E5)

- 스펙: `.omc/specs/deep-interview-shingu-portal-mcp.md`
- 실행일: 2026-10-26 (2026학년도 2학기, 학생 계정 1개, Windows 11, Node 24.20.0)
- 개인 값(학번·이름·성적)은 기재하지 않는다.

## 수행 방법

| AC | 방법 | 명령 |
|---|---|---|
| E1 | Claude Code에 MCP 등록 후 새 세션에서 "이번 주 과제 뭐 있어?" | `.mcp.json`(로컬) + `~/.shingu-mcp/config.json` → `claude` |
| E2 | 빌드된 서버를 stdio로 띄워 도구 순차 호출 + 전체 단위/통합 테스트 | `npm run build && npm run smoke`, `npm test` |
| E3 | 큐 단위 테스트(순차·간격·타임아웃·재시도) + 실측 요청 로그 | `npx vitest run tests/unit/request-queue.test.ts` |
| E4 | ~~실패하는 fetch를 주입해 스냅샷 fallback 확인~~ (2026-10-27 스냅샷·fallback 제거로 폐기) | ~~`npm run smoke:stale`~~ |
| E5 | README 3요소, 커밋 메시지 규칙, 금지 경로·PII 미추적 | `npm run check:pii`, `git ls-files`, `git log` |
| E6 | 실계정으로 `sync_eclass` 실행(첫/증분) | MCP로 `sync_eclass` 호출 |
| E7 | 동기화 후 `search_archive`로 조회(계획) | MCP로 `search_archive` 호출 |
| E8 | `submit_assignment` 미리보기 → 승인 → 실제 제출 | `docs/submit-verification-plan.md` |

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

## 2026-10-27 추가 항목

### AC-E6 — `sync_eclass` (E클래스 아카이브 동기화)
- [x] 실제 `~/.shingu-mcp`(DB `eclass.db` + `files/`) 첫 동기화 **170.5초**: 강의 2개 읽음(다른 2개는 과제·게시글이 없어 건너뜀), 과제 31, 내 제출 10, 수업공지 2, 자료실 26, 첨부 56(받음 45 + sha256 중복 재사용 11), 실패 0, 디스크 325MB.
- [x] 증분 실행(2026-10-27, 진행률·취소·14일 재확인 반영 f8901eb 이후) **23.3초**: 신규·갱신 0, 다시 받은 첨부 0, 실패 0. 14일 이내 게시글을 다시 읽어도 본문·첨부가 같아 `updated`로 세지 않고 다시 받지 않는다.
- 이전 측정(임시 디렉터리): 다운로드 없이 47.7초, 다운로드 포함 약 300초 — 후자는 마감 지난 제출 판정 수정(a4b3540) 전 값이다.
- [x] 단위 테스트로 증분·실패 격리·다운로드 검증 확인(`tests/unit/`). 포털에는 쓰지 않는다(읽기 전용).
- 진행률 알림·취소(f8901eb): 클라이언트가 progressToken을 주면 진행률을 보내고, 취소하면 다음 단계 전에 멈춘다(저장한 것은 유지). 클라이언트가 진행률로 타임아웃을 늘리지 않으면 첫 동기화(약 3분)가 타임아웃될 수 있으니 `download_files: false`로 먼저 실행한다.

### AC-E7 — 아카이브 조회 (`search_archive`, 계획)
- [ ] `sync_eclass`로 채운 DB를 포털 요청 없이 조회한다. 첫 실행 뒤 확인할 것:
  - [ ] `kind: assignments` — 과목·제목·마감·내 제출 여부(`submitted`/`not_submitted`/`not_open`), 마감 오름차순.
  - [ ] `kind: posts` + `board: notice`/`material` — 등록일시 내림차순.
  - [ ] `course`·`query`·`due_from/due_to`·`limit` 필터가 기대대로 동작(특수문자 `%`·`_` 포함 검색 포함).
  - [ ] 첨부는 로컬 절대 경로와 받았는지 여부만 나오고 원본 URL(file_key)은 나오지 않는다.
  - [ ] DB가 없거나 비어 있으면 "먼저 sync_eclass를 실행하세요" 안내와 빈 결과.
  - [ ] 소요(포털 요청 0건이라 즉시 응답 기대) 기록.

### AC-E8 — 과제 제출 (`submit_assignment`)
- [x] 미리보기(`confirm_token` 없음)는 실측했다(`npm run smoke:submit-preview`). 실제 제출은 **미실시**.
- [ ] 첫 실제 제출 검증: 절차와 확인 항목은 `docs/submit-verification-plan.md`. 결과는 여기에 기록한다.

## 알려진 한계
- 과제 제출 상태는 상세 페이지를 열어야 알 수 있어 마감 임박 과제 수에 비례해 시간이 늘어난다(과제 1건당 약 0.7초).
- 교수 연락처(`include_contacts: true`)는 포털 서버가 느려 과목당 약 7초.
- 학업성적표(SSJ038P)는 출력기간에만 데이터가 있어 사용하지 않음. 출석은 포털에 화면이 없어 제외(사용자 결정).
