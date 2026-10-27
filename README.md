# shingu-mcp

신구대학교 학생종합포털(student.shingu.ac.kr)을 조회하는 MCP 서버입니다. Claude Code에서 "이번 주 과제 뭐 있어?" 같은 질문을 하면 실제 포털 데이터로 답합니다. 포털에 쓰는 도구는 과제 제출(`submit_assignment`) 하나뿐이며, 미리보기를 승인해야 제출됩니다.

## 범위

- 과제: E클래스 과제방의 과제와 내 제출 상태, 과제 제출·다시 제출(본문 + 첨부 1개)
- 개인 시간표
- 수강 과목과 담당 교수 (교수 연락처는 옵션)
- 공지: 대학 / 장학 / 수업공지(E클래스) 목록과 본문
- 성적 / 이수학점

범위 밖:

- LMS(lms.shingu.ac.kr)
- 출석 (포털에 노출되지 않음)
- 과제 제출 외의 쓰기 작업 (수강 신청, 게시글 작성 등)
- Claude Desktop 동작은 보장하지 않습니다. Claude Code 기준입니다.

## 요구사항

- Node.js 20 이상
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
| `get_assignments` | `due_within_days`(선택, 0~365): 지금부터 N일 이내 마감만 | 과목, 제목, 마감, 내 제출 상태 | 7일 범위 약 15초 (첫 호출 로그인 포함) |
| `get_assignment` | `report_seq`(필수), `lecture_seq`(선택) | 과제 한 건의 본문 전체·첨부파일(이름·다운로드 URL)·제출/연장기한·감점 안내·내 제출 상태 | 약 2초 |
| `get_timetable` | `week`(선택, `YYYY-MM-DD`): 이 날짜가 속한 주의 날짜를 항목에 붙임 | 요일, 교시, 과목, 교수, 강의실, 날짜 | 약 0.3초 |
| `get_courses` | `include_contacts`(선택, 기본 false): 교수 연락처 포함 | 수강 과목, 담당 교수 (옵션: 이메일, 전화, 연구실) | 약 1.2초 (연락처 포함 시 과목당 약 7초 추가) |
| `get_notices` | `category`(`univ`/`scholarship`/`eclass`), `limit`(1~100, 기본 20), `include_eclass`(기본 false) | 공지 목록 (최신순) | 약 0.4초 |
| `get_notice` | `id`: `get_notices` 결과의 id | 공지 본문, 첨부파일 목록 | 약 0.7초 |
| `get_grades` | `semester`(선택, `YYYY-H` 예: `2026-1`) | 학기별 성적, 이수구분별 학점, 이번 학기 과목별 성적 | 약 1.5초 |

| `submit_assignment` | `report_seq`·`title`·`content`(필수), `lecture_seq`·`file_path`(절대 경로, 1개)·`confirm_token`(선택) | 토큰 없이 호출하면 미리보기(대상 과제, 마감·연장 감점, 덮어쓰기 경고, 기존 첨부)와 `confirmToken`. 그 토큰을 넣어 다시 호출하면 제출하고, 포털을 다시 읽어 `verified`로 반영 여부를 표시 | 미리보기 약 2초 |

소요 시간은 실계정 실측값이며 네트워크와 수강 과목 수에 따라 달라집니다. `include_eclass`를 켜면 과목당 포털 요청이 2회 늘어납니다.

예시 질문:

- "이번 주 마감인 과제 알려줘"
- "내일 수업이 뭐야?"
- "장학 공지 최근 5개 보여줘"
- "이번 학기 수강 과목이랑 담당 교수 알려줘"
- "지금까지 이수 학점이 몇 학점이야?"

모든 조회 도구의 응답에는 포털에서 읽은 시각 `fetchedAt`이 붙습니다.

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
- 조회 결과는 저장하지 않습니다. 포털 장애 시 조회 도구는 오류를 반환합니다.
- 이전 버전이 만든 `~/.shingu-mcp/snapshots/` 폴더는 더 이상 쓰지 않으니 직접 삭제해도 됩니다.

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
- 실계정이 필요한 스크립트 `npm run recon:login`, `npm run smoke:service`, `npm run smoke`는 루트에 `.env`가 필요합니다. `.env.example`을 복사해 채우세요. `.env`는 커밋하지 않습니다.
- 포털 화면 정찰 결과: `docs/portal-pages.md`
- 커밋 규칙: `COMMIT.md`
