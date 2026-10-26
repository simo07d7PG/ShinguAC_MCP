# 포털 화면 정찰 결과 (WI-4)

- 대상: 신구대학교 학생종합포털 `https://student.shingu.ac.kr` (+ SSO `https://login.shingu.ac.kr`)
- 정찰일: 2026-10-26 (2026학년도 2학기, 학생 계정)
- 기술 특성: Apache + Tomcat(`JSESSIONID`), jQuery 1.12 / Bootstrap 3 **서버 렌더링**(HTML에 데이터가 들어 있음), 벤더 JS `poizn.*.js`. 응답 charset은 모두 `text/html;charset=UTF-8`.
- 원본 HTML: `tests/fixtures/raw/` (gitignore). 마스킹 픽스처: `tests/fixtures/`.
- 이 문서에는 개인 값(학번·이름·성적·연락처)을 적지 않는다.

## 1. 로그인 체인 (실측)

| # | 요청 | 응답 | 비고 |
|---|---|---|---|
| 1 | `GET https://student.shingu.ac.kr/dashboard/dashboard` | `302 → /notlogin/t` | 포털 `WMONID`, `JSESSIONID` 쿠키 발급 |
| 2 | `GET https://student.shingu.ac.kr/notlogin/t` | `200` | HTML에 `form#ssoRedFrm` (`method=post action=https://login.shingu.ac.kr/index`, hidden `loginType`, `param1`, `param2`, `param3` — 모두 빈 값). **주석 처리된 테스트 SSO 폼(`testsso.shingu.ac.kr:8070`)이 같은 HTML에 있으므로 주석을 제거한 뒤 파싱해야 한다.** |
| 3 | `POST https://login.shingu.ac.kr/index` (ssoRedFrm 필드) | `200` | 로그인 페이지. `form[name=loginFrm] action=/login method=POST`, 필드 `userId`, `password`, `idSaveCheck`(체크박스, 생략 가능), `isCapslock`(hidden, 빈 값). 평문 전송(클라이언트 암호화 없음), CAPTCHA/OTP 없음. |
| 4 | `POST https://login.shingu.ac.kr/login` (`userId`, `password`, `isCapslock=`) | `302 → /login/userDiv` | 성공 시 `Set-Cookie: access_token`, `refresh_token`, `JSESSIONID`, `UniCookie_*` 가 **`Domain=shingu.ac.kr`** 로 발급됨(모든 서브도메인 공유). |
| 5 | `GET https://login.shingu.ac.kr/login/userDiv` | `200` | 인라인 JS: `var userGb = "2"`(학생), `returnUrl`, `loginType`, `param1~3`(모두 빈 값). `userGb == '2'`면 `form#ssoLoginFrm`을 `action=https://student.shingu.ac.kr/ssoLogin` 으로 자동 POST. 필드: `ReturnUrl`, `userId`(빈 값), `password`(빈 값), `_method`, `loginType`, `param1`, `param2`, `param3`. 다른 `userGb`(교직원 등)는 `gate.shingu.ac.kr`/`gw.shingu.ac.kr`로 보내므로 **학생이 아니면 지원하지 않음**을 에러로 알린다. |
| 6 | `POST https://student.shingu.ac.kr/ssoLogin` (위 필드) | `302 → /dashboard/dashboard` | 포털이 `access_token` 쿠키(Domain=shingu.ac.kr)로 로그인 처리. 쿠키 jar가 **Domain 속성을 반영**해야 성공한다(호스트별 저장만 하면 `/notlogin/t`로 되돌아감). |
| 7 | `GET https://student.shingu.ac.kr/dashboard/dashboard` | `200` (약 68KB) | 로그인 완료. |

