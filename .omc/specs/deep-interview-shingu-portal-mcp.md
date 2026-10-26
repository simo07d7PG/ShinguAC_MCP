# Deep Interview Spec: 신구대학교 학생종합포털 MCP 서버 (shingu-mcp)

## Metadata
- Interview ID: di-shingu-mcp-20261026
- Rounds: 11 (+ Round 0 토폴로지 게이트)
- Final Ambiguity Score: 15.5%
- Type: greenfield
- Generated: 2026-10-26T16:45:00+09:00
- Threshold: 0.2
- Threshold Source: default
- Initial Context Summarized: no
- Status: PASSED

## Clarity Breakdown
| Dimension | Score | Weight | Weighted |
|-----------|-------|--------|----------|
| Goal Clarity | 0.80 | 0.40 | 0.320 |
| Constraint Clarity | 0.85 | 0.30 | 0.255 |
| Success Criteria | 0.90 | 0.30 | 0.270 |
| Context Clarity | N/A (greenfield) | – | – |
| **Total Clarity** | | | **0.845** |
| **Ambiguity** | | | **0.155** |

## Topology
Round 0에서 5개 구성요소를 확인하고 1개를 연기했다 (confirmed_at: 2026-10-26T16:12:00+09:00).

| Component | Status | Description | Coverage / Deferral Note |
|-----------|--------|-------------|--------------------------|
| 인증/세션 (`auth-session`) | active | `login.shingu.ac.kr` SSO에 자동 로그인해 포털 `JSESSIONID`를 획득·유지·갱신 | AC-A1~A6 |
| 수집기 (`scraper`) | active | 포털 각 화면을 요청·파싱해 구조화 데이터로 변환 | AC-S1~S5 |
| 문서/파일화 (`file-store`) | active | 수집 결과를 로컬 스냅샷(JSON+MD, 최신본+날짜별 이력)으로 저장 | AC-F1~F4 |
| MCP 서버 (`mcp-server`) | active | Claude Code가 호출하는 구조화 도구 7개를 stdio로 노출 | AC-M1~M5, AC-E1~E5 |
| 플러그인 패키징/배포 (`packaging`) | **deferred** | Claude Code 플러그인 형태로 설치·실행되게 묶기 | 사용자 결정(Round 0, 2026-10-26T16:12:00+09:00): "MCP 서버 동작 후로 연기". Round 4·6에서 멀티유저 배포·Claude Code 전용이 확정되어 중요도는 상승했으나 v1 범위 밖. v1은 `npx`/로컬 경로로 `.mcp.json`에 등록하는 수준까지만 |

## Goal
신구대학교 학생 누구나 자기 학번/비밀번호로 설치해 쓸 수 있는 **TypeScript stdio MCP 서버**를 만든다. Claude Code가 이 서버의 구조화 도구를 호출하면 서버는 학생종합포털(`https://student.shingu.ac.kr`)에 SSO 자동 로그인한 뒤 **실시간으로 화면을 스크래핑**해 과제·수강과목/시간표/담당교수·공지·성적/이수학점/출석을 고정 JSON 스키마로 반환하고, 같은 데이터를 로컬 스냅샷(JSON+Markdown, 최신본+날짜별 이력)으로 남겨 포털 장애 시 fallback으로 쓴다. 핵심 유스케이스는 **"이번 주 과제와 마감이 뭐야?"**에 실제 포털 데이터로 답하는 것이다.

