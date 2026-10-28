# shingu-mcp

신구대학교 학생종합포털(student.shingu.ac.kr)을 조회하는 MCP 서버입니다. Claude Code에서 "이번 주 과제 뭐 있어?" 같은 질문을 하면 실제 포털 데이터로 답합니다. 포털에 쓰는 도구는 과제 제출(`submit_assignment`) 하나뿐이며, 미리보기를 승인해야 제출됩니다.

## 범위

- 과제: E클래스 과제방의 과제와 내 제출 상태, 과제 제출·다시 제출(본문 + 첨부 1개)
- 개인 시간표
- 수강 과목과 담당 교수 (교수 연락처는 옵션)
- 공지: 대학 / 장학 / 수업공지(E클래스) 목록과 본문
- 성적 / 이수학점
- E클래스 아카이브: 이번 학기 과제방·수업공지·자료실 게시물과 내 제출을 로컬 SQLite에 저장하고 첨부파일을 내려받기(`sync_eclass`), 저장한 내용 검색(`search_archive`)

범위 밖:

- LMS(lms.shingu.ac.kr)
- 출석 (포털에 노출되지 않음)
- 과제 제출 외의 쓰기 작업 (수강 신청, 게시글 작성 등)
- Claude Desktop 동작은 보장하지 않습니다. Claude Code 기준입니다.

## 요구사항

- Node.js 22.13 이상 (내장 `node:sqlite` 사용)
- 신구대학교 학생 계정 (학번 / 비밀번호). 교직원 계정은 지원하지 않습니다.

## 설치

```bash
git clone <이 저장소 URL> shingu-mcp
cd shingu-mcp
npm ci
npm run build
```

빌드 결과물은 `dist/index.js`입니다. Claude Code에 등록하는 방법은 두 가지입니다.

### (a) `claude mcp add`

```bash
claude mcp add shingu -e SHINGU_ID=학번 -e SHINGU_PW=비밀번호 -- node <절대경로>/dist/index.js
```

Windows 예시:

```bash
claude mcp add shingu -e SHINGU_ID=학번 -e SHINGU_PW=비밀번호 -- node C:\Users\<사용자>\shingu-mcp\dist\index.js
```

### (b) 프로젝트 `.mcp.json`