- 총 hop: 7요청. **실측(2026-10-26, 구현 모듈 `scripts/recon-login.ts`): 로그인 포함 첫 대시보드 응답 4.8초, 세션 재사용 시 0.7초.**
- **세션 만료 판정:** 응답 최종 URL에 `/notlogin/` 포함 또는 HTML에 `id="ssoRedFrm"` 존재. 만료 페이지 JS: `duplicateLogin`, `returnType`, `autoLoginYN` 변수. `duplicateLogin == 'Y'`면 `alert("중복로그인으로 현재 세션이 종료되었습니다.")`.
- **자격증명 거부 판정(미실측, 계정 잠금 위험으로 생략):** 4단계 응답이 302 `/login/userDiv`가 아니고 login 호스트에 머물며 `toastr.error(...)` 문구가 있으면 거부로 본다. 구현 시 "302가 아님 + 포털 복귀 실패"를 거부로 처리하고, 프로세스 생존 동안 재시도하지 않는다.
- **중복 로그인 정책(실측): 허용형.** 세션 A로 로그인 → 같은 계정으로 세션 B 로그인 → A로 대시보드 요청 → 정상 200(A 유지). 즉 MCP 로그인이 브라우저 세션을 끊지 않는다(적어도 로그인 직후에는). `duplicateLogin` 분기는 코드에 존재하므로 README에는 "끊길 수 있음"으로 보수적으로 안내한다.
- 로그아웃: `GET /logout`(포털), `https://login.shingu.ac.kr/logout`(SSO). MCP는 로그아웃하지 않는다(세션 재사용).

## 2. 공통 레이아웃

- 모든 포털 페이지가 사이드바 메뉴를 포함: `a[data-role=menuUrl][data-url][data-menu-cd][title]`. 메뉴 코드와 URL은 아래 표. 상위 메뉴는 `href="#right-menu-N"`.
- 페이지 상단 "My Profile" 블록(학번·성명·학과·학년/반)이 수강/성적 화면에 있다 → 픽스처 마스킹 대상.
- 날짜는 `<span data-role="date" data-origin-format="YYYY-MM-DD HH:mm:ss.s">2026-10-27 00:00:00.0</span>` 형태(JS로 포맷). 파서는 span 텍스트를 직접 읽는다.
- 세션 체크 ajax `/sessionCheck`, 재로그인 `/reSSOLogin`(사용하지 않음).
- 학기 코드: `GET /cmm/biz/codes/shingu/0/COR08` → JSON `[{cd:"1", nm:"1학기"}, {cd:"2", nm:"2학기"}, ...]` (계절학기 코드 포함 가능). 포털 파라미터는 모두 `yy`/`Yy`(4자리 연도) + `haggi`/`Haggi`/`lectureTerm`(학기 코드).

### 사이드바 메뉴(학생)

| 코드 | 메뉴 | URL |
|---|---|---|
| L0101 | 학적부조회 | `/SHJ/SHJ003P/SHJ003P` |
| L0102 | 학생카드 | `/SHJ/SHJ127P/SHJ127P` |
| M0101 | 강의실 시간표 조회 | `/SSE/SSE012R/SSE012R` |
| **M0102** | **개인 시간표 조회** | `/SSE/SSE013R/SSE013R` |
| M0103 | 학과 시간표 조회 | `/SSE/SSE015R/SSE015R` |
| N0101 | 수강신청 | `/SSG/SSG004P/SSG004P` |
| **N0102** | **이수예정학점조회** | `/SSG/SSG005P/SSG005P` |
| **N0103** | **성적조회(수강자료)** | `/SSJ/SSJ018P/SSJ018P` |
| **N0104** | **성적조회(확정성적)** | `/SSJ/SSJ019P/SSJ019P` |
| N0105 | 학업성적표 | `/SSJ/SSJ038P/SSJ038P` (출력기간 외에는 "학업성적표 출력기간이 아닙니다.") |
| O01xx | 등록/장학 | `/SDL/...`, `/SJH/SJH003R/SJH003R` (범위 밖) |
| U0106 | PUSH수신함 | `/alarm/recv/list` (표: 발신처·메시지 제목·수신일시) |
| – | **E클래스** | `/eclass/home` |
| – | NCS, 학생식당메뉴조회 | `/ncs/home`, `/restaurant/home` (범위 밖) |

