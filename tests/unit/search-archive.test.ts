import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { searchArchive, type ArchiveSearchInput } from "../../src/service/archive-search.js";
import { ArchiveDb, type AssignmentRow, type PostRow } from "../../src/store/archive-db.js";

const T = "2026-10-26T12:00:00+09:00";
const FILES = resolve("/tmp/shingu-files");
let db: ArchiveDb;

const assignment = (over: Partial<AssignmentRow> = {}): AssignmentRow => ({
  reportSeq: "10",
  lectureSeq: "1",
  title: "과제 1",
  startAt: null,
  dueAt: "2026-10-30T23:59:00+09:00",
  extendedDueAt: null,
  penaltyNote: null,
  contentHtml: "<p>내용</p>",
  contentText: "내용",
  submitStatus: "not_submitted",
  ...over,
});

const post = (over: Partial<PostRow> = {}): PostRow => ({
  lectureSeq: "1",
  board: "notice",
  wrId: "1",
  title: "공지",
  postedAt: "2026-10-01T09:00:00+09:00",
  author: "김교수",
  bodyHtml: "<p>본문</p>",
  bodyText: "본문",
  ...over,
});

const search = (input: Partial<ArchiveSearchInput> = {}) => searchArchive(db, FILES, { kind: "assignments", limit: 20, ...input });
const seqs = (input: Partial<ArchiveSearchInput>) => search(input).items.map((x) => (x as { reportSeq: string }).reportSeq);

/** 첨부를 내려받은 상태로 만든다. */
function markDone(position: number, localPath: string): void {
  const [row] = db.all<{ id: number }>("SELECT id FROM attachments WHERE position = ? ORDER BY id DESC", position);
  db.markDownloaded(row!.id, { localPath, size: 1, sha256: `h${row!.id}`, downloadedAt: T });
}

beforeEach(() => {
  db = new ArchiveDb(":memory:");
});
afterEach(() => db.close());

describe("search_archive: 빈 아카이브", () => {
  it("courses가 없으면 안내 note와 빈 결과", () => {
    expect(search()).toEqual({
      kind: "assignments",
      total: 0,
      items: [],
      note: "아카이브가 비어 있습니다. 먼저 sync_eclass를 실행하세요.",
    });
    expect(search({ kind: "posts" }).note).toContain("sync_eclass");
  });
});

describe("search_archive: assignments", () => {
  beforeEach(() => {
    db.upsertCourse({ lectureSeq: "1", courseName: "자료구조", year: 2026, semester: "2" }, T);
    db.upsertCourse({ lectureSeq: "2", courseName: "Network Basics", year: 2026, semester: "2" }, T);
    db.upsertAssignment(assignment({ reportSeq: "10", title: "연결 리스트" }), T);
    db.upsertAssignment(
      assignment({
        reportSeq: "11",
        title: "트리",
        dueAt: "2026-10-20T23:59:00+09:00",
        extendedDueAt: "2026-11-05T23:59:00+09:00",
        submitStatus: "submitted",
        contentText: "이진 트리 구현",
      }),
      T,
    );
    db.upsertAssignment(assignment({ reportSeq: "12", lectureSeq: "2", title: "Socket Lab", dueAt: null, submitStatus: "not_open" }), T);
    db.upsertAssignment(assignment({ reportSeq: "13", lectureSeq: "2", title: "Early", dueAt: "2026-10-10T23:59:00+09:00" }), T);
  });

  it("마감(연장 우선) 오름차순, 마감 없음은 뒤", () => {
    expect(seqs({})).toEqual(["13", "10", "11", "12"]);
  });

  it("course 부분 일치(대소문자 무시)·query(제목/본문)·status", () => {
    expect(search({ course: "network" }).total).toBe(2);
    expect(search({ query: "socket" }).total).toBe(1);
    expect(search({ query: "이진" }).items).toHaveLength(1);
    expect(seqs({ status: "submitted" })).toEqual(["11"]);
    expect(search({ course: "자료", status: "not_submitted" }).total).toBe(1);
  });

  it("due_from/due_to는 연장기한 우선이며 due_to는 당일 끝까지 포함", () => {
    // 11번: 원래 마감 10-20이지만 연장 11-05 기준으로 비교한다.
    expect(seqs({ dueFrom: "2026-11-01" })).toEqual(["11"]);
    expect(seqs({ dueTo: "2026-10-25" })).toEqual(["13"]);
    expect(seqs({ dueFrom: "2026-10-30", dueTo: "2026-10-30" })).toEqual(["10"]);
    expect(seqs({ dueTo: "2026-10-29" })).toEqual(["13"]);
    // 마감 없는 과제는 범위 필터에서 제외된다.
    expect(seqs({ dueFrom: "2000-01-01" })).not.toContain("12");
  });

  it("LIKE 와일드카드를 이스케이프하고 SQL 주입은 문자열로만 취급", () => {
    expect(search({ query: "%" }).total).toBe(0);
    expect(search({ query: "_" }).total).toBe(0);
    expect(search({ query: "\\" }).total).toBe(0);
    db.upsertAssignment(assignment({ reportSeq: "20", title: "100% 완성_v2" }), T);
    expect(search({ query: "100%" }).total).toBe(1);
    expect(search({ query: "%_v" }).total).toBe(0);
    expect(search({ query: "'; DROP TABLE assignments; --" }).total).toBe(0);
    expect(search().total).toBe(5);
  });

  it("limit은 결과만 자르고 total은 전체 건수", () => {
    const r = search({ limit: 2 });
    expect(r.items).toHaveLength(2);
    expect(r.total).toBe(4);
  });

  it("본문 발췌는 300자까지", () => {
    db.upsertAssignment(assignment({ reportSeq: "30", contentText: "가".repeat(500) }), T);
    const item = search({ query: "가가가" }).items[0] as { contentExcerpt: string };
    expect(item.contentExcerpt).toHaveLength(300);
  });

  it("첨부: url·error 없이 name·절대 localPath·downloaded, 내 제출 포함", () => {
    db.replaceAttachments("assignment", "10", "1", [
      { name: "a.pdf", url: "https://x/secret-file-key" },
      { name: "b.pdf", url: "https://x/secret-2" },
    ]);
    markDone(0, "자료구조/a.pdf");
    db.markDownloadFailed(db.all<{ id: number }>("SELECT id FROM attachments WHERE position = 1")[0]!.id, "boom");
    db.upsertSubmission({ reportSeq: "10", title: "내 제출", contentHtml: "<p>x</p>", contentText: "제출 내용" }, T);
    db.replaceAttachments("submission", "10", "1", [{ name: "my.zip", url: "https://x/secret-3" }]);

    const r = search({ query: "연결" });
    const item = r.items[0] as { attachments: unknown[]; submission?: unknown };
    expect(item.attachments).toEqual([
      { name: "a.pdf", localPath: join(FILES, "자료구조", "a.pdf"), downloaded: true },
      { name: "b.pdf", localPath: null, downloaded: false },
    ]);
    expect(item.submission).toEqual({
      title: "내 제출",
      contentExcerpt: "제출 내용",
      attachments: [{ name: "my.zip", localPath: null, downloaded: false }],
    });
    const json = JSON.stringify(r);
    expect(json).not.toContain("secret");
    expect(json).not.toContain("boom");
    expect(json).not.toContain('"url"');
    // 제출이 없는 과제에는 submission 키가 없다.
    expect("submission" in (search({ query: "Early" }).items[0] as object)).toBe(false);
  });

  it("files 디렉터리 밖으로 나가는 경로는 localPath null", () => {
    db.replaceAttachments("assignment", "10", "1", [{ name: "evil", url: "u" }]);
    markDone(0, "../../etc/passwd");
    const item = search({ query: "연결" }).items[0] as { attachments: { localPath: string | null; downloaded: boolean }[] };
    expect(item.attachments[0]).toMatchObject({ localPath: null, downloaded: false });
  });
});

