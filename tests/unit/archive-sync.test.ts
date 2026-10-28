import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cheerio from "cheerio";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthRejectedError } from "../../src/auth/errors.js";
import { SessionManager } from "../../src/auth/session-manager.js";
import type { Config } from "../../src/config/config.js";
import { Secret } from "../../src/config/secret.js";
import { HttpClient } from "../../src/http/http-client.js";
import { effectiveDeadline, parseHomeworkList } from "../../src/parsers/assignments.js";
import { RequestQueue } from "../../src/queue/request-queue.js";
import { safeName } from "../../src/service/archive-sync.js";
import { CategoryService } from "../../src/service/category-service.js";
import { ArchiveDb } from "../../src/store/archive-db.js";

const NOW = new Date("2026-10-26T12:00:00+09:00");
const fixture = (name: string): string => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
const html = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "text/html;charset=UTF-8" } });
const EMPTY_HOMEWORK =
  '<table class="table-list table-center"><tbody><tr><td colspan="5">데이터가 없습니다.</td></tr></tbody></table>';
const FILE_INFO = JSON.stringify({
  fileDetails: [{ fileKey: "20261020144123-sub", oriFileNm: "보고서:최종.pdf", fileSize: 4 }],
});

interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  lecture?: string;
}

let root: string;
let db: ArchiveDb;
let requests: Recorded[];
let current: string | undefined;
let login: ReturnType<typeof vi.fn>;
/** 게시글 본문을 바꿔 다시 받는지 확인하는 데 쓴다. */
let materialDetail: string;
/** 목록의 마감·연장기한을 바꿔 증분 판정을 확인하는 데 쓴다. */
let homeworkList: string;
/** 지정하면 모든 과제 상세를 이 화면으로, 제출 폼을 editModal로 돌려준다. */
let detailOverride: string | undefined;
let editModal: string;
/** true면 시간표 화면이 503(시간표 실패가 E클래스 동기화를 막지 않는지 확인). */
let timetableDown = false;
/** 요청마다 불린다(취소 시점 지정용). */
let onRequest: ((r: Recorded) => void) | undefined;

function route(r: Recorded): Response {
  const page = r.query.get("pageIndex") ?? "1";
  switch (`${r.method} ${r.path}`) {
    case "GET /eclass/home":
      return html(fixture("eclass/home-2026-2.html"));
    case "GET /SSE/SSE013R/SSE013R":
      if (timetableDown) return new Response("down", { status: 503 });
      return html(fixture("timetable/SSE013R.html"));
    case "POST /eclass/clas/home":
      return html(fixture("eclass/clas-home.html"));
    case "GET /eclass/clas/room/homework/homeworkList":
      return html(current === "27962" ? homeworkList : EMPTY_HOMEWORK);
    case "GET /eclass/clas/room/homework/homeworkDetail":
      if (detailOverride) return html(detailOverride);
      return html(
        fixture(
          r.query.get("reportSeq") === "34757"
            ? "eclass/homework-detail-submitted.html"
            : "eclass/homework-detail-not-submitted.html",
        ),
      );
    case "GET /eclass/clas/room/homework/editModal":
      return html(editModal);
    case "GET /file/info":
      return new Response(FILE_INFO, { status: 200, headers: { "content-type": "text/plain;charset=UTF-8" } });
    case "GET /eclass/clas/board/list": {
      const board = r.query.get("boardId");
      if (board === "3" && current === "27962" && page === "1") return html(fixture("eclass/board-list-material.html"));
      if (board === "1" && current === "28153") return html(fixture("eclass/board-list-notice-filled.html"));
      return html(fixture("eclass/board-list-notice.html"));
    }
    case "GET /eclass/clas/board/detail":
      return html(r.query.get("boardId") === "3" ? materialDetail : fixture("eclass/board-detail-notice.html"));
    case "GET /01shingu/eClassDown.jsp":
      return new Response(Buffer.from(`cec:${r.query.get("file_key")}`), { status: 200 });
    case "GET /file/download":
      return new Response(Buffer.from(`sub:${r.query.get("fileKey")}`), { status: 200 });
    default:
      throw new Error(`unexpected request: ${r.method} ${r.path}`);
  }
}