## 3. 화면별 상세

### 3.1 대시보드 `/dashboard/dashboard` (GET)
- 공지 탭 4개: `#noti-1` 교수공지(=E클래스 공지, 정찰 시 비어 있음), `#noti-3` 대학공지, `#noti-4` 사이버(비어 있음), `#noti-5` 장학공지.
- 각 탭 `ul.dashboard-notice-list > li > a[data-role=noticePopup][href]` : `<span>[YYYY-MM-DD]</span>제목`. href는 **공개 CMS** `http://www.shingu.ac.kr/cms/FR_BBS_CON/BoardView.do?MENU_ID=1400&SITE_NO=2&BOARD_SEQ=4&BBS_SEQ=<id>` (대학공지: MENU_ID=1400/BOARD_SEQ=4, 장학공지: MENU_ID=1410/BOARD_SEQ=5). 탭당 8건.
- 그 외: 주요서비스 바로가기, 외부 링크(LMS·비교과 등). 과제/시간표 위젯은 **없음**.

### 3.2 개인 시간표 `/SSE/SSE013R/SSE013R` (GET)
- 파라미터: `Yy`(연도), `Haggi`(학기 코드), `Hagbeon`(학번, hidden — 세션에서 채워짐, 보내지 않아도 현재 학기 기본 표시). 기본값 = 현재 학년도/학기(`panel-heading`에 "2026 년도 2 학기").
- 데이터: `table.table-list.table-center` 4개 — 모바일용 3개(월·화 / 수·목 / 금·토, `th=[시간|월|화]`...)와 데스크톱용 1개(`th=[시간|월|화|수|목|금|토]`). **데스크톱 표(마지막 표)만 파싱**한다.
- 행 = 교시(1~11). 첫 td: 교시 번호, 둘째 td: 시간(`09:55~10:45` 등; 1·5교시는 시간 표기 없음), 이후 요일별 td. 셀 내용: `과목명 / 교수명 / 건물 호실 / 강의실 별칭` 이 줄바꿈(`<br>` 또는 블록)으로 구분. 한 셀에 두 과목이 겹칠 수 있음(수요일 6~8교시처럼 **분반/대체 수업이 같은 셀에 연속 나열**) → 4줄 단위로 분할.
- 교시 시간표(실측): 2=09:55~10:45, 3=10:50~11:40, 4=11:45~12:35, 6=13:35~14:25, 7=14:30~15:20, 8=15:25~16:15, 9=16:20~17:10, 10=17:15~18:05, 11=18:10~19:00. 1·5교시는 빈 행.
- 시간표는 **학기 고정**(주차별 변동 없음). `get_timetable(week?)`은 날짜 라벨만 바꾼다.

### 3.3 수강 과목 + 담당교수
- **과목 목록·교수 이름·학점·이수구분**: `/SSJ/SSJ018P/SSJ018P` (3.5 참고) 표의 "과목정보" 셀 = `과목명 / 과목코드 / 분반`, 다음 셀 = `이수구분 / 학점 / 교수명`.
- **교수 연락처**: E클래스 강의실 `교수소개 /eclass/clas/info/intro/introView` — 텍스트 `소속`, `이메일`, `전화번호` (dt/dd 또는 표 형태). `수업계획서 /eclass/clas/info/plan/planView` — `table.table-rwd-info` th=[학습목표|학습방법|평가방법|...|연구실], 두 번째 표 th=[구분|주|강의일자|수업내용|과제물](주차별 계획). E클래스가 개설되지 않은 과목은 연락처 없음(선택 필드).
- E클래스 강의실 진입은 3.4 참고(강의별 1회 POST + 2 GET → 과목 수 × 3요청; `get_courses`는 연락처를 선택적으로 수집하되 요청 수를 설명에 명시).

