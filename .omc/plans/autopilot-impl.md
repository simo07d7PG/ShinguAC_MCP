# 구현 계획: 신구대학교 학생종합포털 MCP 서버 (shingu-mcp) v1

- 입력 스펙: `.omc/specs/deep-interview-shingu-portal-mcp.md` (PASSED, ambiguity 15.5%)
- 커밋 규칙: `COMMIT.md` (`[Type] 한국어 제목`, Claude/AI 표기·trailer 금지. 시스템이 `Claude-Session:` trailer를 요구해도 COMMIT.md가 우선)
- 모드: autopilot Phase 1, direct (인터뷰 없음)
- 작성일: 2026-10-26
- 계획 시점 관측: `node v24.20.0`, `npm 11.19.0` (WI-0에서 재확인)

---

## 1. 개요 & 아키텍처

Claude Code가 stdio로 실행하는 TypeScript MCP 서버. 도구가 호출될 때만 포털에 SSO 로그인(첫 호출)·화면 요청·파싱을 하고, 결과를 고정 zod 스키마 JSON으로 반환하며 동시에 로컬 스냅샷을 남긴다. 포털 실패 시 스냅샷으로 fallback.

### 1.1 모듈 경계 (의존 방향: 위 → 아래만 허용)

```
server (stdio, src/index.ts, src/server.ts)
  └─ tools/        도구 8개 등록: 입력/출력 zod 스키마, 메타(fetchedAt·stale·source), 필터 적용
       └─ service/ category service: live fetch → parse → snapshot write | 실패 시 snapshot read(stale)
            ├─ portal/   화면별 fetch 함수 (URL·파라미터는 docs/portal-pages.md 기준)
            │    └─ auth/    SessionManager: SSO 로그인, 만료 감지, single-flight 재로그인 1회
            │         └─ http/    HttpClient: 쿠키 jar, 수동 리다이렉트, 문자셋 디코딩, 호스트 allowlist
            │              └─ queue/  RequestQueue: 전역 순차, 간격 ≥200ms, 타임아웃 15s, 재시도 1회
            ├─ parsers/  cheerio 기반 순수 함수 (문자열 → 도메인 객체), 화면별 파일
            ├─ store/    SnapshotStore: <category>.json + .md 최신본, history/<YYYY-MM-DD>/<category>.json
            └─ schema/   도메인 zod 스키마
config/  자격증명·경로 로더 (env → ~/.shingu-mcp/config.json), 비밀번호는 Secret 래퍼로만 보유
log/     stderr 전용 로거 + redact (stdout은 MCP 프로토콜 전용)
util/    KST 날짜 유틸 (외부 날짜 라이브러리 없음)
```

### 1.2 핵심 설계 결정

- **도구는 7개를 등록한다** (2026-10-26 정정): `get_assignments`, `get_timetable`, `get_courses`, `get_notices`, `get_notice`, `get_grades`, `refresh_snapshots` (조회 6 + 갱신 1). `get_attendance`는 정찰 결과 포털에 출석 화면이 없어 사용자 결정으로 v1 제외. 이 문서의 "8개"/"WI-6e"/"attendance" 언급은 모두 무효.
- **정찰 결과는 `docs/portal-pages.md`가 단일 진실.** 화면 URL·파라미터·셀렉터·제출 상태 판정 규칙·요청 수 추정이 거기 있다. WI-6/8/9는 이 문서를 기준으로 구현한다.
- **스냅샷은 필터 전 전체 데이터를 저장**하고, 도구 파라미터(`due_within_days`, `category`, `limit`, `semester`, `week`)는 live/snapshot 양쪽에 동일하게 응답 직전에 적용한다. 그래야 fallback 결과가 live와 같은 의미를 가진다.
- **스냅샷 범주(category):** `assignments`, `timetable`, `courses`, `notices`, `grades`. 공지 본문은 `notices/<id>.json`(+ history 동일 규칙)으로 별도 저장. `grades`는 학기별 성적 + 이수/총 학점을 함께 담는다.
- **fallback 조건:** 네트워크 오류·타임아웃·5xx·세션 재로그인 실패·파서 예외 → 스냅샷(`stale: true`, `source: "snapshot"`, 선택적 `warning`). **자격증명 누락/거부·중복 로그인 거부는 fallback하지 않고** AC-A4 에러를 그대로 반환(사용자가 조치해야 하므로).
- **자격증명 거부 회로 차단:** SSO가 비밀번호 오류를 반환하면 프로세스 생존 동안 재로그인하지 않고 같은 에러를 즉시 반환(계정 잠금 방지).
- **세션 만료 재로그인은 전송 재시도와 별개 계층.** 큐의 "재시도 1회"는 전송 실패(네트워크·타임아웃·5xx)용, 인증 계층의 "재로그인 1회"는 만료 감지용. 모든 실제 요청(리다이렉트 hop 포함)은 큐를 통과하므로 순차·간격이 깨지지 않는다.
- **SSO 자동 제출 폼 처리:** 포털은 `ssoRedFrm` 같은 JS 자동 제출 폼을 쓴다. HttpClient는 리다이렉트를 `redirect: "manual"`로 직접 따라가고(각 hop의 `Set-Cookie`를 jar에 저장), auth 계층은 응답 HTML에서 allowlist된 폼(id/action 호스트)을 cheerio로 읽어 hidden input을 그대로 POST한다. `location.href=` 형태의 JS 리다이렉트도 같은 계층에서 처리.
- **호스트 allowlist:** `https://student.shingu.ac.kr`, `https://login.shingu.ac.kr`만 요청 허용. 자격증명이 다른 호스트로 나가는 경로를 원천 차단.
- **로깅:** stderr 전용. 모든 로그·에러 메시지는 `redact()`를 통과(비밀번호 원문, `password=` 파라미터, `Cookie`/`Set-Cookie` 값, `jsessionid=` 마스킹).
- **설정 지연 로드:** 서버는 자격증명 없이도 기동하고, 첫 도구 호출에서 설정을 로드한다(없으면 AC-A4 에러를 도구 에러로 반환).

---

## 2. 기술 선택과 근거