function makeService(now: Date = NOW): CategoryService {
  const fetchMock = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const r: Recorded = { method, path: url.pathname, query: url.searchParams, lecture: current };
    if (method === "POST" && url.pathname === "/eclass/clas/home") {
      current = new URLSearchParams(String(init?.body)).get("lectureSeq") ?? undefined;
    }
    requests.push(r);
    onRequest?.(r);
    return route(r);
  };
  const client = new HttpClient({ fetch: fetchMock as typeof fetch, queue: new RequestQueue({ minGapMs: 0 }) });
  const loadConfig = (): Config => ({
    id: "2000000000",
    password: new Secret("pw"),
    homeDir: root,
    dbPath: join(root, "eclass.db"),
    filesDir: join(root, "files"),
  });
  const session = new SessionManager({ client, login, loadConfig });
  const logger = { debug: () => {}, info: () => {}, warn: () => {} };
  return new CategoryService({
    session,
    client,
    archive: { db, dbPath: join(root, "eclass.db"), filesDir: join(root, "files") },
    now: () => now,
    logger,
  });
}

const count = (path: string): number => requests.filter((r) => r.path === path).length;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "archive-"));
  db = new ArchiveDb(join(root, "eclass.db"));
  requests = [];
  current = undefined;
  login = vi.fn(async () => {});
  materialDetail = fixture("eclass/board-detail-material-attach.html");
  homeworkList = fixture("eclass/homework-list.html");
  detailOverride = undefined;
  editModal = fixture("eclass/homework-edit-modal.html");
  onRequest = undefined;
});

const DAY = 24 * 60 * 60 * 1000;
/** 목록 행 기준으로 아직 열려 있는(마감 없음 또는 마감+1일 전) 과제. */
const openInList = (): string[] =>
  parseHomeworkList(homeworkList)
    .filter((r) => {
      const d = effectiveDeadline(r.extendedDueAt ?? r.dueAt);
      return d === null || NOW.getTime() <= Date.parse(d) + DAY;
    })
    .map((r) => r.reportSeq);
const PAST = "UPDATE assignments SET due_at = '2026-09-01T23:59:00+09:00', extended_due_at = NULL";
/** NOW 기준 15일 전(재확인 창 밖). */
const OLD_POSTS = "UPDATE posts SET posted_at = '2026-10-11T11:59:00+09:00'";
const downloads = (): number => count("/01shingu/eClassDown.jsp") + count("/file/download");
afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});

describe("ArchiveSync 시간표", () => {
  beforeEach(() => {
    timetableDown = false;
  });

  it("동기화 때 이번 학기 시간표를 1요청으로 저장하고, 다시 하면 same", async () => {
    const service = makeService();
    const first = await service.syncArchive({ downloadFiles: false });
    expect(requests.filter((r) => r.path === "/SSE/SSE013R/SSE013R").map((r) => [r.query.get("Yy"), r.query.get("Haggi")])).toEqual([
      ["2026", "2"],
    ]);
    expect(first.timetable).toMatchObject({ status: "new" });
    const n = (first.timetable as { entries: number }).entries;
    expect(n).toBeGreaterThan(0);
    expect(db.getTimetable({ year: 2026, semester: "2" })!.entries).toHaveLength(n);
    const second = await service.syncArchive({ downloadFiles: false });
    expect(second.timetable).toEqual({ entries: n, status: "same" });
  });

  it("시간표가 실패해도 E클래스 동기화는 계속하고 경고만 남긴다(저장본 유지)", async () => {
    const service = makeService();
    await service.syncArchive({ downloadFiles: false });
    const saved = db.getTimetable({ year: 2026, semester: "2" })!;
    timetableDown = true;
    const res = await service.syncArchive({ downloadFiles: false });
    expect(res.timetable).toMatchObject({ status: "failed" });
    expect(res.warnings.some((w) => w.includes("시간표"))).toBe(true);
    expect(res.courses.map((c) => c.lectureSeq).sort()).toEqual(["27962", "28153"]);
    expect(db.getTimetable({ year: 2026, semester: "2" })).toEqual(saved);
  });
});