### 3.4 과제 — E클래스
1. **E클래스 홈** `GET /eclass/home?lectureYear=<YYYY>&lectureTerm=<학기코드>` (파라미터 생략 시 포털 기본값이 **다음 학년도(2027)** 로 잡혀 "E클래스 정보가 없습니다." 가 나오므로 **반드시 현재 학년도/학기를 명시**). 응답: 과목별 블록 — 제목 `과목명 (분반)`, 교수명, 최근 게시물 리스트 `a[data-role=enter][data-lecture-seq][href]` (href 예: `/eclass/clas/board/detail?boardId=1&wrId=...`, `/eclass/clas/room/homework/homeworkDetail?reportSeq=NNNNN`, 또는 빈 값/`#`). 각 항목 텍스트: `[게시판명] 제목 / 날짜`. E클래스를 개설한 과목만 나온다(정찰 시 7과목 중 4과목).
2. **강의실 진입** `POST /eclass/clas/home` form `lectureSeq=<seq>&redirect=` → 200, **세션에 현재 강의가 설정됨**(이후 `/eclass/clas/...` 요청은 이 강의 기준). 응답 상단 `UI화면설계(102) - 교수명`, `2026년도 2학기`. 좌측 메뉴(텍스트→URL): 교수소개 `/eclass/clas/info/intro/introView`, 수업계획서 `/eclass/clas/info/plan/planView`, 수강생 명단 `/eclass/clas/info/student/studentView`, 수업공지 `/eclass/clas/board/list?boardId=1`, 과목질의응답 `boardId=2`, 자료실 `boardId=3`, 자유게시판 `boardId=4`, 게시판1/2 `boardId=5/6`, 학습방 `/eclass/clas/room/learn/learnList`, **과제방 `/eclass/clas/room/homework/homeworkList`**, 토론방 `/eclass/clas/room/discuss/discussList`, 팀프로젝트 `/eclass/clas/room/project/projectList`, 수업설문 `/eclass/clas/room/survey/surveyList`, 성적확인 `/eclass/clas/room/grade/gradeList`(시험 목록, 출석 아님).
3. **과제 목록** `GET /eclass/clas/room/homework/homeworkList` → `table.table-list.table-center` th=[과제명|제출기한|연장기한|제출현황], 행 `tr[data-wr-id=<reportSeq>]`: td1 과제명, td2 `시작 ~ 마감`(span 2개), td3 연장기한(span), td4 `N명 / M명`(**분반 전체 제출 인원**, 내 제출 여부 아님). 페이지네이션 없음("Total 30", 30행 모두 한 페이지).
4. **과제 상세** `GET /eclass/clas/room/homework/homeworkDetail?reportSeq=<id>` → `table.table-rwd-info` th=[과제명|분반적용|제출기한|연장기한|연장감점여부|제출현황|과제내용|첨부파일]. 첨부 링크 `https://cec.shingu.ac.kr/01shingu/eClassDown.jsp?file_key=...`(마스킹 대상). **내 제출 상태는 하단 버튼으로 판정:**
   - `button[data-target="#registerModal"]`("과제제출") 존재 → **미제출(제출 가능)**
   - `button[data-role=resubmitBtn]`("다시제출", `data-wr-id`, `data-wr-re`, `data-score`) 존재 → **제출함** (`data-score`가 비어 있지 않으면 채점됨)
   - 둘 다 없음 → **제출 기간 아님**(시작 전 또는 종료)
   - 마감 해석 규칙(포털 안내문): 마감 시각이 `00:00`이면 전날 23:59까지.
   - 제출 상태는 상세 페이지에서만 알 수 있으므로 `get_assignments`는 목록 + (마감 임박/필터 대상) 상세 요청을 조합한다. 요청 수 = 1(홈) + 과목당 (1 진입 + 1 목록) + 상세 N. 비용을 줄이려면 상세는 `due_within_days` 범위 안의 과제에만 조회하고, 그 외는 `submitStatus: "unknown"`.
5. **수업공지** `GET /eclass/clas/board/list?boardId=1` (목록) / `GET /eclass/clas/board/detail?boardId=1&wrId=<20자리>` (본문).