| 항목 | 선택 | 근거 |
|---|---|---|
| 언어/런타임 | TypeScript(strict), Node ≥ 20 (`engines`) | 스펙 지정. Node 20+는 전역 `fetch`, `Headers.getSetCookie()`, `--env-file`, full-ICU `TextDecoder('euc-kr')` 제공 |
| 모듈 | ESM (`"type": "module"`, `module/moduleResolution: NodeNext`) | MCP SDK가 ESM 우선 |
| MCP | `@modelcontextprotocol/sdk` 최신 안정 | stdio transport, `registerTool`(zod input/output schema, `structuredContent`) |
| HTML 파싱 | `cheerio` 최신 안정 | 서버 렌더링 HTML(jQuery/Bootstrap 3) 테이블/리스트 파싱 |
| 스키마 | `zod` — **SDK가 요구하는 메이저 버전에 맞춤** | 설치 시 SDK의 zod 의존/peer 버전(v3 vs v4) 확인 후 같은 메이저로 고정 |
| 쿠키 | `tough-cookie` 최신 안정 | 두 서브도메인 간 Domain/Path/Secure 규칙을 수동 구현하지 않기 위해 |
| HTTP | Node 전역 `fetch` + `AbortController` | 추가 의존성 없음. `redirect: "manual"`로 hop별 쿠키 캡처 |
| 인코딩 | `Content-Type` charset → `<meta charset>` 순 감지 → `TextDecoder` | EUC-KR 가능성 대비. `iconv-lite`는 TextDecoder로 부족할 때만 추가 |
| 테스트 | `vitest` 최신 안정 (fake timers) | 큐 타이밍(AC-M3) 결정적 검증, 픽스처 파서 테스트 |
| 빌드 | `tsc` (번들러 없음) | 의존성 최소. 진입 파일 shebang 유지 → `bin` 등록 |
| 개발 스크립트 | `tsx` (devDependency) | 정찰·마스킹·스모크 스크립트를 빌드 없이 실행. `.env`는 `tsx --env-file=.env`로 로드(dotenv 불필요) |

모든 패키지는 "최신 안정"으로 설치하고 WI-0에서 `npm view <pkg> version`으로 확인한 뒤 `package-lock.json`을 커밋한다.

---

## 3. 단계별 작업 (Work Items)

### 의존 그래프

```
WI-0 ──┬── WI-1 ──┐
       ├── WI-2 ──┴── WI-3 ── WI-4 [사람 선행조건] ──┐
       └── WI-5 ──┬───────────────────────────────────┴── WI-6a..6e (상호 병렬) ──┐
                  └── WI-7 (WI-3·WI-4·WI-6과 병렬) ───────────────────────────────┤
                                                                                  WI-8 ── WI-9 ── WI-10 ── WI-11
```

병렬 묶음: {WI-1, WI-2, WI-5} → {WI-3, WI-7} → WI-4 → {WI-6a~6e} → WI-8 → WI-9 → WI-10 → WI-11.
WI-4가 사람 선행조건 때문에 대기하더라도 WI-5·WI-7은 진행 가능.

---

### WI-0 환경 확인 + 프로젝트 스캐폴드
- **목표:** 빌드·테스트가 도는 빈 프로젝트.
- **작업:**
  - `node -v`(≥20), `npm -v` 확인. 미달이면 중단하고 보고.
  - `npm view` 로 `@modelcontextprotocol/sdk`, `cheerio`, `zod`, `tough-cookie`, `vitest`, `typescript`, `tsx`, `@types/node` 최신 안정 버전 확인 후 설치. SDK의 zod 요구 메이저 확인.
  - 디렉터리: `src/{config,log,queue,http,auth,portal,parsers,schema,store,service,tools,util}`, `tests/{unit,integration,fixtures}`, `scripts/`, `docs/`, `examples/`.
  - `.githooks/commit-msg`(COMMIT.md 8장 그대로, LF) + `git config core.hooksPath .githooks`.
- **산출 파일:** `package.json`(`type: module`, `engines.node >=20`, `bin: { "shingu-mcp": "dist/index.js" }`, scripts: `build`, `test`, `typecheck`, `recon`, `mask`, `check:pii`, `smoke`), `package-lock.json`, `tsconfig.json`(strict, NodeNext, outDir `dist`), `vitest.config.ts`, `src/index.ts`(shebang + 빈 main), `.githooks/commit-msg`, `.gitattributes`(`.githooks/* text eol=lf`)
- **의존성:** 없음 · **병렬:** 단독(첫 단계)
- **검증:** `npm run build` 성공, `npm test`가 샘플 테스트 1개로 통과, `npm run typecheck` 무오류, `git status`에 `dist/`·`node_modules/` 미노출.
- **커밋:** `[Build] TypeScript MCP 프로젝트 스캐폴드 추가`
- **대응 AC:** 기반(직접 AC 없음), AC-E5(생성물 미커밋)

### WI-1 config 로더 + 로거(redact)
- **목표:** 자격증명·경로 결정과 비밀번호 비노출 보장.
- **작업:**
  - `loadConfig()`: `SHINGU_ID`와 `SHINGU_PW`가 **둘 다** 있으면 env 사용, 아니면 `~/.shingu-mcp/config.json`의 `id`/`password`(zod 검증). env가 하나만 있으면 파일로 보충하지 않고 명확한 에러(혼합 출처 혼란 방지).
  - 홈 경로: `os.homedir()` + `path.join` (Windows `C:\Users\<user>\.shingu-mcp`). 테스트용 `SHINGU_MCP_HOME` env로 루트 오버라이드.
  - 비밀번호는 `Secret` 클래스로 보관: `toString()`/`toJSON()`/`util.inspect.custom` → `"***"`. 원문은 `reveal()`로만 접근, `src/auth/`에서만 호출.
  - `ConfigError`: 메시지에 env 이름(`SHINGU_ID`, `SHINGU_PW`)과 설정 파일 실제 경로, JSON 예시(`{"id":"학번","password":"..."}`) 포함.
  - `log/logger.ts`: `process.stderr`만 사용, `redact()` 적용. 레벨은 `SHINGU_MCP_LOG`(기본 `info`).
