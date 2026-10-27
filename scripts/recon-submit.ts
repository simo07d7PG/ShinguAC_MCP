// 과제 제출 폼(registerModal/editModal) 구조 정찰 — GET만 보낸다. 제출(insert/updateReportSubmit)은 절대 호출하지 않는다.
// 원본은 tests/fixtures/raw/submit/(gitignore)에 저장하고, 콘솔에는 폼 속성과 필드 이름·타입만 출력한다.
// 사용: npx tsx --env-file=.env scripts/recon-submit.ts <lectureSeq> <미제출 reportSeq> <제출한 reportSeq>
import { writeFileSync } from "node:fs";
import * as cheerio from "cheerio";
import { HttpClient } from "../src/http/http-client.js";
import { SessionManager } from "../src/auth/session-manager.js";
import { enterLecture } from "../src/portal/eclass.js";
import { PORTAL_ORIGIN } from "../src/portal/urls.js";

const [lectureSeq, openSeq, doneSeq] = process.argv.slice(2);
if (!lectureSeq || !openSeq || !doneSeq) throw new Error("인자 3개 필요");
const client = new HttpClient();
const session = new SessionManager({ client });
await enterLecture(session, lectureSeq);

function describe(label: string, html: string): void {
  const $ = cheerio.load(html);
  console.log(`== ${label} (len=${html.length})`);
  $("form").each((_, f) => console.log("form", JSON.stringify($(f).attr())));
  $("input, textarea, select").each((_, el) => {
    const a = $(el).attr() ?? {};
    console.log(" ", el.tagName, a.type ?? "", a.name ?? "", a.id ?? "", a.accept ?? "", a.multiple !== undefined ? "multiple" : "", a.type === "hidden" ? `value.len=${(a.value ?? "").length}` : "");
  });
  $("script").each((_, s) => {
    const t = $(s).html() ?? "";
    for (const m of t.matchAll(/url\s*:\s*["']([^"']+)["']/g)) console.log("  script url", m[1]);
  });
}

for (const [label, page, seq] of [
  ["registerModal", "registerModal", openSeq],
  ["editModal", "editModal", doneSeq],
] as const) {
  const detail = await session.request((c) => c.get(`${PORTAL_ORIGIN}/eclass/clas/room/homework/homeworkDetail?reportSeq=${seq}`));
  const reportNm = cheerio.load(detail.text)("input[name=reportNm]").attr("value") ?? "";
  const q = new URLSearchParams({ reportSeq: seq, reportNm });
  const res = await session.request((c) => c.get(`${PORTAL_ORIGIN}/eclass/clas/room/homework/${page}?${q}`));
  writeFileSync(`tests/fixtures/raw/submit/${page}_${seq}.html`, res.text);
  writeFileSync(`tests/fixtures/raw/submit/detail_${seq}.html`, detail.text);
  describe(label, res.text);
}