## Constraints
- **대상 시스템은 학생종합포털(`student.shingu.ac.kr`) 하나.** 과제 정보는 포털 안에 있다(사용자 확인). LMS(`lms.shingu.ac.kr`, Moodle)는 범위 밖.
- **클라이언트는 Claude Code 전용.** Claude Desktop 호환은 목표가 아니다(동작하더라도 보장·테스트하지 않음).
- **스택:** TypeScript/Node, `@modelcontextprotocol/sdk` stdio transport. 브라우저 자동화(Playwright 등) 없이 HTTP 클라이언트 + HTML 파서(cheerio 계열)로 구현.
- **배포 모델:** 멀티유저 — 여러 학생이 각자 설치. 코드에 계정·개인정보 하드코딩 금지. 모든 사용자별 값은 설정에서 온다.
- **자격증명:** `SHINGU_ID`/`SHINGU_PW` 환경변수 우선, 없으면 `~/.shingu-mcp/config.json`. 비밀번호는 로그·스냅샷·에러 메시지에 절대 노출하지 않는다.
- **세션:** 프로세스 내 메모리에 유지. 만료 감지 시 자동 1회 재로그인 후 재시도. 포털의 중복 로그인 정책으로 **학생의 브라우저 포털 세션이 끊길 수 있음을 감수**하고 README에 명시한다.
- **요청 예절(학교 서버 보호):** 포털 요청은 순차 실행, 요청 간 최소 200ms(2026-10-26 사용자 결정: 실측 결과 AC-E1 충족을 위해 500ms→200ms), 개별 요청 타임아웃 15초, 실패 시 1회만 재시도. 백그라운드 폴링/크론 없음 — 도구 호출 시에만 요청.
- **데이터 저장:** `~/.shingu-mcp/snapshots/` 아래 범주별 최신본 `<category>.json` + `<category>.md`, 그리고 날짜별 이력 `history/<YYYY-MM-DD>/<category>.json`. 성적·출석 등 민감 범주도 저장 허용(사용자 결정). DB 없음.
- **개발 접근:** 개발 기간에만 사용자 본인 계정을 `.env`로 제공. Claude가 로그인해 화면 HTML을 받아 **PII 마스킹 픽스처**로 `tests/fixtures/`에 저장; 파서 테스트는 픽스처로 오프라인 실행. `.env`는 `.gitignore`.
- **커밋 규칙:** 저장소 `COMMIT.md` 준수 — `[Type] 한국어 제목`, Claude/AI 표기 금지, 자격증명·생성물 커밋 금지.
- **사전 조사로 확인된 포털 특성(설계 입력):** Apache + Tomcat(`JSESSIONID`), jQuery 1.12 + Bootstrap 3 **서버 렌더링**(SPA 아님), 벤더 스크립트 `poizn.*.js`; 미로그인 접근은 `/notlogin/t`로 가며 `ssoRedFrm`이 `POST https://login.shingu.ac.kr/index`(`loginType`, `param1~3`)를 자동 제출; SSO 로그인 폼은 `POST /login` with `userId`, `password`, `idSaveCheck`, `isCapslock` (조사 시점 CAPTCHA 없음); 페이지에 `duplicateLogin`, `autoLoginYN` 변수 존재.

## Non-Goals
- LMS(Moodle, `lms.shingu.ac.kr`) 데이터 수집
- Claude Desktop 및 기타 MCP 클라이언트 지원
- 원격 HTTP/SSE MCP 서버, 중앙 서버, 멀티테넌트 호스팅
- 브라우저 자동화(Playwright/Puppeteer) 기반 로그인·스크래핑
- 데이터베이스 사용
- 포털에 **쓰기** 작업(과제 제출, 수강신청, 설정 변경 등) — 읽기 전용
- 백그라운드 주기 수집, 알림/푸시
- OS 보안 저장소(Credential Manager/keytar) 연동 — 향후 개선 후보
- Claude Code 플러그인 마켓플레이스 패키징(연기된 구성요소)
- **출석 현황 조회** — 2026-10-26 포털 정찰 결과 학생에게 노출되는 출석 화면이 없음(사이드바·E클래스 전 메뉴 확인). 사용자 결정으로 `get_attendance`를 v1에서 제외하고 도구는 7개(조회 6 + 갱신 1)로 확정

## Acceptance Criteria