- **산출 파일:** `src/config/config.ts`, `src/config/secret.ts`, `src/log/logger.ts`, `src/log/redact.ts`, `tests/unit/config.test.ts`, `tests/unit/redact.test.ts`
- **의존성:** WI-0 · **병렬:** WI-2, WI-5와 병렬
- **검증:** env 우선 / 파일 fallback / 둘 다 없음 / env 일부만 / 잘못된 JSON 케이스 테스트. 센티넬 비밀번호(`SENTINEL-PW-9f3a`)로 `JSON.stringify(config)`, `String(err)`, `util.inspect`, 로거 출력에 원문 없음 단언.
- **커밋:** `[Feat] 자격증명 설정 로더와 비밀번호 마스킹 로거 추가`
- **대응 AC:** AC-A1, AC-A4(설정 에러 메시지), AC-A5(일부)

### WI-2 HTTP 클라이언트 + 쿠키 jar + 요청 큐
- **목표:** 요청 예절을 구조적으로 강제하는 단일 통로.
- **작업:**
  - `RequestQueue`: 프로세스 전역 싱글턴, 동시 실행 1. 간격 규칙 — **이전 요청 완료 시각 + 200ms 이후(2026-10-26 500→200 변경)에 다음 요청 시작**(시작-시작 기준보다 엄격). 각 시도 `AbortController` 15,000ms 타임아웃. 재시도 대상은 네트워크 오류·타임아웃·5xx, **최대 1회**(총 2시도), 재시도도 간격 규칙 적용. 3xx·4xx는 재시도 안 함. 시계/sleep 주입 가능.
  - `HttpClient`: `fetch` 주입 가능(테스트), `redirect: "manual"`로 최대 10 hop 수동 추적, hop마다 `getSetCookie()` → `tough-cookie` jar 저장 및 요청 시 `Cookie` 헤더 부착, 호스트 allowlist 위반 시 예외, 일반 브라우저 `User-Agent` 고정, `get(url)` / `postForm(url, fields)`(`application/x-www-form-urlencoded`), 응답 바이트를 charset 감지 후 디코드해 `{ status, finalUrl, headers, text, redirectChain }` 반환. 리다이렉트 hop도 각각 큐의 1요청.
  - 에러 타입: `NetworkError`, `TimeoutError`, `HttpStatusError`, `HostNotAllowedError`.
- **산출 파일:** `src/queue/request-queue.ts`, `src/http/http-client.ts`, `src/http/cookie-jar.ts`, `src/http/decode.ts`, `src/http/errors.ts`, `tests/unit/request-queue.test.ts`, `tests/unit/http-client.test.ts`
- **의존성:** WI-0 (logger 연동은 WI-1 머지 후) · **병렬:** WI-1, WI-5와 병렬
- **검증 (vitest fake timers + 모의 fetch):**
  - 5개 동시 enqueue → 동시성 최대 1, 각 시작이 이전 완료 + 200ms 이후.
  - 15s 미응답 → `TimeoutError`, 정확히 1회 재시도, fetch 호출 수 = 2.
  - 5xx 1회 후 200 → 성공, 호출 수 2. 4xx → 호출 수 1.
  - 리다이렉트 체인에서 이전 hop 쿠키가 다음 hop에 실림, allowlist 밖 Location → 예외.
  - EUC-KR 바이트 응답이 한글로 올바르게 디코드.
- **커밋:** `[Feat] 순차 요청 큐와 쿠키 기반 HTTP 클라이언트 추가`
- **대응 AC:** AC-M3, AC-E3(자동 검증 부분)

### WI-3 SSO 로그인 흐름 + SessionManager
- **목표:** 스펙 Technical Context 체인 기반 로그인과 만료 시 1회 재로그인.
- **작업:**
  - 로그인 체인(초안): `GET https://student.shingu.ac.kr/dashboard/dashboard` → 302 `/notlogin/t` → HTML의 `ssoRedFrm`(hidden `loginType`, `param1~3`) 파싱 → `POST https://login.shingu.ac.kr/index` → 로그인 폼 `POST https://login.shingu.ac.kr/login`(`userId`, `password`, `idSaveCheck=N`, `isCapslock=N`) → 응답의 자동 제출 폼/리다이렉트를 따라 포털 복귀 → 포털 `JSESSIONID` 확인.
  - 단계별 URL·폼 id·필드명·성공/실패 판정을 `src/auth/sso-flow.ts` 상단 상수로 모음(WI-4에서 보정 용이).
  - 만료 감지 `isSessionExpired(res)`: `finalUrl`/`redirectChain`에 `/notlogin/` 포함, 또는 HTML에 `ssoRedFrm` 존재.
  - 자격증명 거부 감지: 로그인 POST 후 포털로 복귀하지 못하고 login 호스트에 머묾(+ 에러 문구) → `AuthRejectedError`(회로 차단 set). 메시지에 AC-A4 설정 안내, 비밀번호 미포함.
  - `SessionManager.request(fn)`: 세션 없으면 로그인 → `fn` → 만료면 재로그인 1회 → `fn` 재실행 → 또 만료면 `SessionExpiredError`. 로그인은 **single-flight**(동시 호출이 하나의 로그인 promise 공유).
  - 중복 로그인 분기 자리: 로그인 응답에 중복 로그인 확인 폼/문구가 있으면 처리. 구현 방식은 WI-4 판정으로 확정(확인형 → 자동 확인 POST, 거부형 → `DuplicateLoginRejectedError`).
- **산출 파일:** `src/auth/sso-flow.ts`, `src/auth/session-manager.ts`, `src/auth/forms.ts`(자동 제출 폼·JS 리다이렉트 추출), `src/auth/errors.ts`, `tests/unit/session-manager.test.ts`, `tests/unit/sso-flow.test.ts`
- **의존성:** WI-1, WI-2 · **병렬:** WI-7과 병렬
- **검증 (모의 fetch):** (1) 정상 체인 → 세션 획득, 두 번째 호출은 로그인 없이 재사용, (2) 만료 1회 → 재로그인 후 성공, (3) 연속 만료 → 에러, (4) 거부 → `AuthRejectedError`, 재호출 시 로그인 fetch 0회, (5) 동시 3호출 → 로그인 1회, (6) 모든 경로에서 센티넬 비밀번호가 에러·로그에 없음.
- **커밋:** `[Feat] SSO 자동 로그인과 세션 재로그인 처리 추가`
- **대응 AC:** AC-A2, AC-A3, AC-A4, AC-A5(일부)

