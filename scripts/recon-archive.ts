// E클래스 아카이브용 정찰 — GET(+강의 진입 POST)만 보낸다. 제출·업로드·삭제 요청은 보내지 않는다.
// 수업공지(boardId=1)·자료실(boardId=3) 목록/본문 첨부 영역, 목록 페이지 이동, 첨부 다운로드 응답 헤더,
// 제출한 과제의 첨부(/file/info → /file/download) 경로를 확인한다.
// 원본은 tests/fixtures/raw/archive/(gitignore)에 저장하고, 콘솔에는 건수·속성·헤더만 출력한다.
// 사용: npx tsx --env-file=.env scripts/recon-archive.ts
import { mkdirSync, writeFileSync } from "node:fs";
import * as cheerio from "cheerio";
import { DEFAULT_ALLOWED_HOSTS, HttpClient, type HttpResponse } from "../src/http/http-client.js";
import { SessionManager } from "../src/auth/session-manager.js";
import { parseHomeworkDetail, parseHomeworkList } from "../src/parsers/assignments.js";
import { parseFileInfo, parseSubmitControls, parseSubmitForm } from "../src/parsers/submit.js";
import { enterLecture, fetchEclassHome } from "../src/portal/eclass.js";
import { currentAcademicTerm } from "../src/portal/semester.js";
import { PORTAL_ORIGIN } from "../src/portal/urls.js";

const OUT = "tests/fixtures/raw/archive";
mkdirSync(OUT, { recursive: true });
const CLAS = `${PORTAL_ORIGIN}/eclass/clas`;
const allowedHosts = [...DEFAULT_ALLOWED_HOSTS, "cec.shingu.ac.kr"];
const client = new HttpClient({ allowedHosts });
const session = new SessionManager({ client });
const get = (url: string): Promise<HttpResponse> => session.request((c) => c.get(url));

function headers(label: string, res: HttpResponse): void {
  const h = res.headers;
  console.log(`  [${label}] status=${res.status} type=${h.get("content-type")} len=${h.get("content-length")} ` +
    // 파일명에 학번·이름이 들어 있을 수 있어 형식만 출력한다.
    `disp=${(h.get("content-disposition") ?? "-").replace(/(filename\*?=)[^;]*/gi, "$1…")} final=${new URL(res.finalUrl).pathname} hops=${res.redirectChain.length}`);
}