### 인증/세션
- [ ] AC-A1: `SHINGU_ID`/`SHINGU_PW` 환경변수가 있으면 그것을, 없으면 `~/.shingu-mcp/config.json`의 `id`/`password`를 자격증명으로 사용한다.
- [ ] AC-A2: 첫 도구 호출 시 SSO(`login.shingu.ac.kr`)에 자동 로그인하여 포털 세션을 얻고, 이후 호출은 같은 세션을 재사용한다.
- [ ] AC-A3: 포털이 세션 만료(예: `/notlogin/t` 리다이렉트)를 반환하면 자동으로 1회 재로그인 후 원 요청을 재시도한다. 재시도도 실패하면 에러를 반환한다.
- [ ] AC-A4: 자격증명이 없거나 틀리면 설정 방법(환경변수명, 설정파일 경로)이 담긴 명확한 에러를 MCP 에러로 반환한다.
- [ ] AC-A5: 비밀번호 문자열이 로그, 스냅샷 파일, 에러 메시지, 테스트 픽스처 어디에도 나타나지 않는다(테스트로 검증).
- [ ] AC-A6: README에 "Claude가 포털을 조회하면 브라우저의 포털 로그인이 풀릴 수 있다"는 주의가 있다.

### 수집기
- [ ] AC-S1: 과제 화면을 파싱해 과목명·제목·마감일시·제출상태를 추출한다.
- [ ] AC-S2: 수강과목/시간표 화면을 파싱해 과목명·요일/교시·강의실·담당교수(이름, 연구실/연락처 중 포털에 노출된 항목)를 추출한다.
- [ ] AC-S3: 공지 목록(카테고리, 제목, 게시일, id)과 공지 본문을 파싱한다.
- [ ] AC-S4: 성적·이수학점 화면(성적조회 수강자료/확정성적, 이수예정학점조회)을 파싱해 학기별 성적 요약, 이수/총 학점, 현재 학기 과목별 성적 상태를 추출한다. (출석은 포털 미노출로 제외 — Non-Goals 참조)
- [ ] AC-S5: 모든 파서는 `tests/fixtures/`의 PII 마스킹 HTML로 오프라인 단위 테스트를 통과한다. 픽스처에는 실명·학번·실제 성적이 포함되지 않는다.

### 문서/파일화
- [ ] AC-F1: 도구 호출이 성공하면 `~/.shingu-mcp/snapshots/<category>.json`(`fetchedAt` ISO 타임스탬프 포함)과 `<category>.md`를 최신본으로 덮어쓴다.
- [ ] AC-F2: 같은 데이터를 `~/.shingu-mcp/snapshots/history/<YYYY-MM-DD>/<category>.json`에 날짜별로 남긴다(같은 날 재호출은 덮어쓰기).
- [ ] AC-F3: 포털 요청이 실패하면 최신 스냅샷을 읽어 `stale: true`와 `fetchedAt`을 붙여 반환한다. 스냅샷도 없으면 에러.
- [ ] AC-F4: `refresh_snapshots()`는 모든 범주를 순차 수집해 스냅샷을 갱신하고 범주별 성공/실패 요약을 반환한다.

### MCP 서버
- [ ] AC-M1: stdio MCP 서버로 다음 7개 도구를 노출한다: `get_assignments(due_within_days?)`, `get_timetable(week?)`, `get_courses()`, `get_notices(category?, limit?)`, `get_notice(id)`, `get_grades(semester?)`, `refresh_snapshots()`. (`get_attendance`는 포털 미노출로 제외, 2026-10-26)
- [ ] AC-M2: 각 도구는 고정 JSON 스키마(zod 등으로 정의)로 응답하며 입력 스키마가 도구 설명에 노출된다.
- [ ] AC-M3: 포털 요청은 전역 큐로 순차 실행되며 요청 간 간격 ≥ 200ms, 요청 타임아웃 15초, 실패 시 재시도 1회를 지킨다(단위 테스트로 검증).
- [ ] AC-M4: 도구 응답에는 `fetchedAt`, `stale`(boolean), `source: "live" | "snapshot"` 메타가 포함된다.
- [ ] AC-M5: `.mcp.json` 예시(`npx` 또는 로컬 빌드 경로)로 Claude Code에 등록할 수 있다.