### WI-4 포털 정찰(reconnaissance) + PII 마스킹 픽스처
- **선행 조건 (사람): 사용자가 저장소 루트 `.env`에 실계정 `SHINGU_ID`/`SHINGU_PW`를 넣고 "자격증명 준비 완료"를 알림.** 미충족 시 이 WI와 후속 WI-6·WI-8은 대기, WI-5·WI-7은 계속 진행. 실행자는 `.env` 값을 출력·로그·대화에 노출하지 않는다.
- **목표:** 각 화면의 실제 URL·메서드·파라미터·HTML(또는 AJAX JSON) 구조를 확보하고 로그인 흐름을 실측으로 보정.
- **작업:**
  1. `scripts/recon-login.ts`: WI-3 모듈로 로그인하며 hop별 상태코드·호스트·경로·폼 id·필드 **이름**만 기록(값 미기록). 결과로 `sso-flow.ts` 상수 보정.
  2. 중복 로그인 실측: 같은 계정으로 로그인 A(별도 jar) → 로그인 B → A 세션으로 대시보드 요청. "강제 종료형 / 거부형 / 확인형" 판정을 `docs/portal-pages.md`에 기록, WI-3 분기 확정.
  3. 자격증명 오류 응답 실측은 **잘못된 비밀번호 1회만**(잠금 위험) → 거부 판정 기준 확정.
  4. `scripts/recon.ts`: 대시보드·메뉴 HTML에서 과제 / 시간표·수강과목 / 담당교수 / 공지(목록·본문) / 성적·이수학점 / 출석 화면을 찾아 요청. 데이터가 jQuery AJAX로 로드되면 해당 XHR 엔드포인트(JSON/HTML 조각)를 수집. 모든 요청은 큐 경유, 화면당 수 회 이내.
  5. 원본 저장: `tests/fixtures/raw/<screen>.html|json` (gitignore됨).
  6. `scripts/mask-fixture.ts`: raw → `tests/fixtures/<screen>.html|json`. 결과물 육안 검토.
  7. `docs/portal-pages.md`: 화면별 {메뉴 경로, URL, 메서드, 필수 파라미터(학기 코드 형식 등), 응답 형식(HTML/JSON), 데이터 셀렉터/필드, 페이지네이션, 빈 상태 표현, 문자셋}, 로그인 체인, 중복 로그인 판정, 첫 호출 hop 수. 개인 값 미기재.
- **마스킹 규칙 (`mask-fixture.ts`에 표로 구현, 위에서부터 적용):**

  | 대상 | 치환 |
  |---|---|
  | 비밀번호 문자열 | 발견 시 스크립트 실패(exit 1), 출력 파일 미생성 |
  | 학번(`.env`의 `SHINGU_ID` 값 + `\b20\d{6,8}\b` 패턴) | `20000000` |
  | 학생 본인 이름(스크립트 인자로 전달) | `홍길동` |
  | 교수 이름 | `김교수`, `이교수`, … (등장 순서대로 일관 치환) |
  | 전화번호(`0\d{1,2}-?\d{3,4}-?\d{4}`) | `010-0000-0000` |
  | 이메일 | `user@example.com` |
  | 연구실 호실 | 형식 유지, 숫자 → `000` |
  | 성적 등급(A+~F, P/NP) | 과목 순서대로 `A0`,`B+`,`B0`,… 고정 순환(구조 유지, 실제값 아님) |
  | 점수·평점·석차 | 고정값(점수 `90`, 평점 `3.5`, 석차 `1/1`) |
  | 출석/지각/결석 횟수 | 고정값 `10`/`1`/`0` |
  | 이수/총 학점 | `60`/`130` |
  | 생년월일·주소·주민번호 형태 | `2000-01-01`, `서울시 OO구`, 제거 |
  | hidden input 값·CSRF 토큰·`jsessionid=`·쿠키·`param1~3` 값 | `MASKED` |
  | 과목명·공지 제목/본문 | 유지(공개 정보). 단 본문 내 개인 연락처는 위 규칙 적용 |

- **산출 파일:** `scripts/recon-login.ts`, `scripts/recon.ts`, `scripts/mask-fixture.ts`, `scripts/check-pii.ts`, `docs/portal-pages.md`, `tests/fixtures/*.html|json`(마스킹본), `tests/fixtures/README.md`(마스킹 규칙 요약), `src/auth/sso-flow.ts` 보정
- **의존성:** WI-3 + 사람 선행 조건 · **병렬:** 내부는 직렬(포털 예절). WI-5·WI-7과는 병렬
- **검증:** `npm run check:pii` — `.env`가 있으면 `SHINGU_ID`·`SHINGU_PW` 값과 인자로 받은 실명이 `git ls-files` 대상 및 `tests/fixtures/`(raw 제외)에 없음, `git check-ignore tests/fixtures/raw/x` 성공. `docs/portal-pages.md`에 6개 화면군 + 로그인 체인 + 중복 로그인 판정 기재.
- **커밋:** `[Docs] 포털 화면 정찰 결과 문서 추가`, `[Test] PII 마스킹 포털 픽스처 추가`, (보정 시) `[Fix] 실측 기반 SSO 로그인 체인 보정`
- **대응 AC:** AC-S5(픽스처), AC-A3(만료 판정 실측), AC-A5(픽스처 비노출), AC-E5

### WI-5 도메인 스키마 + 파서 공통 유틸
- **목표:** 파서·스토어·도구가 공유하는 단일 진실 스키마.
- **작업:** 스펙 온톨로지 기준 zod 스키마:
  - `Assignment{courseName, title, dueAt(ISO +09:00 | null), submitStatus("submitted"|"not_submitted"|"late"|"unknown"), rawStatus}`
  - `TimetableEntry{day(1-7), periods[], startTime?, endTime?, courseName, room, professorName}`
  - `Course{courseName, courseCode?, semester, credits?, professor{name, office?, phone?, email?}}`
  - `NoticeSummary{id, category, title, postedAt}`, `NoticeDetail{...NoticeSummary, body, attachments[]}`
  - `GradeRecord{semester, courseName, credits, grade, score?}`, `CreditSummary{earned, required, bySemester[]}`
  - ~~`Attendance`~~ 제외(2026-10-26). `Assignment`에는 `courseName, title, startAt?, dueAt, extendedDueAt?, submitStatus("submitted"|"not_submitted"|"not_open"|"unknown"), submittedCount?, totalCount?, reportSeq, lectureSeq, detailUrl` 를 둔다(docs/portal-pages.md §3.4 판정 규칙).
  - 응답 메타 `Meta{fetchedAt, stale, source:"live"|"snapshot", warning?}`
  - 공통 유틸: KST 날짜 파싱(`"2026.10.30 23:59"`, `"2026-10-30"` 등 → ISO `+09:00`), 텍스트 정규화(공백·`&nbsp;`), 테이블 → 행 배열 헬퍼, `ParseError`(화면명·셀렉터 포함).
