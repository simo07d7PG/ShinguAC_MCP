import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArchiveDb, type AssignmentRow } from "../../src/store/archive-db.js";

const T = "2026-10-26T12:00:00+09:00";
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

beforeEach(() => {
  db = new ArchiveDb(":memory:");
  db.upsertCourse({ lectureSeq: "1", courseName: "자료구조", year: 2026, semester: "2" }, T);
});
afterEach(() => db.close());

describe("ArchiveDb", () => {
  it("과제 upsert: new → same → updated, 강의 역조회", () => {
    expect(db.upsertAssignment(assignment(), T)).toBe("new");
    expect(db.upsertAssignment(assignment(), T)).toBe("same");
    expect(db.upsertAssignment(assignment({ submitStatus: "submitted" }), T)).toBe("updated");
    expect(db.getAssignmentState("10")).toEqual({
      dueAt: "2026-10-30T23:59:00+09:00",
      extendedDueAt: null,
      submitStatus: "submitted",
    });
    expect(db.findAssignmentLecture("10")).toEqual({ lectureSeq: "1", courseName: "자료구조", title: "과제 1" });
    expect(db.findAssignmentLecture("99")).toBeUndefined();
  });

  it("없는 강의를 가리키는 과제는 외래키로 거부", () => {
    expect(() => db.upsertAssignment(assignment({ lectureSeq: "404" }), T)).toThrow(/FOREIGN KEY/);
  });

  it("제출·게시글 upsert와 존재 확인", () => {
    db.upsertAssignment(assignment(), T);
    expect(db.hasSubmission("10")).toBe(false);
    expect(db.upsertSubmission({ reportSeq: "10", title: "t", contentHtml: "<p>a</p>", contentText: "a" }, T)).toBe("new");
    expect(db.upsertSubmission({ reportSeq: "10", title: "t", contentHtml: "<p>b</p>", contentText: "b" }, T)).toBe("updated");
    expect(db.hasSubmission("10")).toBe(true);

    const post = { lectureSeq: "1", board: "material" as const, wrId: "001", title: "자료", postedAt: T, author: "김교수", bodyHtml: "<p>x</p>", bodyText: "x" };
    expect(db.hasPost("1", "material", "001")).toBe(false);
    expect(db.upsertPost(post, T)).toBe("new");
    expect(db.upsertPost(post, T)).toBe("same");
    expect(db.hasPost("1", "material", "001")).toBe(true);
    expect(db.hasPost("1", "notice", "001")).toBe(false);
  });

  it("첨부 맞추기: 같은 것은 다운로드 기록 유지, 바뀐 것은 다시 받기, 사라진 것은 삭제", () => {
    const a = { name: "a.pdf", url: "https://cec.shingu.ac.kr/x?file_key=a" };
    const b = { name: "b.pdf", url: "https://cec.shingu.ac.kr/x?file_key=b" };
    db.replaceAttachments("post", "1:material:001", "1", [a, b]);
    const [first, second] = db.pendingAttachments();
    expect(first).toMatchObject({ ownerType: "post", ownerKey: "1:material:001", courseName: "자료구조", name: "a.pdf" });
    db.markDownloaded(first!.id, { localPath: "c/a.pdf", size: 3, sha256: "s1", downloadedAt: T });
    db.markDownloadFailed(second!.id, "NetworkError: x");
    expect(db.pendingAttachments().map((p) => p.name)).toEqual(["b.pdf"]);
    expect(db.findDownloadedBySha("s1")).toBe("c/a.pdf");
    expect(db.isPathTaken("c/a.pdf", second!.id)).toBe(true);
    expect(db.isPathTaken("c/a.pdf", first!.id)).toBe(false);

    // a는 그대로, 두 번째 자리는 c로 바뀜 → a 기록 유지, c는 미다운로드
    const c = { name: "c.pdf", url: "https://cec.shingu.ac.kr/x?file_key=c" };
    db.replaceAttachments("post", "1:material:001", "1", [a, c]);
    expect(db.pendingAttachments().map((p) => p.name)).toEqual(["c.pdf"]);
    db.replaceAttachments("post", "1:material:001", "1", [a]);
    expect(db.all("SELECT name, local_path FROM attachments ORDER BY position")).toEqual([{ name: "a.pdf", local_path: "c/a.pdf" }]);
  });

  it("파일 DB: 다시 열면 스키마 버전을 유지하고 데이터가 남는다", async () => {
    const dir = await mkdtemp(join(tmpdir(), "archive-db-"));
    try {
      const path = join(dir, "sub", "eclass.db");
      const first = new ArchiveDb(path);
      first.upsertCourse({ lectureSeq: "1", courseName: "자료구조", year: 2026, semester: "2" }, T);
      first.close();
      const again = new ArchiveDb(path);
      expect(again.all("PRAGMA user_version")).toEqual([{ user_version: 1 }]);
      expect(again.all("SELECT course_name FROM courses")).toEqual([{ course_name: "자료구조" }]);
      again.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