describe("search_archive: posts", () => {
  beforeEach(() => {
    db.upsertCourse({ lectureSeq: "1", courseName: "자료구조", year: 2026, semester: "2" }, T);
    db.upsertCourse({ lectureSeq: "2", courseName: "운영체제", year: 2026, semester: "2" }, T);
    db.upsertPost(post({ wrId: "1", title: "중간고사 안내" }), T);
    db.upsertPost(
      post({ wrId: "2", board: "material", title: "강의자료 3주차", bodyText: "슬라이드 첨부", postedAt: "2026-10-10T09:00:00+09:00" }),
      T,
    );
    db.upsertPost(post({ lectureSeq: "2", wrId: "1", title: "OS 공지", postedAt: "2026-10-20T09:00:00+09:00" }), T);
    db.upsertPost(post({ wrId: "3", title: "날짜 없음", postedAt: null }), T);
  });

  it("등록일시 내림차순", () => {
    const r = search({ kind: "posts" });
    expect(r.total).toBe(4);
    expect(r.items.map((i) => (i as { title: string }).title)).toEqual(["OS 공지", "강의자료 3주차", "중간고사 안내", "날짜 없음"]);
  });

  it("board·course·query 필터와 와일드카드 이스케이프", () => {
    expect(search({ kind: "posts", board: "material" }).total).toBe(1);
    expect(search({ kind: "posts", course: "운영" }).total).toBe(1);
    expect(search({ kind: "posts", query: "슬라이드" }).total).toBe(1);
    expect(search({ kind: "posts", query: "%" }).total).toBe(0);
  });

  it("항목 필드와 첨부", () => {
    db.replaceAttachments("post", "1:material:2", "1", [{ name: "w3.pdf", url: "https://x/key" }]);
    markDone(0, "자료구조/w3.pdf");
    const r = search({ kind: "posts", board: "material", limit: 1 });
    expect(r.items[0]).toEqual({
      lectureSeq: "1",
      courseName: "자료구조",
      board: "material",
      wrId: "2",
      title: "강의자료 3주차",
      postedAt: "2026-10-10T09:00:00+09:00",
      author: "김교수",
      bodyExcerpt: "슬라이드 첨부",
      attachments: [{ name: "w3.pdf", localPath: join(FILES, "자료구조", "w3.pdf"), downloaded: true }],
    });
  });
});