- **산출 파일:** `src/schema/*.ts`, `src/util/time.ts`, `src/parsers/common.ts`, `tests/unit/time.test.ts`, `tests/unit/parsers-common.test.ts`
- **의존성:** WI-0 · **병렬:** WI-1, WI-2와 병렬. WI-4 이후 필드 보정은 선택 필드 추가 수준으로 제한
- **검증:** 스키마 parse 성공/실패 테스트, 날짜 파서가 KST 오프셋을 정확히 붙임(자정·연말 경계 포함).
- **커밋:** `[Feat] 포털 도메인 스키마와 파서 공통 유틸 추가`
- **대응 AC:** AC-M2(스키마 기반)

### WI-6a~6e 화면별 파서 (상호 병렬)
- 공통: 입력은 디코드된 문자열(HTML 또는 JSON), 출력은 WI-5 스키마 `parse()`를 통과한 객체. 필수 셀렉터 미발견 시 `ParseError`. 빈 상태 픽스처가 있으면 빈 배열 반환 테스트 포함. 테스트는 `tests/fixtures/`만 사용(네트워크 없음). 기대값은 픽스처를 읽고 손으로 작성(파서 출력 복사 금지).

| id | 파서 | 산출 파일 | 대응 AC |
|---|---|---|---|
| WI-6a | 과제 목록 (과목명·제목·마감일시·제출상태) | `src/parsers/assignments.ts`, `tests/unit/parsers/assignments.test.ts` | AC-S1, AC-S5 |
| WI-6b | 시간표·수강과목·담당교수 (요일/교시·강의실·교수 이름·연구실/연락처 중 노출 항목) | `src/parsers/timetable.ts`, `src/parsers/courses.ts`, 테스트 2개 | AC-S2, AC-S5 |
| WI-6c | 공지 목록(카테고리·제목·게시일·id) + 공지 본문 | `src/parsers/notices.ts`, 테스트 | AC-S3, AC-S5 |
| WI-6d | 학기별 성적 요약(SSJ019P) + 이수학점(SSG005P) + 현재 학기 과목 성적 상태(SSJ018P) | `src/parsers/grades.ts`, 테스트 | AC-S4, AC-S5 |
| ~~WI-6e~~ | ~~출석~~ — 포털 미노출로 제외(2026-10-26) | – | – |

- **WI-4 상태(2026-10-26): 리더가 완료.** 로그인 체인 실측·중복 로그인 판정·화면 URL/셀렉터는 `docs/portal-pages.md`, 마스킹 픽스처 22개는 `tests/fixtures/`(규칙·목록은 `tests/fixtures/README.md`), 마스킹 스크립트는 `scripts/mask-fixture.mjs`(tsx 없이 node로 실행; `--check`가 check:pii 역할 — 실명은 `MASK_STUDENT_NAME`/`MASK_PROFESSORS` env로 전달). 원본은 `tests/fixtures/raw/`(gitignore). WI-6은 이 픽스처를 입력으로 바로 시작할 수 있다.

- **의존성:** WI-4(픽스처·구조), WI-5 · **병렬:** 5개 모두 병렬
- **검증:** 각 테스트가 마스킹 픽스처에서 기대값(`홍길동`/`20000000`/고정 성적 기준)으로 통과.
- **커밋:** 1파서 1커밋, 예: `[Feat] 과제 화면 파서 추가`

### WI-7 스냅샷 스토어
- **목표:** 최신본 + 날짜별 이력 + fallback 읽기.
- **작업:** `SnapshotStore(root = <home>/snapshots)`:
  - `write(category, data, fetchedAt)` → `<category>.json`(`{category, fetchedAt, data}`) + `<category>.md`(범주별 Markdown 렌더러: 표/목록) 최신본 덮어쓰기, `history/<YYYY-MM-DD>/<category>.json` 덮어쓰기(날짜는 **KST 기준**).
  - `read(category)` → 없으면 `null`.
  - 원자적 쓰기(같은 디렉터리 임시 파일 → `rename`, Windows EPERM/EBUSY 시 짧은 대기 후 1회 재시도). 디렉터리 자동 생성. UTF-8, LF.
  - 공지 본문은 `notices/<id>.json` + history 동일 규칙. id는 `[A-Za-z0-9_-]+`만 허용(경로 조작 방지).
- **산출 파일:** `src/store/snapshot-store.ts`, `src/store/markdown.ts`, `tests/unit/snapshot-store.test.ts`
- **의존성:** WI-5 · **병렬:** WI-3, WI-4, WI-6과 병렬
- **검증:** 임시 디렉터리(`SHINGU_MCP_HOME`)에서 쓰기 → 최신본·이력 경로 존재, 같은 날 재쓰기 덮어쓰기, 다른 날(시계 주입) 별도 폴더, UTC 15:00 이후(KST 다음 날) 날짜 폴더가 KST 기준, md 한글 정상, 잘못된 notice id 거부.
- **커밋:** `[Feat] 범주별 스냅샷 저장소와 날짜별 이력 추가`
- **대응 AC:** AC-F1, AC-F2, AC-F3(읽기 부분)

### WI-8 포털 화면 fetch + category service
- **목표:** "live 수집 → 파싱 → 스냅샷 → 실패 시 stale" 파이프라인을 범주별로 완성.
- **작업:**
  - `src/portal/*.ts`: `docs/portal-pages.md` 기준 화면별 함수(`fetchAssignmentsPage()` 등). 모두 `SessionManager.request()` 경유. 학기 코드 등 파라미터 계산 포함.
  - `src/service/category-service.ts`: `getCategory(category)` → live 성공 시 스냅샷 write 후 `{data, meta:{fetchedAt, stale:false, source:"live"}}`; fallback 대상 오류면 스냅샷 read → `{data, meta:{fetchedAt:<스냅샷 값>, stale:true, source:"snapshot", warning}}`; 스냅샷 없음 → 원 오류 기반 에러; `ConfigError`/`AuthRejectedError`/`DuplicateLoginRejectedError` → fallback 없이 에러. `getNotice(id)`도 동일 규칙.
  - `refreshAll()`: 6개 범주를 **순차** 수집, 범주별 `{category, ok, fetchedAt?, error?}` 요약(공지 본문은 미포함).
