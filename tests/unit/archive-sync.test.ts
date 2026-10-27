import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthRejectedError } from "../../src/auth/errors.js";
import { SessionManager } from "../../src/auth/session-manager.js";
import type { Config } from "../../src/config/config.js";
import { Secret } from "../../src/config/secret.js";
import { HttpClient } from "../../src/http/http-client.js";
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

function route(r: Recorded): Response {
  const page = r.query.get("pageIndex") ?? "1";
  switch (`${r.method} ${r.path}`) {
    case "GET /eclass/home":
      return html(fixture("eclass/home-2026-2.html"));
    case "POST /eclass/clas/home":
      return html(fixture("eclass/clas-home.html"));
    case "GET /eclass/clas/room/homework/homeworkList":
      return html(current === "27962" ? fixture("eclass/homework-list.html") : EMPTY_HOMEWORK);
    case "GET /eclass/clas/room/homework/homeworkDetail":
      return html(
        fixture(
          r.query.get("reportSeq") === "34757"
            ? "eclass/homework-detail-submitted.html"
            : "eclass/homework-detail-not-submitted.html",
        ),
      );
    case "GET /eclass/clas/room/homework/editModal":
      return html(fixture("eclass/homework-edit-modal.html"));
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

function makeService(): CategoryService {
  const fetchMock = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const r: Recorded = { method, path: url.pathname, query: url.searchParams, lecture: current };
    if (method === "POST" && url.pathname === "/eclass/clas/home") {
      current = new URLSearchParams(String(init?.body)).get("lectureSeq") ?? undefined;
    }
    requests.push(r);
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
    now: () => NOW,
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
});
afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
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

  it("두 번째 동기화(증분): 저장된 게시글과 마감 지난 과제는 다시 읽지 않는다", async () => {
    const service = makeService();
    await service.syncArchive();
    // 픽스처 상세는 모두 같은 마감이므로, 34771·34757만 남기고 마감이 지난 과제로 바꿔 둔다.
    db.all("UPDATE assignments SET due_at = '2026-09-01T23:59:00+09:00', extended_due_at = NULL WHERE report_seq NOT IN ('34771', '34757')");
    requests = [];

    const res = await service.syncArchive();
    expect(count("/eclass/clas/board/detail")).toBe(0);
    expect(
      requests.filter((r) => r.path === "/eclass/clas/room/homework/homeworkDetail").map((r) => r.query.get("reportSeq")).sort(),
    ).toEqual(["34757", "34771"]);
    expect(count("/01shingu/eClassDown.jsp") + count("/file/download")).toBe(0);
    const ui = res.courses.find((c) => c.lectureSeq === "27962")!;
    expect(ui.assignments.new).toBe(0);
    expect(ui.materials.new).toBe(0);
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

describe("safeName", () => {
  it("Windows 금지 문자·예약 이름·끝 점·긴 이름", () => {
    expect(safeName('a<b>:c"d/e\\f|g?h*.pdf')).toBe("a_b__c_d_e_f_g_h_.pdf");
    expect(safeName("CON.txt")).toBe("_CON.txt");
    expect(safeName("보고서.. ")).toBe("보고서");
    expect(safeName("..")).toBe("file");
    const long = safeName(`${"가".repeat(200)}.pptx`);
    expect(long.length).toBe(120);
    expect(long.endsWith(".pptx")).toBe(true);
  });
});