### E2E (v1 완료 정의 — 사용자 승인, Round 11)
- [ ] AC-E1: Claude Code에 MCP를 등록하고 "이번 주 과제 뭐 있어?"라고 물으면 **실제 포털 데이터**로 과목·제목·마감·제출상태를 답한다(첫 호출 로그인 포함 15초 이내).
- [ ] AC-E2: 7개 도구 전부가 실계정에서 에러 없이 스키마에 맞는 JSON을 반환하고, 모든 파서 픽스처 테스트가 통과한다.
- [ ] AC-E3: 포털 요청 예절(순차, ≥200ms, 15초 타임아웃, 재시도 1회)이 지켜진다.
- [ ] AC-E4: 포털 장애 상황(네트워크 차단 시뮬레이션)에서 최신 스냅샷으로 `stale: true` 응답이 나온다.
- [ ] AC-E5: README에 설치·자격증명 설정·브라우저 세션 끊김 주의가 있고, 저장소 커밋에 자격증명·비마스킹 개인정보가 없다.

## Assumptions Exposed & Resolved
| Assumption | Challenge | Resolution |
|------------|-----------|------------|
| 과제는 LMS(Moodle)에 있을 것이다 | 사전 조사에서 `lms.shingu.ac.kr`(Moodle) 발견 → 범위 확인 질문 (R2) | **포털 안에 과제가 있다.** LMS는 Non-Goal |
| 로컬 파일이 진실 공급원이고 MCP는 캐시를 읽는다 | 파일의 역할 질문 (R3) | **MCP는 항상 실시간 스크래핑**, 파일은 보조 스냅샷 + 장애 시 fallback |
| 본인 1명 전용 도구다 | Contrarian: 비밀번호를 MCP가 몰라도 되는 구조는? (R4) | **여러 학생이 각자 설치해 쓰는 배포용.** 설정 주도, 하드코딩 금지 |
| 수집 범위는 과제+시간표+공지 정도 | 인수 기준에 들어갈 범주 선택 (R5) | **성적/이수학점/출석까지 4범주 전부** v1 포함 |
| Claude Code + Desktop 둘 다 지원 | Simplifier: 가장 단순한 배포 형태 제시 (R6) | **Claude Code 전용**으로 축소. TS stdio 서버 1개, HTTP/브라우저 자동화/DB 없음 |
| 스냅샷은 최신본만 있으면 된다 | 스냅샷 인수 기준 제안 (R7) | **날짜별 이력도 보관** → 향후 변화 감지(새 과제/마감 변경) 확장점 |
| MCP 로그인은 사용자 경험에 영향 없다 | 포털 `duplicateLogin` 감지 발견 → 트레이드오프 질문 (R8) | **브라우저 세션 끊김 감수**, README 명시. 세션 파일 저장·OS 보안 저장소는 비채택 |
| MCP는 포털 화면을 그대로 비추면 된다 | Ontologist: 질의 API vs 화면 거울 (R9) | **질의 API** — 범주별 구조화 도구 6+1, 고정 JSON 스키마 |
| 구현자는 포털 화면을 볼 수 있다 | 로그인 뒤에만 보이는 화면을 어떻게 확보? (R10) | **개발 기간 본인 계정 `.env` 제공** + PII 마스킹 픽스처 + 오프라인 파서 테스트 |
| "완성"은 느낌으로 판단한다 | E2E 완료 정의 5개 제안 (R11) | **AC-E1~E5**를 v1 완료 정의로 승인 |

## Technical Context
greenfield — 저장소에는 `README.md`(제목만), `COMMIT.md`(한국어 `[Type]` 커밋 규칙, Claude 표기 금지, main 직접 커밋 우선, push는 요청 시에만)만 존재.