/** 첨부·파일 관련 요소를 속성만 출력한다(텍스트는 길이만). */
function fileHints(label: string, html: string): void {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  $("a[href], a[onclick], button[onclick], [data-file-master-key], [data-role=fileUploader], [data-role=fileViewer], input[name*=ile]").each((_, el) => {
    const a = $(el).attr() ?? {};
    const href = a.href ?? "";
    const onclick = a.onclick ?? "";
    if (!/down|file/i.test(href + onclick + JSON.stringify(a)) || /\/file\/download\?fileKey=$/.test(href)) return;
    const shape = JSON.stringify({
      tag: el.tagName,
      href: href.replace(/=[^&]+/g, "=…"),
      onclick: onclick.replace(/'[^']*'/g, "'…'"),
      data: Object.keys(a).filter((k) => k.startsWith("data-")),
      name: a.name,
      textLen: $(el).text().trim().length,
    });
    if (!seen.has(shape)) {
      seen.add(shape);
      console.log(`  ${label} file-el ${shape}`);
    }
  });
  $("script").each((_, s) => {
    const t = $(s).html() ?? "";
    for (const m of t.matchAll(/["'](\/[a-zA-Z/]*(?:file|down)[a-zA-Z/]*)[?"']/gi)) console.log(`  ${label} script-url ${m[1]}`);
  });
}

function boardRows(html: string): { wrId: string; hasAttach: boolean }[] {
  const $ = cheerio.load(html);
  return $("tr[data-wr-id]")
    .map((_, tr) => {
      const tds = $(tr).find("td");
      // th=[No|제목|첨부|등록일시|작성자|조회]
      const attachTd = tds.eq(2);
      return { wrId: $(tr).attr("data-wr-id")!, hasAttach: attachTd.find("i, img, a, span").length > 0 || attachTd.text().trim() !== "" };
    })
    .get();
}

function paging(html: string): string {
  const $ = cheerio.load(html);
  const total = /Total\s*(\d+)/.exec($.text())?.[1];
  const pages = /(\d+)\s*\/\s*(\d+)\s*Page/.exec($.text());
  const sizes = $("select[name=pageSize] option").map((_, o) => $(o).attr("value")).get().join(",");
  return `total=${total} page=${pages?.[1]}/${pages?.[2]} pageSize options=[${sizes}] selected=${$("select[name=pageSize] option[selected]").attr("value")}`;
}

const lectures = await fetchEclassHome(session, currentAcademicTerm(new Date()));
console.log(`lectures=${lectures.length}`);
let downloadedHomeworkAttach = false;
let checkedSubmission = false;
const boardDetailDone: Record<string, number> = { "1": 0, "3": 0 };

for (const [li, lecture] of lectures.entries()) {
  await enterLecture(session, lecture.lectureSeq);
  console.log(`\n# lecture#${li} seq=${lecture.lectureSeq}`);

  for (const boardId of ["1", "3"]) {
    const list = await get(`${CLAS}/board/list?boardId=${boardId}`);
    writeFileSync(`${OUT}/board-list-${boardId}-L${li}.html`, list.text);
    const rows = boardRows(list.text);
    console.log(`  board ${boardId}: rows=${rows.length} withAttach=${rows.filter((r) => r.hasAttach).length} ${paging(list.text)}`);
    if (rows.length >= 10 || /\d+\s*\/\s*([2-9]|\d{2,})\s*Page/.test(list.text)) {
      const p2 = await get(`${CLAS}/board/list?boardId=${boardId}&pageIndex=2`);
      writeFileSync(`${OUT}/board-list-${boardId}-L${li}-p2.html`, p2.text);
      console.log(`  board ${boardId} pageIndex=2: rows=${boardRows(p2.text).length} ${paging(p2.text)}`);
    }
    // 첨부 있는 글 우선, 게시판마다 최대 2건 본문 확인
    const picks = [...rows.filter((r) => r.hasAttach), ...rows.filter((r) => !r.hasAttach)].slice(0, 2 - Math.min(2, boardDetailDone[boardId]!));
    for (const r of picks) {
      const d = await get(`${CLAS}/board/detail?boardId=${boardId}&wrId=${r.wrId}`);
      writeFileSync(`${OUT}/board-detail-${boardId}-L${li}-${r.wrId}.html`, d.text);
      console.log(`  board ${boardId} detail wr…${r.wrId.slice(-4)} hasAttach(list)=${r.hasAttach} len=${d.text.length}`);
      fileHints(`b${boardId}`, d.text);
      boardDetailDone[boardId]!++;
    }
  }

  const hwList = parseHomeworkList((await get(`${CLAS}/room/homework/homeworkList`)).text);
  console.log(`  homework rows=${hwList.length}`);
  for (const row of hwList) {
    if (downloadedHomeworkAttach && checkedSubmission) break;
    const detailHtml = (await get(`${CLAS}/room/homework/homeworkDetail?reportSeq=${row.reportSeq}`)).text;
    const detail = parseHomeworkDetail(detailHtml);
    if (!downloadedHomeworkAttach && detail.attachments.length > 0) {
      writeFileSync(`${OUT}/homework-detail-${row.reportSeq}.html`, detailHtml);
      const url = detail.attachments[0]!.url;
      console.log(`  homework attach host=${new URL(url).host} path=${new URL(url).pathname}`);
      headers("eClassDown with session", await session.request((c) => c.get(url)));
      headers("eClassDown no cookies", await new HttpClient({ allowedHosts }).get(url));
      downloadedHomeworkAttach = true;
    }
    if (!checkedSubmission && detail.submitStatus === "submitted") {
      const controls = parseSubmitControls(detailHtml);
      const q = new URLSearchParams({ reportSeq: row.reportSeq, reportNm: controls.reportNm });
      const modal = await get(`${CLAS}/room/homework/editModal?${q}`);
      writeFileSync(`${OUT}/edit-modal-${row.reportSeq}.html`, modal.text);
      const form = parseSubmitForm(modal.text, "updateForm");
      console.log(`  submission title.len=${form.title.length} content.len=${form.contentHtml.length} masterKey=${form.attach.fileMasterKey ? "yes" : "no"}`);
      fileHints("edit", modal.text);
      if (form.attach.fileMasterKey) {
        const info = await get(`${PORTAL_ORIGIN}/file/info?fileMasterKey=${encodeURIComponent(form.attach.fileMasterKey)}`);
        const files = parseFileInfo(info.text);
        console.log(`  submission files=${files.length} keys=${files[0] ? Object.keys(files[0]).join(",") : "-"}`);
        if (files[0]) {
          const key = String(files[0]["fileKey"]);
          headers("file/download with session", await get(`${PORTAL_ORIGIN}/file/download?fileKey=${encodeURIComponent(key)}`));
          headers("file/download no cookies", await new HttpClient().get(`${PORTAL_ORIGIN}/file/download?fileKey=${encodeURIComponent(key)}`));
          checkedSubmission = true;
        }
      }
    }
  }
}
console.log(`\nraw saved under ${OUT}`);
