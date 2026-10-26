# 포털 픽스처

`tests/fixtures/raw/`(gitignore)에 저장한 실제 포털 HTML을 `scripts/mask-fixture.mjs`로 마스킹한 사본이다. 파서 단위 테스트는 네트워크 없이 이 파일만 사용한다.

## 마스킹 규칙 (적용 순서)

| 대상 | 치환 |
|---|---|
| 비밀번호 문자열 | 발견 시 스크립트 실패, 출력 없음 |
| 학번 (`.env`의 `SHINGU_ID` + `20\d{6,8}` 패턴, 날짜 제외) | `2000000000` |
| 학생 본인 이름 (`MASK_STUDENT_NAME`) | `홍길동` |
| 교수 이름 (`MASK_PROFESSORS`, 쉼표 구분, 등장 순서대로) | `김교수`, `이교수`, `박교수`, … |
| 전화번호 `0xx-xxxx-xxxx` | `010-0000-0000` |
| 이메일 | `user@example.com` |
| 첨부 `file_key=`, `jsessionid=`, QR 코드 base64 | `MASKED` |
| 평점평균(`x.xxx`) / 실점·평균점수(`xx.xx`) | `3.500` / `90.00` |
| 과목명·공지 제목·과제 제목·학점 수 | 유지 (공개 또는 비식별 정보) |

실행: `MASK_STUDENT_NAME=<실명> MASK_PROFESSORS=<이름1,이름2,...> node scripts/mask-fixture.mjs`
검사: `node scripts/mask-fixture.mjs --check` (`.env` 값·실명이 `tests/fixtures/`에 남아 있으면 실패)

## 파일 ↔ 화면

| 픽스처 | 화면 | 상태 |
|---|---|---|
| `login/notlogin.html` | `/notlogin/t` (ssoRedFrm 자동 제출) | 미로그인 |
| `login/sso-login-form.html` | `login.shingu.ac.kr/index` 로그인 폼 | |
| `login/sso-userdiv.html` | `login.shingu.ac.kr/login/userDiv` (ssoLoginFrm) | 로그인 성공 직후 |
| `dashboard.html` | `/dashboard/dashboard` | 대학/장학 공지 8건씩 |
| `timetable/SSE013R.html` | 개인 시간표 | 2026-2, 7과목 |
| `grades/SSJ018P-current.html` | 성적조회(수강자료) | 학기 중(성적미완료) |
| `grades/SSJ019P-confirmed.html` | 성적조회(확정성적) | 확정 1학기 |
| `grades/SSG005P-credits.html` | 이수예정학점조회 | 2학기 + 전체 |
| `grades/SSJ038P-out-of-period.html` | 학업성적표 | 출력기간 아님 |
| `codes/COR08.json` | 학기 코드 | |
| `eclass/home-empty.html` | E클래스 홈(기본 파라미터) | "E클래스 정보가 없습니다." |
| `eclass/home-2026-2.html` | E클래스 홈 2026-2 | 4과목 |
| `eclass/clas-home.html` | 강의실 홈 | 메뉴 + 최근 게시물 |
| `eclass/homework-list.html` | 과제방 목록 | 30건 |
| `eclass/homework-detail-not-submitted.html` | 과제 상세 | "과제제출" 버튼 = 미제출 |
| `eclass/homework-detail-submitted.html` | 과제 상세 | "다시제출" 버튼 = 제출함 |
| `eclass/homework-detail-not-open.html` | 과제 상세 | 버튼 없음 = 기간 아님 |
| `eclass/intro-view.html` | 교수소개 | 소속/이메일/전화 |
| `eclass/plan-view.html` | 수업계획서 | 연구실 포함 |
| `eclass/board-list-notice.html` | 수업공지 목록 | |
| `alarm/recv-list-empty.html` | PUSH수신함 | 빈 상태 |
| `cms/BoardView.html` | 공개 CMS 공지 본문 | |