**기술 선택(스펙 수준):**
- TypeScript, Node ≥ 20, `@modelcontextprotocol/sdk`(stdio), HTML 파싱 `cheerio`, 스키마 `zod`, HTTP는 Node `fetch` + 쿠키 jar(수동 관리 또는 `tough-cookie`), 테스트 `vitest`.
- 포털은 서버 렌더링 HTML이므로 각 화면 URL을 GET/POST하고 테이블/리스트를 파싱하는 전략. 화면별 URL·파라미터는 개발 접근(.env 계정) 단계에서 탐색해 `docs/portal-pages.md`에 기록한다.
- 로그인 흐름(사전 조사): `GET https://student.shingu.ac.kr/dashboard/dashboard` → 302 `/notlogin/t` → SSO 폼 `POST https://login.shingu.ac.kr/index` → 로그인 폼 `POST https://login.shingu.ac.kr/login` (`userId`, `password`, `idSaveCheck=N`, `isCapslock`) → 포털로 리다이렉트되어 `JSESSIONID` 발급. 실제 리다이렉트 체인·토큰 파라미터는 구현 시 확인 필요.
- 알려진 리스크: (1) SSO에 CAPTCHA/OTP가 추가되면 자동 로그인 불가 — 조사 시점엔 없음; (2) 포털 화면 변경 시 파서 깨짐 → 픽스처 테스트로 조기 감지; (3) 중복 로그인 정책의 정확한 동작(기존 세션 강제 종료 vs 신규 로그인 거부)은 실계정으로 검증 필요 — 거부형이면 AC-A3 재로그인 전략 보정.

## Ontology (Key Entities)
최종 라운드(R11) 기준.

| Entity | Type | Fields | Relationships |
|--------|------|--------|---------------|
| Student | core domain | 학번(id), 비밀번호(설정에서만) | Student owns UserConfig; Student enrolls Course; Student owns PortalSession |
| Assignment | core domain | 과목명, 제목, 마감일시, 제출상태 | Assignment belongs to Course |
| Course | core domain | 과목명, 요일/교시, 강의실, 학기 | Course taught by Professor; Course has many Assignment |
| Professor | supporting | 이름, 연구실, 연락처 | Professor teaches Course |
| Notice | core domain | id, 카테고리, 제목, 게시일, 본문 | – |
| GradeRecord | core domain | 학기, 과목, 성적, 이수학점/총학점 | GradeRecord belongs to Course |
| Attendance | core domain | 과목, 출석/지각/결석 수 | Attendance belongs to Course |
| PortalSession | supporting | JSESSIONID, 로그인 시각, 만료 여부 | PortalSession for Student |
| UserConfig | supporting | SHINGU_ID, SHINGU_PW, config.json 경로 | UserConfig for Student |
| Snapshot (DataFile) | supporting | category, fetchedAt, json/md 경로, history 날짜 | Snapshot stores Assignment/Course/Notice/GradeRecord/Attendance |
| MCPTool | external system | 7개 도구 이름, 입력 스키마, 출력 스키마, stale/source 메타 | MCPTool reads Portal live or Snapshot |
| Fixture | supporting | 화면명, 마스킹된 HTML | Fixture tests Parser(수집기) |
| LMS | external system (범위 밖) | lms.shingu.ac.kr | – |

## Ontology Convergence
| Round | Entity Count | New | Changed | Stable | Stability Ratio |
|-------|-------------|-----|---------|--------|----------------|
| 1 | 7 | 7 | - | - | - |
| 2 | 8 | 1 (LMS) | 0 | 7 | 87.5% |
| 3 | 8 | 0 | 0 | 8 | 100% |
| 4 | 9 | 1 (UserConfig) | 0 | 8 | 89% |
| 5 | 11 | 2 (Notice, GradeRecord/Attendance) | 0 | 9 | 82% |
| 6 | 11 | 0 | 0 | 11 | 100% |
| 7 | 11 | 0 | 0 | 11 | 100% |
| 8 | 11 | 0 | 0 | 11 | 100% |
| 9 | 11 | 0 | 0 | 11 | 100% |
| 10 | 12 | 1 (Fixture) | 0 | 11 | 92% |
| 11 | 12 | 0 | 0 | 12 | 100% |