- **산출 파일:** `src/portal/{assignments,timetable,courses,notices,grades,attendance}.ts`, `src/service/category-service.ts`, `tests/unit/category-service.test.ts`
- **의존성:** WI-3, WI-4, WI-6a~e, WI-7 · **병렬:** 화면별 portal 함수는 병렬 작성 가능, service는 단일
- **검증 (모의 fetch + 마스킹 픽스처 응답):** (1) live 성공 → 스냅샷 생성·`source:"live"`, (2) fetch가 `ECONNREFUSED` throw → `stale:true` + 스냅샷의 `fetchedAt`, (3) 스냅샷 없음 + 실패 → 에러, (4) 자격증명 거부 → fallback 안 함, (5) `refreshAll` 일부 실패 시 요약에 성공/실패 혼재, (6) 스냅샷 파일 어디에도 센티넬 비밀번호 없음.
- **커밋:** `[Feat] 포털 화면 수집과 스냅샷 fallback 서비스 추가`
- **대응 AC:** AC-F1, AC-F3, AC-F4, AC-A5(스냅샷), AC-E4(자동 검증 부분)

### WI-9 MCP 도구 8개 + stdio 서버 조립
- **목표:** Claude Code가 호출 가능한 서버.
- **작업:**
  - `McpServer` + `StdioServerTransport`. 각 도구 `registerTool(name, {title, description, inputSchema, outputSchema}, handler)`; 응답은 `structuredContent`(outputSchema 일치) + `content:[{type:"text", text:<JSON>}]`.
  - 입력 스키마:
    - `get_assignments({ due_within_days?: int 0..365 })` — 지정 시 `now ≤ dueAt ≤ now + N일`(KST), 미지정 시 전체. `dueAt`이 null인 항목은 지정 시 제외. 동작을 설명에 명시.
    - `get_timetable({ week?: "YYYY-MM-DD" })` — 해당 날짜가 속한 주(월~일)의 요일별 항목에 실제 날짜를 붙여 반환. 기본 이번 주(KST). 포털 시간표가 학기 고정이면 날짜 라벨만 달라짐을 설명에 명시.
    - `get_courses({ include_contacts?: boolean = true })`, `refresh_snapshots({})` (`get_attendance` 제외)
    - `get_notices({ category?: string, limit?: int 1..100 = 20 })`, `get_notice({ id: string })`
    - `get_grades({ semester?: string })` — 형식(예: `2026-2`)은 WI-4 결과로 확정, 설명에 예시 노출.
  - 출력: 조회 도구는 `{ <data>, fetchedAt, stale, source, warning? }`. `refresh_snapshots`는 `{ results:[...], fetchedAt }`.
  - 에러는 `isError: true` 도구 결과로, 메시지는 `redact()` 통과 + 사용자 행동 안내(AC-A4).
  - 도구 설명은 한국어 1~2문장 + 출처(신구대 학생종합포털) 명시. `get_assignments` 설명에 "이번 주 과제/마감 질문에 사용" 문구.
  - 설정은 첫 도구 호출 시 지연 로드.
- **산출 파일:** `src/tools/*.ts`(도구별 1파일), `src/tools/index.ts`, `src/server.ts`, `src/index.ts`, `tests/unit/tools.test.ts`, `tests/integration/server.test.ts`
- **의존성:** WI-8 · **병렬:** 도구별 파일 병렬 작성 가능
- **검증:** (1) SDK `Client` + in-memory transport로 `listTools` → 8개 이름과 inputSchema 노출, (2) 모의 서비스로 각 도구 호출 → outputSchema 검증 통과 + 메타 3필드 존재, (3) 필터(`due_within_days`, `limit`, `category`, `semester`, `week`) 단위 테스트, (4) 자격증명 없음 → `isError` + env명·경로 포함 + 비밀번호 미포함, (5) `node dist/index.js`를 stdio로 띄워 `initialize`→`tools/list` 왕복 성공, stdout에 JSON-RPC 외 출력 없음, (6) `src/`에 `console.log` 없음(grep).
- **커밋:** `[Feat] 포털 조회 MCP 도구와 stdio 서버 추가`
- **대응 AC:** AC-M1, AC-M2, AC-M4, AC-A4, AC-F4

### WI-10 `.mcp.json` 예시 + README
- **목표:** 다른 학생이 설치해 쓸 수 있는 문서.
- **작업:**
  - `examples/mcp.json`(루트 `.mcp.json`은 경로가 사용자마다 달라 커밋하지 않음): 로컬 빌드 형태 `{"mcpServers":{"shingu":{"command":"node","args":["<절대경로>/dist/index.js"]}}}` 와 GitHub 직접 실행 형태 `npx -y github:<owner>/<repo>`(package.json `prepare`에서 빌드). `claude mcp add shingu -- node <절대경로>/dist/index.js` 예시.
  - `README.md`: 소개/범위(읽기 전용, LMS 미포함), 요구사항(Node ≥20), 설치(`git clone` → `npm ci` → `npm run build`), 자격증명 설정(우선순위 env → `~/.shingu-mcp/config.json`, Windows 경로 예시 `C:\Users\<사용자>\.shingu-mcp\config.json`, `.mcp.json`에 비밀번호를 넣어 커밋하지 말 것), **"Claude가 포털을 조회하면 브라우저의 포털 로그인이 풀릴 수 있다" 주의**(WI-4 판정 반영), 도구 목록 표, 스냅샷 위치 및 성적·출석 등 민감정보 포함 경고, 요청 예절 정책, 문제 해결(자격증명 오류, 잠금 주의, `stale` 의미), 개발자용(정찰·마스킹·`check:pii`).