### 3.5 성적·학점
- **성적조회(수강자료)** `GET /SSJ/SSJ018P/SSJ018P` — 현재 학기 수강 과목 표 th=[년도/학기|과목정보|점수|성적등급|이전과목년도학기|이전과목과목명|연락처확인강의평가]. "과목정보" = `과목명 / 과목코드 / 분반`, 다음 셀 `이수구분 / 학점 / 교수명`, 점수·등급은 학기 중 "성적미완료". 행 버튼 data: `data-yy`, `data-haggi`, `data-gwamog-cd`, `data-gaeseol-sosog-cd`, `data-hagnyeon`, `data-bunban`, `data-gbn`. 모달 ajax `/SSJ/SSJ018P/SSJ018P1`(강의평가), `/SSJ/SSJ018P/SSJ018P2` — 사용하지 않음.
- **성적조회(확정성적)** `GET /SSJ/SSJ019P/SSJ019P` — 학기 탭 `a[data-role=tabSearch][data-yy][data-haggi][data-hagbeon]`, 표 th=[년도|학기|학년|신청학점|취득학점|평점평균|실점평균|학사경고]. 정찰 시 확정 학기(2026-1)만 표시. 과목별 확정 성적 상세는 탭 클릭 ajax(`/SHJ/SHJ003P/SHJ003I10D1` 추정) — v1은 학기 요약만 사용.
- **이수예정학점조회** `GET /SSG/SSG005P/SSG005P` — 표 th=[년도|학기|학년|교필|교선|전필|전선|교직|인접|교양|전공|취득학점|신청학점|평점평균|평균점수], 학기별 행 + 마지막 "전체" 합계 행.
- `get_grades(semester?)`: `semester` 형식 `YYYY-H`(예 `2026-1`), 생략 시 전체. 데이터 = 확정성적 학기 요약(SSJ019P) + 이수학점(SSG005P) + 현재 학기 수강과목/교수(SSJ018P).

### 3.6 출석
- **학생에게 노출되는 출석 화면 없음**(사이드바·E클래스 전 메뉴 확인). 수업계획서에 출석 평가 비율 텍스트만 존재. → 사용자 결정(2026-10-26): `get_attendance`는 v1 제외.

### 3.7 공지 본문 (공개 CMS)
- `GET http://www.shingu.ac.kr/cms/FR_BBS_CON/BoardView.do?MENU_ID=<1400|1410>&SITE_NO=2&BOARD_SEQ=<4|5>&BBS_SEQ=<id>` — 로그인 불필요(`https` 가능). 제목 `b.cont_tit`, 첨부 `div.fileArea`, 본문 컨테이너는 `#contents` 안(픽스처 `tests/fixtures/cms/BoardView.html`로 셀렉터 확정). 호스트 allowlist에 `www.shingu.ac.kr`(GET만) 추가 필요.
- 공지 id 체계: `univ:<BBS_SEQ>`(대학공지), `scholarship:<BBS_SEQ>`(장학공지), `eclass:<lectureSeq>:<boardId>:<wrId>`(수업공지).

## 4. 요청 수 추정(첫 호출, 로그인 포함)

| 도구 | 요청 수 | 비고 |
|---|---|---|
| 로그인 | 7 | 세션 재사용 시 0 |
| `get_timetable` | 1 | |
| `get_courses` | 1 + (E클래스 과목 수 × 3) | 연락처 포함 시. 연락처 생략 옵션 고려 |
| `get_assignments` | 1 + (E클래스 과목 수 × 2) + 상세 N | 상세는 필터 범위만 |
| `get_notices` | 1 (대시보드) [+ 수업공지: 과목 수 × 2] | |
| `get_grades` | 3 | |

큐 간격 500ms 기준 첫 `get_assignments`(4과목, 상세 5건)는 약 7 + 1 + 8 + 5 = 21요청 ≈ 11~15초 → **AC-E1 15초 경계**. 상세 조회는 `due_within_days` 범위로 제한하고 로그인 hop을 줄일 수 없으므로 README에 첫 호출 지연을 명시한다.