describe("ArchiveSync (sync_eclass)", () => {
  it("첫 동기화: 내용 있는 강의만 저장하고 과제·제출·게시글·첨부를 모두 받는다", async () => {
    const res = await makeService().syncArchive();

    expect(res.term).toBe("2026-2");
    // 4강의 중 과제·게시글이 있는 2강의(27962: 과제 30·자료실 10, 28153: 수업공지 2)
    expect(res.courses.map((c) => c.lectureSeq).sort()).toEqual(["27962", "28153"]);
    expect(res.skippedEmptyCourses).toBe(2);
    const ui = res.courses.find((c) => c.lectureSeq === "27962")!;
    expect(ui.assignments).toEqual({ total: 30, new: 30, updated: 0 });
    expect(ui.submissions).toEqual({ new: 1, updated: 0 });
    expect(ui.materials).toEqual({ total: 10, new: 10, updated: 0 });
    expect(res.courses.find((c) => c.lectureSeq === "28153")!.notices).toEqual({ total: 2, new: 2, updated: 0 });

    // 자료실 목록: 1페이지 10건 + 2페이지(빈 목록)에서 멈춤
    expect(requests.filter((r) => r.path === "/eclass/clas/board/list" && r.lecture === "27962" && r.query.get("boardId") === "3").map((r) => r.query.get("pageIndex"))).toEqual(["1", "2"]);
    // 제출한 과제(34757)만 제출 폼·첨부 목록을 읽는다
    expect(count("/eclass/clas/room/homework/editModal")).toBe(1);
    expect(count("/file/info")).toBe(1);
    // 강의 기준 요청은 해당 강의에 들어간 상태에서만
    expect(requests.filter((r) => r.path.startsWith("/eclass/clas/room/homework/homeworkDetail")).every((r) => r.lecture === "27962")).toBe(true);

    expect(db.all("SELECT COUNT(*) n FROM assignments")).toEqual([{ n: 30 }]);
    const [sub] = db.all<{ title: string; content_text: string }>("SELECT title, content_text FROM submissions WHERE report_seq = '34757'");
    expect(sub!.title).toBe("2000000000 홍길동_8주차");
    expect(sub!.content_text.length).toBeGreaterThan(0);
    const [post] = db.all<{ author: string; body_text: string; posted_at: string }>(
      "SELECT author, body_text, posted_at FROM posts WHERE lecture_seq = '27962' AND board = 'material' LIMIT 1",
    );
    expect(post).toMatchObject({ author: "이교수", posted_at: "2026-10-12T22:09:42+09:00" });

    // 첨부: 과제 30(각 1건, 제출한 과제는 2건) + 제출 1 + 자료실 10×3 + 수업공지 0
    const atts = db.all<{ owner_type: string; name: string; url: string; local_path: string | null; sha256: string }>(
      "SELECT owner_type, name, url, local_path, sha256 FROM attachments",
    );
    expect(atts.filter((a) => a.owner_type === "submission")).toEqual([
      expect.objectContaining({
        name: "보고서:최종.pdf",
        url: "https://student.shingu.ac.kr/file/download?fileKey=20261020144123-sub",
        local_path: "27962_UI화면설계/submissions/34757/보고서_최종.pdf",
      }),
    ]);
    expect(atts.filter((a) => a.owner_type === "post")).toHaveLength(30);
    expect(atts.every((a) => a.local_path !== null)).toBe(true);
    expect(res.files.failed).toBe(0);
    expect(res.files.pending).toBe(0);
    // 같은 내용(같은 file_key)의 파일은 한 번만 디스크에 둔다
    expect(res.files.downloaded).toBe(new Set(atts.map((a) => a.sha256)).size);
    expect(res.files.reused).toBe(atts.length - res.files.downloaded);
    const sub2 = join(root, "files", "27962_UI화면설계", "submissions", "34757", "보고서_최종.pdf");
    expect(readFileSync(sub2, "utf8")).toBe("sub:20261020144123-sub");
    const leftovers = (await readdir(join(root, "files"), { recursive: true })).filter((f) => String(f).endsWith(".part"));
    expect(leftovers).toEqual([]);
  });

  it("두 번째 동기화(증분): 오래된 저장 게시글과 마감 지난 과제는 다시 읽지 않는다", async () => {
    const service = makeService();
    await service.syncArchive();
    // 등록일시가 재확인 창(14일)보다 오래된 글로 바꿔 둔다.
    db.all(OLD_POSTS);
    // 픽스처 상세는 모두 같은 마감이므로, 34771·34757만 남기고 저장값을 마감 지난 과제로 바꿔 둔다.
    db.all(`${PAST} WHERE report_seq NOT IN ('34771', '34757')`);
    requests = [];

    const res = await service.syncArchive();
    expect(count("/eclass/clas/board/detail")).toBe(0);
    const reread = requests.filter((r) => r.path === "/eclass/clas/room/homework/homeworkDetail").map((r) => r.query.get("reportSeq"));
    // 저장값이 열린 2건 + 목록 값이 아직 열린 과제
    expect(new Set(reread)).toEqual(new Set(["34757", "34771", ...openInList()]));
    expect(reread.length).toBeLessThan(30);
    expect(count("/01shingu/eClassDown.jsp") + count("/file/download")).toBe(0);
    const ui = res.courses.find((c) => c.lectureSeq === "27962")!;
    expect(ui.assignments.new).toBe(0);
    expect(ui.materials.new).toBe(0);
  });

  it("마감이 지난 뒤 목록에 연장기한이 생기면 상세를 다시 읽는다", async () => {
    const service = makeService();
    await service.syncArchive({ downloadFiles: false });
    db.all(PAST);
    const $ = cheerio.load(homeworkList);
    $("tr[data-wr-id=34408] td").eq(2).find("span[data-role=date]").text("2026-10-30 00:00:00.0");
    homeworkList = $.html();
    requests = [];
    await service.syncArchive({ downloadFiles: false });
    const reread = requests.filter((r) => r.path === "/eclass/clas/room/homework/homeworkDetail").map((r) => r.query.get("reportSeq"));
    expect(reread).toContain("34408");
    expect(new Set(reread)).toEqual(new Set(openInList()));
  });

  it("마감 지나 버튼이 없는 과제는 제출 폼으로 판정: 내용이 있으면 제출로 저장, 없으면 제출 아님", async () => {
    // 모든 마감이 지난 시점, 상세는 버튼 없는 화면(기간 아님)
    const later = new Date("2027-02-20T12:00:00+09:00");
    detailOverride = fixture("eclass/homework-detail-not-open.html");
    const res = await makeService(later).syncArchive({ downloadFiles: false });
    const ui = res.courses.find((c) => c.lectureSeq === "27962")!;
    expect(count("/eclass/clas/room/homework/editModal")).toBe(30);
    expect(ui.submissions.new).toBe(30);
    expect(db.all("SELECT DISTINCT submit_status s FROM assignments")).toEqual([{ s: "submitted" }]);

    // 제출 폼이 비어 있으면(내지 않은 과제) 제출로 보지 않고 첨부 목록도 읽지 않는다
    db.close();
    db = new ArchiveDb(join(root, "eclass2.db"));
    requests = [];
    editModal = fixture("eclass/homework-edit-modal.html")
      .replace(/(name="reportTitle"[^>]*value=')[^']*'/, "$1'")
      .replace(/(<textarea[^>]*name="reportContent"[^>]*>)[\s\S]*?(<\/textarea>)/, "$1$2")
      .replace(/data-file-master-key="[^"]*"/, 'data-file-master-key=""');
    const none = await makeService(later).syncArchive({ downloadFiles: false });
    expect(none.courses.find((c) => c.lectureSeq === "27962")!.submissions.new).toBe(0);
    expect(count("/file/info")).toBe(0);
    expect(db.all("SELECT DISTINCT submit_status s FROM assignments")).toEqual([{ s: "not_open" }]);
  });

  it("full: 게시글을 다시 읽어 바뀐 본문을 갱신한다", async () => {
    const service = makeService();
    await service.syncArchive();
    materialDetail = materialDetail.replace(/(<div[^>]*min-height[^>]*>)/, "$1 수정된 안내");
    const res = await service.syncArchive({ full: true, downloadFiles: false });
    expect(res.courses.find((c) => c.lectureSeq === "27962")!.materials.updated).toBe(10);
    const [post] = db.all<{ body_text: string }>("SELECT body_text FROM posts WHERE board = 'material' LIMIT 1");
    expect(post!.body_text).toContain("수정된 안내");
  });

  it("download_files=false: 첨부는 링크만 저장하고 pending으로 남긴다", async () => {
    const res = await makeService().syncArchive({ downloadFiles: false });
    expect(count("/01shingu/eClassDown.jsp")).toBe(0);
    expect(res.files.pending).toBe(db.all("SELECT COUNT(*) n FROM attachments")[0]!["n"]);
    expect(existsSync(join(root, "files"))).toBe(false);
  });

  it("동기화 뒤에는 lecture_seq 없이도 DB에서 강의를 찾는다", async () => {
    const service = makeService();
    await service.syncArchive({ downloadFiles: false });
    requests = [];
    const res = await service.getAssignment({ reportSeq: "34771" });
    expect(res.data.lectureSeq).toBe("27962");
    expect(res.data.courseName).toBe("UI화면설계");
  });

  it("자격증명 오류는 과목 단위로 삼키지 않고 동기화를 멈춘다", async () => {
    login = vi.fn(async () => {
      throw new AuthRejectedError();
    });
    await expect(makeService().syncArchive()).rejects.toBeInstanceOf(AuthRejectedError);
  });

  it("아카이브가 없으면 이유를 담아 실패", async () => {
    const svc = new CategoryService({
      session: new SessionManager({ client: new HttpClient(), login, loadConfig: () => { throw new Error("x"); } }),
      client: new HttpClient(),
      archiveError: "E클래스 아카이브 DB를 열지 못했습니다: locked",
    });
    await expect(svc.syncArchive()).rejects.toThrow(/locked/);
  });
});

describe("ArchiveSync 게시글 재확인(R9)", () => {
  it("14일 안의 같은 글을 두 번 동기화하면 다시 읽지만 updated 0, 재다운로드 없음", async () => {
    const service = makeService();
    await service.syncArchive();
    requests = [];
    const res = await service.syncArchive();
    // 자료실 10건은 2026-10-12 등록(NOW 기준 14일 안) → 다시 읽는다
    expect(requests.filter((r) => r.path === "/eclass/clas/board/detail" && r.query.get("boardId") === "3")).toHaveLength(10);
    const ui = res.courses.find((c) => c.lectureSeq === "27962")!;
    expect(ui.materials).toEqual({ total: 10, new: 0, updated: 0 });
    expect(downloads()).toBe(0);
    expect(res.files).toEqual({ downloaded: 0, reused: 0, failed: 0, pending: 0 });
  });

  it("14일 안의 글만 다시 읽고, 바뀌었으면 갱신한다", async () => {
    const service = makeService();
    await service.syncArchive({ downloadFiles: false });
    const old = db
      .all<{ wr_id: string }>("SELECT wr_id FROM posts WHERE board = 'material' ORDER BY wr_id LIMIT 5")
      .map((r) => r.wr_id);
    db.all(`${OLD_POSTS} WHERE board = 'material' AND wr_id IN (${old.map((w) => `'${w}'`).join(", ")})`);
    materialDetail = materialDetail.replace(/(<div[^>]*min-height[^>]*>)/, "$1 수정된 안내");
    requests = [];
    const res = await service.syncArchive({ downloadFiles: false });
    const reread = requests
      .filter((r) => r.path === "/eclass/clas/board/detail" && r.query.get("boardId") === "3")
      .map((r) => r.query.get("wrId")!);
    expect(reread).toHaveLength(5);
    expect(reread.some((w) => old.includes(w))).toBe(false);
    expect(res.courses.find((c) => c.lectureSeq === "27962")!.materials.updated).toBe(5);
  });
  it("첨부만 바뀐 글도 updated로 센다", async () => {
    const service = makeService();
    await service.syncArchive({ downloadFiles: false });
    materialDetail = materialDetail.replaceAll("file_key=MASKED", "file_key=CHANGED");
    const res = await service.syncArchive({ downloadFiles: false });
    expect(res.courses.find((c) => c.lectureSeq === "27962")!.materials).toEqual({ total: 10, new: 0, updated: 10 });
    expect(db.all("SELECT COUNT(*) AS n FROM attachments WHERE url LIKE '%CHANGED%'")).not.toEqual([{ n: 0 }]);
  });
});

describe("ArchiveSync 취소·진행률(R6)", () => {
  it("과제 상세를 읽는 중 취소: cancelled, 실패 기록 없음, 읽은 것은 남는다", async () => {
    const ac = new AbortController();
    let details = 0;
    onRequest = (r) => {
      if (r.path === "/eclass/clas/room/homework/homeworkDetail" && ++details === 3) ac.abort();
    };
    const res = await makeService().syncArchive({ signal: ac.signal });
    expect(res.cancelled).toBe(true);
    expect(res.courses.every((c) => c.error === undefined)).toBe(true);
    // 진행 중이던 3번째 상세까지 저장하고 다음 과제 전에 멈춘다
    expect(db.all("SELECT COUNT(*) n FROM assignments")).toEqual([{ n: 3 }]);
    expect(count("/eclass/clas/room/homework/homeworkDetail")).toBe(3);
    // 취소된 강의의 게시글은 읽지 않고, 그 뒤로는 포털 요청이 없다(앞선 강의는 끝까지 저장)
    expect(requests.filter((r) => r.path === "/eclass/clas/board/detail" && r.lecture === "27962")).toHaveLength(0);
    expect(requests.at(-1)!.path).toBe("/eclass/clas/room/homework/homeworkDetail");
    expect(downloads()).toBe(0);
    expect(db.all("SELECT COUNT(*) n FROM attachments WHERE error IS NOT NULL")).toEqual([{ n: 0 }]);
  });

  it("첨부를 받는 중 취소: cancelled, 실패로 표시하지 않고 남은 첨부는 pending", async () => {
    const ac = new AbortController();
    onRequest = (r) => {
      if (r.path === "/01shingu/eClassDown.jsp" && count("/01shingu/eClassDown.jsp") === 2) ac.abort();
    };
    const res = await makeService().syncArchive({ signal: ac.signal });
    expect(res.cancelled).toBe(true);
    expect(res.files.failed).toBe(0);
    expect(res.files.downloaded).toBe(1);
    expect(res.files.pending).toBeGreaterThan(0);
    expect(downloads()).toBe(2);
    expect(res.courses.map((c) => c.lectureSeq).sort()).toEqual(["27962", "28153"]);
    expect(db.all("SELECT COUNT(*) n FROM attachments WHERE error IS NOT NULL")).toEqual([{ n: 0 }]);
    const leftovers = (await readdir(join(root, "files"), { recursive: true })).filter((f) => String(f).endsWith(".part"));
    expect(leftovers).toEqual([]);
  });

  it("이미 취소된 signal이면 포털에 요청하지 않는다", async () => {
    const ac = new AbortController();
    ac.abort();
    const res = await makeService().syncArchive({ signal: ac.signal });
    expect(res.cancelled).toBe(true);
    expect(requests).toEqual([]);
  });

  it("진행률은 하나의 누적 카운터: progress는 알림마다 늘고 total ≥ progress, 끝나면 progress = total", async () => {
    const events: Array<{ progress: number; total: number; message: string }> = [];
    const res = await makeService().syncArchive({ onProgress: (p) => events.push(p) });
    expect(res.cancelled).toBeUndefined();
    expect(events.length).toBeGreaterThan(4);
    for (let i = 0; i < events.length; i++) {
      expect(events[i]!.total).toBeGreaterThanOrEqual(events[i]!.progress);
      if (i > 0) {
        expect(events[i]!.progress).toBeGreaterThan(events[i - 1]!.progress);
        expect(events[i]!.total).toBeGreaterThanOrEqual(events[i - 1]!.total);
      }
    }
    const atts = (db.all("SELECT COUNT(*) n FROM attachments")[0] as { n: number }).n;
    const last = events.at(-1)!;
    // 강의 4개 + 첨부 수
    expect(last).toMatchObject({ progress: 4 + atts, total: 4 + atts });
  });

  it("시작할 때 이전 다운로드가 남긴 오래된 임시 파일만 지운다(최근 임시 파일·.part로 끝나는 정상 첨부는 유지)", async () => {
    const dir = join(root, "files", "27962_UI화면설계", "materials", "1");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a.pdf.123.0a1b2c3d.part"), "x");
    const old = new Date(Date.now() - 11 * 60 * 1000);
    await utimes(join(dir, "a.pdf.123.0a1b2c3d.part"), old, old);
    // 다른 인스턴스가 내려받는 중일 수 있는 최근 임시 파일
    await writeFile(join(dir, "b.pdf.456.0a1b2c3e.part"), "w");
    await writeFile(join(dir, "keep.pdf"), "y");
    await writeFile(join(dir, "data.part"), "z");
    await makeService().syncArchive({ downloadFiles: false });
    expect(existsSync(join(dir, "a.pdf.123.0a1b2c3d.part"))).toBe(false);
    expect(existsSync(join(dir, "b.pdf.456.0a1b2c3e.part"))).toBe(true);
    expect(existsSync(join(dir, "keep.pdf"))).toBe(true);
    expect(existsSync(join(dir, "data.part"))).toBe(true);
  });
});

describe("safeName", () => {
  it("Windows 금지 문자·예약 이름·끝 점·긴 이름", () => {
    expect(safeName('a<b>:c"d/e\\f|g?h*.pdf')).toBe("a_b__c_d_e_f_g_h_.pdf");
    expect(safeName("CON.txt")).toBe("_CON.txt");
    expect(safeName("보고서.. ")).toBe("보고서");
    expect(safeName("..")).toBe("file");
    const long = safeName(`${"가".repeat(200)}.pptx`);
    expect(long.length).toBe(120);
    expect(long.endsWith(".pptx")).toBe(true);
    // 자른 자리가 점·공백이면 다시 지운다(확장자 없는 긴 이름)
    expect(safeName(`${"a".repeat(119)}. bcdefghijklmnopqrstu`)).not.toMatch(/[. ]$/);
    expect(safeName("CONOUT$")).toBe("_CONOUT$");
  });
});