- **산출 파일:** `README.md`, `examples/mcp.json`, `package.json`(`prepare`, `files`)
- **의존성:** WI-9 · **병렬:** 단독
- **검증:** README에 AC-A6 문구·설치·자격증명 3요소 존재(grep). 임시 디렉터리에 clone → 문서 절차만으로 `npm ci && npm run build` 성공 및 `claude mcp add`로 등록 후 `claude mcp list`에 표시.
- **커밋:** `[Docs] 설치·자격증명·세션 주의 README 작성`
- **대응 AC:** AC-M5, AC-A6, AC-E5

### WI-11 E2E 수동 검증 + 커밋 위생 점검
- **선행 조건 (사람):** 실계정 자격증명, Claude Code 세션, 네트워크 차단 가능 환경.
- **산출 파일:** `docs/e2e-checklist.md`(체크리스트 + 실행 기록: 날짜, 소요 시간, 결과. 개인 값 미기재), `scripts/smoke.ts`(SDK Client로 8개 도구 순차 호출·outputSchema 검증)
- **체크리스트:**
  - [ ] **AC-E1:** 빌드 → `claude mcp add` 등록 → 새 Claude Code 세션에서 "이번 주 과제 뭐 있어?" → 실제 과목·제목·마감·제출상태로 응답. stderr 로그의 첫 도구 호출 시작~응답 완료 ≤ 15초 기록.
  - [ ] **AC-E2:** `npm run smoke`(실계정) → 8개 도구 모두 `isError` 없음 + outputSchema 통과(`get_notice`는 `get_notices` 결과 id 사용). `npm test` 전체 통과.
  - [ ] **AC-E3:** `SHINGU_MCP_LOG=debug`로 `refresh_snapshots` 실행 → 로그의 요청 시작/종료 타임스탬프로 동시성 1·간격 ≥200ms 확인. 큐 단위 테스트(15s 타임아웃·재시도 1회) 통과 확인.
  - [ ] **AC-E4:** live 호출로 스냅샷 생성 → Wi-Fi/이더넷 비활성화 → 같은 도구 호출 → `stale: true`, `source: "snapshot"`, 이전 `fetchedAt` 확인 → 스냅샷 폴더를 임시로 옮긴 뒤 재호출 → 에러 확인 → 원복·네트워크 복구.
  - [ ] **AC-E5:** README 3요소 확인. `npm run check:pii` 통과. `.env` 값과 실명이 `git log -p --all` 출력에 없음(스크립트로 `.env` 값을 읽어 `grep -F` 검사, 값 자체는 출력하지 않음). `git ls-files`에 `.env`·`dist/`·`node_modules/`·`tests/fixtures/raw/` 없음. `git log --format=%B | grep -Ei 'claude|anthropic|generated with'` 결과 0건, 모든 제목이 `[Type] 한국어` 형식.
- **의존성:** WI-10 · **병렬:** 불가
- **커밋:** `[Test] E2E 검증 체크리스트와 스모크 스크립트 추가`
- **대응 AC:** AC-E1~E5

---

## 4. 리스크 & 대응

| 리스크 | 징후 | 대응 |
|---|---|---|
| SSO에 CAPTCHA/OTP 추가 | 로그인 응답에 captcha/otp 필드·이미지 | 자동 로그인 불가 → `AuthUnsupportedError`("포털이 추가 인증을 요구함") 반환, 기존 스냅샷 fallback만 제공. 브라우저 자동화는 Non-Goal이므로 v1에서 우회하지 않고 리더에게 보고 |
| 중복 로그인이 **거부형** | 로그인 B에서 "이미 로그인됨" 거부 | 확인형(강제 로그인 옵션 존재)이면 자동 확인 POST. 순수 거부형이면 `DuplicateLoginRejectedError`("브라우저에서 포털 로그아웃 후 다시 시도") + README 반영, AC-A3 재로그인은 "거부 시 재시도 안 함"으로 보정. AC-A6 문구가 실제 동작과 달라지면 리더에게 보고 후 표현 조정 |
| 중복 로그인이 **강제 종료형**(예상 기본) | 브라우저 세션 끊김 | 스펙대로 감수, README 명시. MCP는 세션 재사용으로 로그인 횟수 최소화 |
| 계정 잠금 | 잘못된 비밀번호 반복 | 거부 회로 차단(프로세스당 1회만 시도), 정찰 시 오입력 실측 1회 제한 |
| 화면 데이터가 AJAX/JSON | HTML에 빈 테이블 + XHR | WI-4에서 XHR 엔드포인트 수집, 파서 입력을 문자열(HTML/JSON 공통)로 설계 |
| 포털 화면 변경 | `ParseError` | 픽스처 테스트로 조기 감지, 런타임엔 stale fallback + `warning`에 화면명 |
| 학기 코드·파라미터가 화면마다 다름 | 빈 결과 | `docs/portal-pages.md`에 화면별 파라미터 기록, portal 함수에서 계산 |
| Windows 경로/홈 디렉터리 | `~` 미확장, 역슬래시, rename 잠금 | `os.homedir()` + `path.join`만 사용, 파일명에 `:` 금지(fetchedAt은 파일 내용에만), 원자적 rename EPERM/EBUSY 시 1회 재시도, `.gitattributes`로 hook LF 고정 |
| 한글 인코딩 | 깨진 글자 | charset 감지 → `TextDecoder`, 픽스처는 UTF-8로 저장하고 원 charset을 문서화, EUC-KR 디코드 테스트 |
| stdout 오염 | Claude Code가 서버 응답 파싱 실패 | 로거 stderr 고정, `console.log` 금지(WI-9 grep 검증) |
| 첫 호출 15초 초과 | 로그인 hop 수 × (지연 + 200ms) | WI-4에서 hop 수 실측·기록, 체인 최소화(불필요한 대시보드 GET 생략 등), 첫 호출에 요청 화면 외 추가 요청 금지 |
| PII 커밋 사고 | 픽스처/문서에 실명·학번 | raw는 gitignore, `check:pii`, 마스킹 결과 육안 검토, WI-11 히스토리 검사 |
| MCP SDK/zod 버전 불일치 | 타입 오류·스키마 변환 실패 | WI-0에서 SDK의 zod 요구 메이저 확인 후 고정 |

---

## 5. AC 추적 매트릭스

