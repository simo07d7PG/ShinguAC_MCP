#!/usr/bin/env node
// 포털 원본 HTML(tests/fixtures/raw/, gitignore) → PII 마스킹 픽스처(tests/fixtures/)
// 사용: node scripts/mask-fixture.mjs [--check]
//   - .env 의 SHINGU_ID 값과 아래 NAMES 의 실명을 치환한다. 비밀번호 문자열이 발견되면 실패(exit 1).
//   - --check: 출력 파일을 만들지 않고 tests/fixtures/ 에 금지 문자열이 남아 있는지만 검사한다.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rawDir = join(root, "tests", "fixtures", "raw");
const outDir = join(root, "tests", "fixtures");
const check = process.argv.includes("--check");

// ---- 치환 대상 (실제 값은 .env 와 아래 상수에서만 온다. 이 파일은 커밋되므로 실명·학번을 적지 않는다) ----
function readEnv() {
  const p = join(root, ".env");
  if (!existsSync(p)) return {};
  return Object.fromEntries(
    readFileSync(p, "utf8")
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith("#") && l.includes("="))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")];
      }),
  );
}
const env = readEnv();
const STUDENT_ID = env.SHINGU_ID ?? "";
const PASSWORD = env.SHINGU_PW ?? "";
// 학생 본인 이름과 교수 실명은 환경변수로 받는다(쉼표 구분). 예: MASK_STUDENT_NAME=홍길순 MASK_PROFESSORS=김아무,이아무
const STUDENT_NAME = process.env.MASK_STUDENT_NAME ?? "";
const PROFESSORS = (process.env.MASK_PROFESSORS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const PROF_ALIASES = ["김교수", "이교수", "박교수", "최교수", "정교수", "강교수", "조교수", "윤교수", "장교수", "임교수"];

// 어떤 raw 파일을 어떤 픽스처 이름으로 내보낼지 (화면 기준)
const MAP = {
  "01_notlogin.html": "login/notlogin.html",
  "02_sso_index.html": "login/sso-login-form.html",
  "03_after_login.html": "login/sso-userdiv.html",
  "05_dashboard.html": "dashboard.html",
  "pages/_SSE_SSE013R_SSE013R.html": "timetable/SSE013R.html",
  "pages/_SSJ_SSJ018P_SSJ018P.html": "grades/SSJ018P-current.html",
  "pages/_SSJ_SSJ019P_SSJ019P.html": "grades/SSJ019P-confirmed.html",
  "pages/_SSG_SSG005P_SSG005P.html": "grades/SSG005P-credits.html",
  "pages/_SSJ_SSJ038P_SSJ038P.html": "grades/SSJ038P-out-of-period.html",
  "pages/_cmm_biz_codes_shingu_0_COR08.html": "codes/COR08.json",
  "pages/_eclass_home.html": "eclass/home-empty.html",
  "pages/_eclass_home_lectureYear_2026_lectureTerm_2.html": "eclass/home-2026-2.html",
  "pages/_eclass_clas_home.html": "eclass/clas-home.html",
  "pages/_eclass_clas_room_homework_homeworkList.html": "eclass/homework-list.html",
  "pages/_eclass_clas_room_homework_homeworkDetail_reportSeq_34771.html": "eclass/homework-detail-not-submitted.html",
  "pages/_eclass_clas_room_homework_homeworkDetail_reportSeq_34757.html": "eclass/homework-detail-submitted.html",
  "pages/_eclass_clas_room_homework_homeworkDetail_reportSeq_34710.html": "eclass/homework-detail-not-open.html",
  "pages/_eclass_clas_info_intro_introView.html": "eclass/intro-view.html",
  "pages/_eclass_clas_info_plan_planView.html": "eclass/plan-view.html",
  "pages/_eclass_clas_board_list_boardId_1.html": "eclass/board-list-notice.html",
  "pages/_eclass_clas_board_list_boardId_1_filled.html": "eclass/board-list-notice-filled.html",
  "pages/_eclass_clas_board_detail_boardId_1_wrId_00000000000000000002.html": "eclass/board-detail-notice.html",
  "pages/_alarm_recv_list.html": "alarm/recv-list-empty.html",
  "cms/BoardView_17703.html": "cms/BoardView.html",
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function mask(text) {
  let t = text;
  if (PASSWORD && t.includes(PASSWORD)) throw new Error("비밀번호 문자열이 원본에 존재합니다 — 중단");
  // 학번: .env 값 + 일반 패턴(20으로 시작하는 8~10자리)
  if (STUDENT_ID) t = t.split(STUDENT_ID).join("2000000000");
  t = t.replace(/\b20\d{6,8}\b/g, (m) => (/^20(2[0-9]|1[0-9])-?\d{2}-?\d{2}$/.test(m) ? m : "2000000000"));
  // 이름
  if (STUDENT_NAME) t = t.split(STUDENT_NAME).join("홍길동");
  PROFESSORS.forEach((p, i) => {
    t = t.split(p).join(PROF_ALIASES[i % PROF_ALIASES.length]);
  });
  // 연락처
  t = t.replace(/\b0\d{1,2}-\d{3,4}-\d{4}\b/g, "010-0000-0000");
  t = t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "user@example.com");
  // 파일 키·토큰·QR
  t = t.replace(/file_key=[^"'&\s]+/g, "file_key=MASKED");
  t = t.replace(/data:image\/png;base64,[A-Za-z0-9+/=]+/g, "data:image/png;base64,MASKED");
  t = t.replace(/(jsessionid=)[^;"'&\s]+/gi, "$1MASKED");
  // 평점·점수 (구조 유지, 실제 값 아님)
  t = t.replace(/\b[0-4]\.\d{3}\b/g, "3.500"); // 평점평균 3.775 형태
  t = t.replace(/\b\d{2}\.\d{2}\b/g, (m) => (Number(m) <= 100 ? "90.00" : m)); // 실점/평균점수 89.45 형태
  return t;
}

const FORBIDDEN = [STUDENT_ID, PASSWORD, STUDENT_NAME, ...PROFESSORS].filter((s) => s && s.length >= 2);

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (p === rawDir) continue;
      yield* walk(p);
    } else yield p;
  }
}

if (check) {
  let bad = 0;
  for (const f of walk(outDir)) {
    const s = readFileSync(f, "utf8");
    for (const w of FORBIDDEN) if (s.includes(w)) { console.error(`PII 발견: ${f}`); bad++; }
  }
  console.log(bad ? `실패: ${bad}건` : "OK: tests/fixtures/ 에 금지 문자열 없음");
  process.exit(bad ? 1 : 0);
}

if (!STUDENT_NAME) console.warn("경고: MASK_STUDENT_NAME 미지정 — 학생 이름이 마스킹되지 않습니다");
if (!PROFESSORS.length) console.warn("경고: MASK_PROFESSORS 미지정 — 교수 이름이 마스킹되지 않습니다");
let n = 0;
for (const [src, dst] of Object.entries(MAP)) {
  const from = join(rawDir, src);
  if (!existsSync(from)) { console.warn(`없음(건너뜀): ${src}`); continue; }
  const out = join(outDir, dst);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, mask(readFileSync(from, "utf8")), "utf8");
  n++;
}
console.log(`마스킹 완료: ${n}개 → tests/fixtures/`);