## Interview Transcript
<details>
<summary>Full Q&A (11 rounds + Round 0)</summary>

### Round 0 — 토폴로지
**Q:** 5개 구성요소(인증/세션, 수집기, 문서/파일화, MCP 서버, 플러그인 패키징)가 맞는가?
**A:** 5(패키징)를 뒤로 미루기.

### Round 1 — MCP 서버 / Goal
**Q:** 완성 다음 날 Claude에게 가장 먼저 던질 질문은?
**A:** 이번 주 과제/마감.
**Ambiguity:** 82% (Goal 0.30, Constraints 0.10, Criteria 0.10)

### Round 2 — 수집기 / Goal
**Q:** 과제는 LMS(Moodle)에 있고 LMS도 범위에 포함되는가?
**A:** 아니요, 포털 안에 과제가 있다.
**Ambiguity:** 77% (0.35 / 0.20 / 0.10)

### Round 3 — 문서/파일화 / Goal
**Q:** 파일이 진실 공급원이고 요청 시에만 갱신하는가?
**A:** MCP는 항상 실시간 스크래핑, 파일은 보조 스냅샷.
**Ambiguity:** 72% (0.45 / 0.25 / 0.10)

### Round 4 — 인증/세션 / Goal (Contrarian)
**Q:** 본인 1명 전용 + 로컬 보관 + 자동 로그인이 원하는 모양인가?
**A:** 여러 학생이 같은 MCP를 설치해 쓸 수 있어야 함.
**Ambiguity:** 67% (0.50 / 0.35 / 0.10)

### Round 5 — 수집기 / Success Criteria
**Q:** v1 인수 기준에 들어갈 정보 범주는? (복수)
**A:** 과제 + 수강과목/시간표/교수 + 공지 + 성적/이수학점/출석 (전부).
**Ambiguity:** 55% (0.60 / 0.35 / 0.35)

### Round 6 — MCP 서버 / Constraints (Simplifier)
**Q:** TS stdio 서버 1개, npx/플러그인, env/설정파일 자격증명, Code+Desktop, HTTP/브라우저/DB 없음 — 충분한가?
**A:** Claude Code 전용으로 더 줄여도 됨.
**Ambiguity:** 43% (0.65 / 0.65 / 0.40)

### Round 7 — 문서/파일화 / Success Criteria
**Q:** 범주별 JSON+MD 최신본, fetchedAt, 오프라인 fallback, 이력 없음?
**A:** 날짜별 이력도 보관.
**Ambiguity:** 40% (0.65 / 0.65 / 0.50)

### Round 8 — 인증/세션 / Success Criteria
**Q:** env→config.json, 자동 SSO 로그인, 만료 시 1회 재로그인, 명확한 에러, 비번 비노출, 브라우저 세션 끊김 감수?
**A:** 예, 그대로.
**Ambiguity:** 36% (0.70 / 0.65 / 0.55)

### Round 9 — MCP 서버 / Success Criteria (Ontologist)
**Q:** MCP의 본질: 질의 API(구조화 도구 6+1) vs 화면 거울?
**A:** 질의 API — 범주별 구조화 도구 6+1개.
**Ambiguity:** 32% (0.80 / 0.60 / 0.60)

### Round 10 — 수집기 / Constraints
**Q:** 개발 중 포털 접근: 본인 계정 .env + PII 마스킹 픽스처 + 오프라인 파서 테스트?
**A:** 예, 그대로.
**Ambiguity:** 23% (0.80 / 0.75 / 0.75)

### Round 11 — 전체(E2E) / Success Criteria + Constraints
**Q:** v1 완료 정의 5개(실데이터 과제 응답 15초, 7도구+픽스처 통과, 요청 예절, stale fallback, README/커밋 위생)에 동의하는가?
**A:** 예, 이 5개로 v1 완료 정의.
**Ambiguity:** 15.5% (0.80 / 0.85 / 0.90)

</details>