`examples/mcp.json`을 참고해 프로젝트 루트의 `.mcp.json`에 넣고 `<ABSOLUTE_PATH>`를 실제 절대경로로 바꿉니다. JSON 안의 Windows 경로는 `/` 또는 `\\`로 적어야 합니다(`\` 한 개는 JSON 문법 오류).

```json
{
  "mcpServers": {
    "shingu": {
      "command": "node",
      "args": ["C:/Users/<사용자>/shingu-mcp/dist/index.js"],
      "env": {
        "SHINGU_ID": "학번",
        "SHINGU_PW": "비밀번호"
      }
    }
  }
}
```

env를 생략하고 아래 설정 파일을 쓰면 `.mcp.json`에 비밀번호를 적지 않아도 됩니다.

### (c) 모든 프로젝트에서 사용하기 (user scope)

프로젝트마다 `.mcp.json`을 두지 않고 어느 디렉터리에서 Claude Code를 열어도 쓰려면 **사용자 범위**로 등록합니다. 자격증명은 아래 `~/.shingu-mcp/config.json`에 두면 명령에 비밀번호를 넣지 않아도 됩니다.

```sh
claude mcp add --scope user shingu -- node C:/Users/<사용자>/shingu-mcp/dist/index.js
claude mcp list   # shingu 가 보이면 완료. 제거는 claude mcp remove --scope user shingu
```

등록 후 새 Claude Code 세션(어느 폴더든)에서 "이번 주 과제 뭐 있어?", "과제 34771 내용 보여줘"처럼 물으면 됩니다.

## 자격증명 설정

우선순위는 다음과 같습니다.

1. 환경변수 `SHINGU_ID`와 `SHINGU_PW` (**둘 다** 설정해야 합니다)
2. 설정 파일 `~/.shingu-mcp/config.json`

```json
{ "id": "학번", "password": "비밀번호" }
```

Windows에서는 `C:\Users\<사용자>\.shingu-mcp\config.json`입니다.

주의:

- `.mcp.json`에 비밀번호를 넣었다면 그 파일을 **커밋하지 마세요.**
- 비밀번호는 로그, 에러 메시지에 기록되지 않습니다.

## 도구

| 이름 | 입력 | 반환 | 예상 소요 |
|---|---|---|---|
| `get_assignments` | `due_within_days`(선택, 0~365): 지금부터 N일 이내 마감만 | 과목, 제목, 마감, 내 제출 상태. **아카이브 저장본**에서 답함(제출 상태는 `fetchedAt`=마지막 동기화 시점 기준). 이번 학기 동기화 기록이 없거나 24시간이 지났으면 먼저 E클래스 과제·게시글 동기화(첨부 파일·시간표·과목·성적 제외) | 즉시(저장본), 동기화가 필요하면 처음 1분 안팎·이후 수십 초 |
| `get_assignment` | `report_seq`(필수), `lecture_seq`(선택) | 과제 한 건의 본문 전체·첨부파일(이름·다운로드 URL)·제출/연장기한·감점 안내·내 제출 상태. 24시간 안에 읽은 **저장본**이 있으면 그것, 아니면 포털에서 읽어 저장 | 즉시(저장본), 포털 약 2초 |
| `get_timetable` | `week`(선택, `YYYY-MM-DD`): 이 날짜가 속한 주의 날짜를 항목에 붙임 | 요일, 교시, 과목, 교수, 강의실, 날짜. **저장본**(`fetchedAt`=저장 시각). 없거나 비었거나 24시간이 지났으면 포털에서 읽어 저장 | 즉시(저장본), 포털 약 0.3초 |
| `get_courses` | `include_contacts`(선택, 기본 false): 교수 연락처 포함 | 수강 과목, 담당 교수 (옵션: 이메일, 전화, 연구실). **저장본**(연락처 포함으로 저장, `include_contacts: false`면 빼고 반환). 없거나 24시간이 지났으면 연락처까지 포털에서 읽어 저장 | 즉시(저장본), 포털 약 1.2초 + 과목당 약 7초(연락처) |
| `get_notices` | `category`(`univ`/`scholarship`/`eclass`), `limit`(1~100, 기본 20), `include_eclass`(기본 false) | 공지 목록 (최신순). 항상 포털 | 약 0.4초 |
| `get_notice` | `id`: `get_notices` 결과의 id | 공지 본문, 첨부파일 목록. 항상 포털 | 약 0.7초 |
| `get_grades` | `semester`(선택, `YYYY-H` 예: `2026-1`) | 학기별 성적, 이수구분별 학점, 이번 학기 과목별 성적. **저장본**(`semester` 필터는 반환 직전). 없거나 24시간이 지났으면 포털에서 읽어 저장 | 즉시(저장본), 포털 약 1.5초 |
| `sync_eclass` | `download_files`(선택, 기본 true), `full`(선택, 기본 false: 증분) | 이번 학기 시간표·수강 과목·성적 갱신 결과, 과목별 과제·제출·수업공지·자료실 신규/갱신 건수, 첨부 다운로드 수, DB·파일 경로 | 첫 실행 수 분(첨부 크기에 따라), 이후 증분 |
| `search_archive` | `kind`(`assignments`/`posts`, 기본 assignments), `course`·`query`(부분 일치), `board`(`notice`/`material`), `status`(`submitted`/`not_submitted`/`not_open`), `due_from`·`due_to`(`YYYY-MM-DD`, 연장기한 우선), `limit`(1~100, 기본 20) | 저장된 과제(내 제출 포함)·게시글과 본문 발췌(300자), 첨부의 로컬 파일 경로. 포털에 요청하지 않음 | 즉시 |
| `submit_assignment` | `report_seq`·`title`·`content`(필수), `lecture_seq`·`file_path`(절대 경로, 1개)·`confirm_token`(선택) | 토큰 없이 호출하면 미리보기(대상 과제, 마감·연장 감점, 덮어쓰기 경고, 기존 첨부)와 `confirmToken`. 그 토큰을 넣어 다시 호출하면 제출하고, 포털을 다시 읽어 `verified`로 반영 여부를 표시 | 미리보기 약 2초 |

소요 시간은 실계정 실측값이며 네트워크와 수강 과목 수에 따라 달라집니다. `include_eclass`를 켜면 과목당 포털 요청이 2회 늘어납니다.

예시 질문:

- "이번 주 마감인 과제 알려줘"
- "내일 수업이 뭐야?"
- "장학 공지 최근 5개 보여줘"
- "이번 학기 수강 과목이랑 담당 교수 알려줘"
- "지금까지 이수 학점이 몇 학점이야?"

모든 조회 도구의 응답에는 포털에서 읽은 시각 `fetchedAt`이 붙습니다. 저장본으로 답했으면 그 저장본을 포털에서 읽은 시각입니다.

### 과제 제출 주의

- "과제 34708 제출해줘, 제목은 …, 내용은 …, 파일은 C:/…/보고서.pdf"처럼 요청하면 먼저 **미리보기**가 나옵니다. 내용을 확인하고 승인해야 실제로 제출됩니다.
- 제출에는 미리보기가 발급한 토큰이 필요합니다. 토큰은 10분 동안 유효하고, 그사이 제목·내용·첨부 파일이나 포털 상태가 바뀌면 제출하지 않고 새 미리보기를 보여 줍니다.
- 이미 제출한 과제는 다시 제출로 처리되어 기존 제목·본문을 덮어씁니다. 새 파일을 주면 기존 첨부를 교체하고, 주지 않으면 기존 첨부를 유지합니다. 평가가 끝난 과제는 다시 제출할 수 없습니다.
- 연장 기간에 제출하면 과제의 감점 규칙이 적용될 수 있습니다. 미리보기의 경고를 확인하세요.
- 제출 요청은 중복 제출을 막기 위해 재시도하지 않고, 세션이 만료돼도 자동으로 다시 보내지 않습니다. 오류가 나면 `get_assignment`로 상태를 확인한 뒤 다시 시도하세요.
- 보안상 첨부할 수 없는 파일: 네트워크(UNC) 경로, 숨김 폴더(`.ssh`, `.aws` 등) 안의 파일과 숨김 파일, `AppData` 아래 파일, `.shingu-mcp` 설정 폴더, 키·인증서 파일(`.pem`, `.key`, `.env`, `id_rsa` 등).

## 동작 방식

- 도구가 호출될 때만 포털에 로그인(SSO)하고 요청합니다. 백그라운드 폴링은 없습니다.
- 포털 요청은 순차로 보내며 간격 200ms, 타임아웃 15초, 재시도 1회입니다. 과제 제출·첨부 업로드 요청은 재시도하지 않습니다(업로드 타임아웃 120초).
- 과제·과제 상세·시간표·수강 과목·성적은 로컬 아카이브(`~/.shingu-mcp/eclass.db`)의 저장본으로 답하고, 저장본이 없거나 **24시간**이 지났을 때만 포털에서 다시 읽어 저장합니다(아래 "E클래스 아카이브"). 공지(`get_notices`/`get_notice`)와 과제 제출은 항상 포털에 요청합니다. 아카이브 DB를 열지 못하면 모든 조회가 매번 포털에 요청합니다.
- 다시 읽어야 할 때 포털에 장애가 있으면 조회 도구는 오류를 반환합니다(오래된 저장본으로 대신 답하지 않습니다).
- 이전 버전이 만든 `~/.shingu-mcp/snapshots/` 폴더는 더 이상 쓰지 않으니 직접 삭제해도 됩니다.

### E클래스 아카이브 (`sync_eclass`)

"E클래스 자료 동기화해줘"처럼 요청하면 이번 학기 E클래스 강의 중 과제나 게시글이 있는 강의만 읽어 저장합니다. 포털에는 쓰지 않습니다.

- DB: `~/.shingu-mcp/eclass.db` (SQLite). 아무 SQLite 도구(`sqlite3`, DB Browser for SQLite 등)로 열 수 있습니다.
- 첨부 파일: `~/.shingu-mcp/files/<lectureSeq>_<과목명>/<assignments|submissions|notices|materials>/<번호>/<파일명>`. 내용이 같은 파일은 한 번만 저장하고 DB에서 같은 경로를 가리킵니다.

| 테이블 | 내용 |
|---|---|
| `courses` | 강의(`lecture_seq`, 과목명, 학년도·학기, 분반, 교수) |
| `assignments` | 과제방: 과제명, 제출 시작·제출기한·연장기한, 연장 감점 안내, 과제 내용(`content_html`/`content_text`), 내 제출 상태 |
| `submissions` | 내가 제출한 과제의 제목·내용(`content_html`/`content_text`) |
| `posts` | 수업공지(`board='notice'`)·자료실(`board='material'`): 제목, 등록일시, 작성자, 본문 전체(`body_html`/`body_text`) |
| `attachments` | 첨부(과제·내 제출·게시글 공통): 파일명, 원본 링크, 로컬 경로(`files` 기준), 크기, sha256 |
| `timetables` / `timetable_entries` | 학기별 시간표 동기화 시각 / 요일·교시·시작·종료·과목·교수·건물·강의실 |
| `views` | 학기별 저장본(JSON): `kind='courses'` 수강 과목(교수 연락처 포함), `kind='grades'` 성적 전체(읽은 학기 키). 읽을 때 스키마를 검사해 맞지 않으면 다시 읽음 |
| `eclass_syncs` | 학기별 마지막 E클래스 동기화 완료 시각(`get_assignments`의 24시간 판단 기준. 취소된 동기화는 남기지 않음) |
| `eclass_sync_attempts` | 실패한 강의가 있던 동기화 시도 시각. 그 뒤 1시간은 `get_assignments`가 다시 동기화하지 않음 |

`assignments`에는 제출현황(`submitted_count`/`total_count`)과 평가 여부(`scored`)도 저장합니다. `fetched_at`은 포털에서 마지막으로 읽은 시각(내용이 같아도 갱신)입니다.

`search_archive`로 Claude에게 바로 물어볼 수 있습니다. 예: "아카이브에서 UI화면설계 미제출 과제 찾아줘", "자료실에서 '색채' 들어간 글 보여줘", "11월 첫 주 마감 과제 알려줘". 결과의 첨부는 원본 링크 없이 내려받은 파일 경로만 보여 줍니다.

SQLite 도구로 직접 열 때의 예시 질의:

```sql
-- 마감 전인데 아직 안 낸 과제
SELECT c.course_name, a.title, COALESCE(a.extended_due_at, a.due_at) AS deadline
FROM assignments a JOIN courses c USING (lecture_seq)
WHERE a.submit_status = 'not_submitted' AND deadline >= strftime('%Y-%m-%dT%H:%M:%S+09:00', 'now', '+9 hours')
ORDER BY deadline;

-- 자료실 글과 첨부 파일 위치
SELECT p.title, p.posted_at, f.name, f.local_path
FROM posts p LEFT JOIN attachments f ON f.owner_type = 'post' AND f.owner_key = p.lecture_seq || ':' || p.board || ':' || p.wr_id
WHERE p.board = 'material' ORDER BY p.posted_at DESC;
```

동작:

- 동기화할 때마다 이번 학기 시간표(요청 1회), 수강 과목과 교수 연락처(요청 2 + 과목당 3), 성적(요청 3)을 읽어 저장합니다. 이 중 하나가 실패해도 나머지와 E클래스 동기화는 계속하고 그 저장본은 그대로 둡니다(요약의 `timetable`/`enrolledCourses`/`grades`에 `failed`와 경고). 자격증명 오류면 멈춥니다.
- **24시간 규칙:** 조회 도구는 저장본이 24시간 안이면 포털에 요청하지 않습니다. `get_assignments`는 이번 학기 동기화 기록이 없거나 24시간이 지났으면 먼저 E클래스 과제·게시글만 증분 동기화(첨부 파일은 받지 않고, 시간표·수강 과목·성적은 각 도구가 따로 갱신)한 뒤 DB에서 답합니다. 처음엔 1분 안팎 걸릴 수 있고 진행률 알림·취소를 지원합니다. 다른 동기화가 첨부를 받는 중이어도 그 다운로드는 기다리지 않습니다. 취소된 동기화는 기록을 남기지 않아 다음 조회가 다시 동기화하고, 실패한 강의가 있던 동기화는 시도 시각만 남겨 1시간 뒤에 다시 시도합니다(그동안 `fetchedAt`은 저장된 과제를 실제로 읽은 가장 최근 시각). `get_assignment`는 그 과제를 24시간 안에 읽었으면 저장본(본문은 `content_text`)으로 답하고, 아니면 포털에서 읽어 과제·첨부를 저장합니다. 시간표·수강 과목·성적은 오래됐으면 그 하나만 포털에서 다시 읽어 저장합니다.
- 저장본의 제출 상태는 동기화(또는 `get_assignment`) 때 상세 화면으로 읽은 값입니다. 포털에서 바로 읽을 때와 달리 14일 범위 밖 과제도 `unknown`이 아닌 저장된 상태로 나옵니다.
- `submit_assignment`로 제출을 보내면 그 과제의 저장본을 오래된 것으로 표시해 다음 `get_assignment`가 포털에서 다시 읽습니다. 반영을 확인했으면(`verified`) 상태도 `submitted`로 바꿉니다.
- 저장된 상태가 `submitted`인 과제는 마감 뒤 판정이 실패해 "기간 아님"으로 보여도 `submitted`로 둡니다(제출은 되돌릴 수 없음).
- 공지(`get_notices`/`get_notice`)는 저장본을 쓰지 않고 항상 포털에서 읽습니다.
- 기본은 **증분**입니다. 마감(연장 포함)이 하루 이상 지난 과제와 등록된 지 14일이 넘은 저장 게시글은 다시 읽지 않습니다. 최근 14일 안에 올라온 글은 증분에서도 다시 읽어 수정됐으면 갱신합니다(바뀌지 않았으면 갱신·재다운로드 없음). 더 오래된 글의 수정까지 반영하려면 `full: true`로 실행하세요.
- 실측(2026-10-27, 강의 2개: 과제 31·게시글 28·첨부 47건 545MB): 첫 실행 목록·본문 저장 약 48초, 첨부 다운로드 약 5분(중복 제거 후 디스크 317MB). 이후 증분 실행은 수십 초입니다.
- 첨부는 조회와 **별도의 다운로드 큐**로 하나씩 받습니다. 그래서 다운로드 중에도 다른 도구(과제·공지 조회 등)는 기다리지 않고 동작합니다(포털 동시 요청은 최대 2). 한 건당 최대 10분을 기다리고, 실패한 첨부는 다음 동기화에서 다시 받습니다. 중단돼 남은 임시 파일(`*.part`)은 다음 동기화 시작 때 지웁니다.
- **진행률:** 클라이언트가 진행률 토큰(progressToken)을 보내면 강의 단위·첨부 단위로 `notifications/progress`(진행/전체)를 보냅니다. 전체 수는 첨부 개수를 알게 되면 늘어납니다.
- **긴 동기화와 타임아웃:** 첫 동기화처럼 수 분 걸리는 실행은 클라이언트가 진행률 알림을 받을 때 타임아웃을 연장하는 경우에만 끝까지 안전하게 돕니다. 그렇지 않은 클라이언트라면 `download_files: false`로 먼저 목록·본문만 저장한 뒤 다시 실행해 첨부를 받으세요.
- **취소:** 도구 호출을 취소하면 다음 단계(강의·과제·게시글·첨부) 전에 멈추고, 받던 첨부도 끊습니다(임시 파일 삭제). 그때까지 저장한 내용은 남고 취소는 실패로 기록하지 않으므로 다음 동기화에서 이어 받습니다. 취소된 호출의 결과는 클라이언트에 전달되지 않습니다(서버 로그에만 남음).
- 자격증명 오류가 나면 동기화를 멈춥니다. 한 강의에서 난 다른 오류는 그 강의의 `error`에 적고 다음 강의로 넘어갑니다.

**민감정보 경고:** DB와 `files/`에는 내가 제출한 과제 내용·파일, **성적**(학기별 평점·과목별 점수), 교수 연락처가 **평문**으로 저장됩니다. 공용 PC에서 사용하지 말고 이 폴더를 공유·커밋하지 마세요. 첨부 원본 링크(`file_key`)는 로그인 없이도 파일을 받을 수 있는 값이므로 DB 파일도 함부로 공유하지 마세요.

## 주의사항

- **Claude가 포털을 조회하면 브라우저의 포털 로그인이 풀릴 수 있습니다.** (브라우저에서 켜 둔 로그인이 끊길 수 있습니다.) 실측에서는 동시 세션이 허용되었지만 포털에 중복 로그인 감지 코드가 있어 보수적으로 안내합니다.
- 계정 잠금 방지: 비밀번호가 틀리면 프로세스가 살아 있는 동안 재시도하지 않습니다. 설정을 고친 뒤 Claude Code를 재시작하세요.

## 문제 해결

- "자격증명을 찾을 수 없습니다": 환경변수와 설정 파일이 모두 없습니다. 에러 메시지에 표시된 경로에 `config.json`을 만들거나 환경변수를 설정하세요.
- "환경변수 ... 가 설정되지 않았습니다": `SHINGU_ID`와 `SHINGU_PW` 중 하나만 설정된 상태입니다. 둘 다 설정하세요.
- "설정 파일 ... 올바른 JSON이 아닙니다 / 형식이 올바르지 않습니다": `{"id":"...","password":"..."}` 형식인지 확인하세요.
- 로그인 실패 후 계속 실패: 비밀번호 수정 후 Claude Code를 재시작해야 합니다.
- 성적이 비어 있음: 학업성적표는 출력기간에만 조회됩니다. 기간 외에는 "출력기간이 아닙니다"로 응답합니다.
- 과제/교수 연락처가 없음: E클래스가 개설되지 않은 과목은 과제와 연락처가 없습니다.
- 자세한 로그: `SHINGU_MCP_LOG=debug`를 환경변수로 설정하세요. (로그는 stderr로만 출력되며 비밀번호는 마스킹됩니다.)

## 개발

```bash
npm test             # vitest
npm run typecheck    # tsc --noEmit
npm run check:pii    # 픽스처에 개인정보가 남아 있는지 검사
```

- 테스트 픽스처: `tests/fixtures/README.md`
- 실계정이 필요한 스크립트 `npm run recon:login`, `npm run smoke:service`, `npm run smoke`, `npm run smoke:archive`는 루트에 `.env`가 필요합니다. `.env.example`을 복사해 채우세요. `.env`는 커밋하지 않습니다.
- 포털 화면 정찰 결과: `docs/portal-pages.md`
- 커밋 규칙: `COMMIT.md`