| AC | 구현 WI | 검증 |
|---|---|---|
| AC-A1 | WI-1 | WI-1 테스트 |
| AC-A2 | WI-3 | WI-3 테스트, WI-11(E1) |
| AC-A3 | WI-3 (WI-4 실측 보정) | WI-3 테스트 |
| AC-A4 | WI-1, WI-3, WI-9 | WI-1·WI-3·WI-9 테스트 |
| AC-A5 | WI-1, WI-3, WI-4(마스킹), WI-8 | 센티넬 테스트(WI-1/3/8/9), `check:pii`(WI-4/11) |
| AC-A6 | WI-10 | WI-10 grep, WI-11(E5) |
| AC-S1 | WI-6a | WI-6a 테스트 |
| AC-S2 | WI-6b | WI-6b 테스트 |
| AC-S3 | WI-6c | WI-6c 테스트 |
| AC-S4 | WI-6d, WI-6e | 해당 테스트 |
| AC-S5 | WI-4, WI-6a~e | 파서 테스트 + `check:pii` |
| AC-F1 | WI-7, WI-8 | WI-7·WI-8 테스트 |
| AC-F2 | WI-7 | WI-7 테스트 |
| AC-F3 | WI-7, WI-8 | WI-8 테스트, WI-11(E4) |
| AC-F4 | WI-8, WI-9 | WI-8·WI-9 테스트 |
| AC-M1 | WI-9 | WI-9 `listTools` 테스트 |
| AC-M2 | WI-5, WI-9 | WI-9 테스트 |
| AC-M3 | WI-2 | WI-2 fake-timer 테스트 |
| AC-M4 | WI-8, WI-9 | WI-9 테스트 |
| AC-M5 | WI-10 | WI-10 clone·등록 확인, WI-11(E1) |
| AC-E1 | WI-3, WI-6a, WI-8, WI-9, WI-10 | WI-11 |
| AC-E2 | 전체 | WI-11 (`npm run smoke` + `npm test`) |
| AC-E3 | WI-2 | WI-2 테스트 + WI-11 로그 확인 |
| AC-E4 | WI-7, WI-8 | WI-8 테스트 + WI-11 네트워크 차단 |
| AC-E5 | WI-0(gitignore), WI-4, WI-10 | WI-11 |

---

## 6. 가드레일

**Must Have**
- 모든 포털 요청은 `RequestQueue` 단일 경로 통과(`src/http/` 밖에서 `fetch` 직접 호출 금지 — grep 검증).
- 비밀번호는 `Secret`으로만 이동, `reveal()` 호출은 `src/auth/`에만 존재.
- 파서는 순수 함수, 네트워크 없는 픽스처 테스트.
- 커밋은 WI(파서는 파서별)당 1논리 단위, 커밋마다 `npm test` 통과, COMMIT.md 형식, AI 표기·trailer 없음, lock 파일 커밋.

**Must NOT Have**
- Playwright/Puppeteer, DB, HTTP/SSE 서버, 백그라운드 폴링/크론.
- 포털 쓰기 요청(로그인·조회 파라미터용 POST 외 금지), LMS(`lms.shingu.ac.kr`) 요청.
- 하드코딩된 계정·이름·학번, `console.log`(stdout), 비마스킹 픽스처 커밋.
- `test.skip`/`.only`/스텁 테스트/TODO 자리표시.
- 플러그인 마켓플레이스 패키징(연기된 구성요소), OS 보안 저장소 연동.

---

## 7. 완료 정의 (스펙 AC-E1~E5 그대로)

- [ ] AC-E1: Claude Code에 MCP를 등록하고 "이번 주 과제 뭐 있어?"라고 물으면 **실제 포털 데이터**로 과목·제목·마감·제출상태를 답한다(첫 호출 로그인 포함 15초 이내).
- [ ] AC-E2: 7개 도구 전부가 실계정에서 에러 없이 스키마에 맞는 JSON을 반환하고, 모든 파서 픽스처 테스트가 통과한다.
- [ ] AC-E3: 포털 요청 예절(순차, ≥200ms, 15초 타임아웃, 재시도 1회)이 지켜진다.
- [ ] AC-E4: 포털 장애 상황(네트워크 차단 시뮬레이션)에서 최신 스냅샷으로 `stale: true` 응답이 나온다.
- [ ] AC-E5: README에 설치·자격증명 설정·브라우저 세션 끊김 주의가 있고, 저장소 커밋에 자격증명·비마스킹 개인정보가 없다.

(AC-E2의 "7개 도구"는 1.2절 결정에 따라 AC-M1에 나열된 8개 이름 전부로 검증한다.)

---

## 8. 자체 점검 기록 (Critic 관점 1회)

| 점검 | 발견 | 보정 |
|---|---|---|
| 누락 AC | AC-M1 "7개" vs 나열 8개 이름 불일치 | 1.2절에 "나열된 8개 전부 구현" 결정 명시, 완료 정의에 주석 |
| 누락 AC | AC-A5의 스냅샷 비노출 검증 위치가 모호 | 센티넬 검사를 실제 데이터 경로가 있는 WI-8 테스트에 배치 |
| 누락 AC | AC-M5 검증이 E2E에만 의존 | WI-10에 clone → 빌드 → `claude mcp add` 확인 추가 |
| 순서 오류 | WI-3(로그인)과 WI-4(실측) 순환 의존 | WI-3은 모의 fetch로 완결, WI-4가 상수 보정(`[Fix]` 커밋)하도록 분리 |
| 순서 오류 | 자격증명 대기 시 전체 정지 위험 | WI-5·WI-7을 WI-4와 독립으로 두어 대기 중 진행 가능 |
| 순서 오류 | 스모크 스크립트가 WI-11에서야 등장 | `package.json` scripts 목록에 `smoke`를 WI-0에서 예약, 구현은 WI-11 |
| 과한 범위 | 네트워크 장애 시뮬레이션용 디버그 플래그를 서버 코드에 넣는 안 | 제외 — 자동 검증은 모의 fetch(WI-8), 수동은 실제 네트워크 차단(WI-11) |
| 과한 범위 | `iconv-lite`, `dotenv`, 날짜 라이브러리 | 제외 — `TextDecoder`, `--env-file`, 자체 KST 유틸로 충분. 필요성 확인 시에만 추가 |
| 위험 | 정찰 중 계정 잠금 | 오입력 실측 1회 제한 + 런타임 회로 차단 |
| 위험 | stdout 오염으로 MCP 파손 | WI-9 검증에 stdio 왕복·`console.log` grep 추가 |
