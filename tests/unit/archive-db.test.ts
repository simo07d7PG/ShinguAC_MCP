import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArchiveDb, isStale, STALE_MS, type AssignmentRow } from "../../src/store/archive-db.js";
import type { Course, Grades } from "../../src/schema/index.js";

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
    expect(db.findAssignmentLecture("10")).toMatchObject({ lectureSeq: "1", courseName: "자료구조", title: "과제 1" });
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
    expect(db.getPostPostedAt("1", "material", "001")).toBeUndefined();
    expect(db.upsertPost(post, T)).toBe("new");
    expect(db.upsertPost(post, T)).toBe("same");
    expect(db.getPostPostedAt("1", "material", "001")).toBe(T);
    expect(db.getPostPostedAt("1", "notice", "001")).toBeUndefined();
  });

  it("첨부 맞추기: 같은 것은 다운로드 기록 유지, 바뀐 것은 다시 받기, 사라진 것은 삭제", () => {
    const a = { name: "a.pdf", url: "https://cec.shingu.ac.kr/x?file_key=a" };
    const b = { name: "b.pdf", url: "https://cec.shingu.ac.kr/x?file_key=b" };
    expect(db.replaceAttachments("post", "1:material:001", "1", [a, b])).toBe(true);
    expect(db.replaceAttachments("post", "1:material:001", "1", [a, b])).toBe(false);
    const [first, second] = db.pendingAttachments();
    expect(first).toMatchObject({ ownerType: "post", ownerKey: "1:material:001", courseName: "자료구조", name: "a.pdf" });
    db.markDownloaded(first!.id, { localPath: "c/a.pdf", size: 3, sha256: "s1", downloadedAt: T });
    db.markDownloadFailed(second!.id, "NetworkError: x");
    expect(db.pendingAttachments().map((p) => p.name)).toEqual(["b.pdf"]);
    expect(db.findDownloadedBySha("s1")).toBe("c/a.pdf");
    expect(db.isPathTaken("c/a.pdf", second!.id)).toBe(true);
    expect(db.isPathTaken("c/a.pdf", first!.id)).toBe(false);
    // Windows·macOS에서는 대소문자·정규화만 다른 이름도 같은 파일
    expect(db.isPathTaken("C/A.PDF", second!.id)).toBe(true);

    // a는 그대로, 두 번째 자리는 c로 바뀜 → a 기록 유지, c는 미다운로드
    const c = { name: "c.pdf", url: "https://cec.shingu.ac.kr/x?file_key=c" };
    expect(db.replaceAttachments("post", "1:material:001", "1", [a, c])).toBe(true);
    expect(db.pendingAttachments().map((p) => p.name)).toEqual(["c.pdf"]);
    expect(db.replaceAttachments("post", "1:material:001", "1", [a])).toBe(true); // 삭제만 있어도 변경
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
      expect(again.all("PRAGMA user_version")).toEqual([{ user_version: 4 }]);
      expect(again.all("SELECT course_name FROM courses")).toEqual([{ course_name: "자료구조" }]);
      again.all("PRAGMA user_version = 99");
      again.close();
      expect(() => new ArchiveDb(path)).toThrow(/v99.*업데이트/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("v2 DB를 열면 v3·v4(저장본·동기화 기록·시도 기록·과제 열)만 추가하고 기존 데이터는 둔다", async () => {
    const dir = await mkdtemp(join(tmpdir(), "archive-db-"));
    try {
      const path = join(dir, "eclass.db");
      const first = new ArchiveDb(path);
      first.upsertCourse({ lectureSeq: "1", courseName: "자료구조", year: 2026, semester: "2" }, T);
      first.upsertAssignment(assignment(), T);
      first.replaceTimetable({ year: 2026, semester: "2" }, [{ day: 1, period: 1, courseName: "자료구조", professorName: "김교수" }], T);
      toV2(first);
      first.close();
      const again = new ArchiveDb(path);
      expect(again.all("PRAGMA user_version")).toEqual([{ user_version: 4 }]);
      expect(again.all("SELECT report_seq, submit_status, submitted_count, scored FROM assignments")).toEqual([
        { report_seq: "10", submit_status: "not_submitted", submitted_count: null, scored: null },
      ]);
      expect(again.getTimetable({ year: 2026, semester: "2" })?.entries).toHaveLength(1);
      expect(again.getCourses({ year: 2026, semester: "2" })).toBeUndefined();
      expect(again.getEclassSyncedAt({ year: 2026, semester: "2" })).toBeUndefined();
      // v3 이전 행은 평가 여부를 모른다(null) → get_assignment는 포털로 다시 읽는다
      expect(again.getAssignmentDetail("10")).toMatchObject({ scored: null, contentText: "내용", attachments: [] });
      again.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("v1 DB를 열면 시간표 테이블만 추가하고 기존 데이터는 둔다", async () => {
    const dir = await mkdtemp(join(tmpdir(), "archive-db-"));
    try {
      const path = join(dir, "eclass.db");
      const first = new ArchiveDb(path);
      first.upsertCourse({ lectureSeq: "1", courseName: "자료구조", year: 2026, semester: "2" }, T);
      // v1 상태로 되돌린다(시간표·v3 테이블과 열 없음)
      toV2(first);
      first.all("DROP TABLE timetable_entries");
      first.all("DROP TABLE timetables");
      first.all("PRAGMA user_version = 1");
      first.close();
      const again = new ArchiveDb(path);
      expect(again.all("PRAGMA user_version")).toEqual([{ user_version: 4 }]);
      expect(again.all("SELECT course_name FROM courses")).toEqual([{ course_name: "자료구조" }]);
      expect(again.getTimetable({ year: 2026, semester: "2" })).toBeUndefined();
      again.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** v3에서 추가한 테이블·열을 지우고 user_version을 2로 되돌린다. */
function toV2(db: ArchiveDb): void {
  db.all("DROP TABLE views");
  db.all("DROP TABLE eclass_syncs");
  db.all("DROP TABLE eclass_sync_attempts");
  for (const col of ["submitted_count", "total_count", "scored"]) db.all(`ALTER TABLE assignments DROP COLUMN ${col}`);
  db.all("PRAGMA user_version = 2");
}

describe("isStale", () => {
  const now = new Date("2026-10-26T12:00:00+09:00");
  it("없음·해석 불가·STALE_MS 초과는 오래됨, 경계와 그 안은 신선", () => {
    expect(STALE_MS).toBe(24 * 60 * 60 * 1000);
    expect(isStale(undefined, now)).toBe(true);
    expect(isStale("bad", now)).toBe(true);
    expect(isStale("2026-10-25T12:00:00+09:00", now)).toBe(false);
    expect(isStale("2026-10-25T11:59:59+09:00", now)).toBe(true);
    expect(isStale("2026-10-26T11:00:00+09:00", now)).toBe(false);
    expect(isStale("2026-10-26T12:00:00+09:00", now)).toBe(false);
    // 미래 시각(시계가 바뀐 경우)은 오래된 것으로 본다
    expect(isStale("2026-10-26T12:00:01+09:00", now)).toBe(true);
    // 기준 시간을 바꿀 수 있다(실패한 동기화 재시도 간격)
    expect(isStale("2026-10-26T11:30:00+09:00", now, 60 * 60 * 1000)).toBe(false);
    expect(isStale("2026-10-26T10:59:59+09:00", now, 60 * 60 * 1000)).toBe(true);
  });
});

describe("ArchiveDb v3 저장본", () => {
  const term = { year: 2026, semester: "2" };
  const course: Course = {
    courseName: "자료구조",
    year: 2026,
    semester: "2",
    professor: { name: "김교수", email: "prof@example.com" },
    lectureSeq: "1",
  };
  const grades: Grades = { semesters: [], credits: [], current: [] };

  it("수강 과목·성적: new → same(fetchedAt 갱신) → updated, 학기·종류별로 따로", () => {
    expect(db.getCourses(term)).toBeUndefined();
    expect(db.replaceCourses(term, [course], T)).toBe("new");
    const later = "2026-10-27T09:00:00+09:00";
    expect(db.replaceCourses(term, [course], later)).toBe("same");
    expect(db.getCourses(term)).toEqual({ data: [course], fetchedAt: later });
    expect(db.replaceCourses(term, [{ ...course, credits: 3 }], later)).toBe("updated");
    expect(db.getCourses({ year: 2026, semester: "1" })).toBeUndefined();
    expect(db.getGrades(term)).toBeUndefined();
    expect(db.replaceGrades(term, grades, T)).toBe("new");
    expect(db.getGrades(term)).toEqual({ data: grades, fetchedAt: T });
  });

  it("스키마에 맞지 않는 저장본은 없는 것으로 본다", () => {
    db.all("INSERT INTO views (kind, year, semester, data, fetched_at) VALUES ('courses', 2026, '2', '[{\"x\":1}]', ?)", T);
    expect(db.getCourses(term)).toBeUndefined();
    db.all("INSERT INTO views (kind, year, semester, data, fetched_at) VALUES ('grades', 2026, '2', 'not json', ?)", T);
    expect(db.getGrades(term)).toBeUndefined();
  });

  it("과제: 제출현황·평가 여부는 변경으로 세지 않고 덮어쓰며, 같아도 fetched_at을 갱신한다", () => {
    expect(db.upsertAssignment(assignment({ submittedCount: 3, totalCount: 28, scored: false }), T)).toBe("new");
    const later = "2026-10-27T09:00:00+09:00";
    expect(db.upsertAssignment(assignment({ submittedCount: 5, totalCount: 28, scored: false }), later)).toBe("same");
    // 생략하면 저장값 유지
    expect(db.upsertAssignment(assignment(), later)).toBe("same");
    db.replaceAttachments("assignment", "10", "1", [{ name: "a.pdf", url: "https://cec.shingu.ac.kr/x?file_key=a" }]);
    expect(db.getAssignmentDetail("10")).toMatchObject({
      courseName: "자료구조",
      submittedCount: 5,
      totalCount: 28,
      scored: false,
      contentText: "내용",
      fetchedAt: later,
      attachments: [{ name: "a.pdf", url: "https://cec.shingu.ac.kr/x?file_key=a" }],
    });
    expect(db.listAssignments({ year: 2026, semester: "2" }).map((a) => a.reportSeq)).toEqual(["10"]);
    expect(db.listAssignments({ year: 2026, semester: "1" })).toEqual([]);
  });

  it("listAssignments는 강의 번호를 숫자로 정렬하고, updateAssignmentCounts는 제출현황만 바꾼다(null이면 유지)", () => {
    db.upsertCourse({ lectureSeq: "9", courseName: "운영체제", year: 2026, semester: "2" }, T);
    db.upsertCourse({ lectureSeq: "10", courseName: "네트워크", year: 2026, semester: "2" }, T);
    db.upsertAssignment(assignment({ reportSeq: "1", lectureSeq: "10" }), T);
    db.upsertAssignment(assignment({ reportSeq: "2", lectureSeq: "9", submittedCount: 1, totalCount: 9 }), T);
    expect(db.listAssignments({ year: 2026, semester: "2" }).map((a) => a.lectureSeq)).toEqual(["9", "10"]);
    db.updateAssignmentCounts("2", 4, null);
    expect(db.getAssignmentDetail("2")).toMatchObject({ submittedCount: 4, totalCount: 9, fetchedAt: T, submitStatus: "not_submitted" });
  });

  it("markDownloaded에 url을 주면 그 사이 링크가 바뀐 행에는 쓰지 않는다", () => {
    db.replaceAttachments("assignment", "10", "1", [{ name: "a.pdf", url: "https://x/a" }]);
    const [att] = db.pendingAttachments();
    db.replaceAttachments("assignment", "10", "1", [{ name: "a.pdf", url: "https://x/b" }]);
    db.markDownloaded(att!.id, { localPath: "c/a.pdf", size: 1, sha256: "s", downloadedAt: T, url: "https://x/a" });
    expect(db.pendingAttachments().map((p) => p.url)).toEqual(["https://x/b"]);
    db.markDownloaded(att!.id, { localPath: "c/a.pdf", size: 1, sha256: "s", downloadedAt: T, url: "https://x/b" });
    expect(db.pendingAttachments()).toEqual([]);
  });

  it("markSubmitted: 확인되면 제출 + 오래된 것, 미확인이면 오래된 것만. 동기화 기록은 학기별", () => {
    db.upsertAssignment(assignment(), T);
    db.markSubmitted("10", false);
    const unconfirmed = db.getAssignmentDetail("10")!;
    expect(unconfirmed.submitStatus).toBe("not_submitted");
    expect(isStale(unconfirmed.fetchedAt, new Date(T))).toBe(true);
    db.markSubmitted("10", true);
    const d = db.getAssignmentDetail("10")!;
    expect(d.submitStatus).toBe("submitted");
    expect(isStale(d.fetchedAt, new Date(T))).toBe(true);
    db.markSubmitted("404", true); // 없는 과제는 무시
    db.markEclassSynced(term, T);
    expect(db.getEclassSyncedAt(term)).toBe(T);
    expect(db.getEclassSyncedAt({ year: 2027, semester: "1" })).toBeUndefined();
    expect(db.hasCourse("1")).toBe(true);
    expect(db.hasCourse("2")).toBe(false);
  });
});

describe("ArchiveDb 시간표", () => {
  const term = { year: 2026, semester: "2" };
  const mon = { day: 1, period: 1, startTime: "09:00", endTime: "09:50", courseName: "자료구조", professorName: "김교수", building: "본관", room: "101" };
  const tue = { day: 2, period: 3, courseName: "UI화면설계", professorName: "이교수", roomAlias: "실습실" };

  it("동기화 전에는 undefined, 비어 있는 학기는 빈 배열로 구분한다", () => {
    expect(db.getTimetable(term)).toBeUndefined();
    expect(db.replaceTimetable(term, [], T)).toBe("new");
    expect(db.getTimetable(term)).toEqual({ entries: [], fetchedAt: T });
  });

  it("new → same(fetchedAt만 갱신) → updated, 선택 필드는 없으면 생략", () => {
    expect(db.replaceTimetable(term, [mon, tue], T)).toBe("new");
    const later = "2026-10-27T09:00:00+09:00";
    expect(db.replaceTimetable(term, [mon, tue], later)).toBe("same");
    expect(db.getTimetable(term)).toEqual({ entries: [mon, tue], fetchedAt: later });
    expect(db.replaceTimetable(term, [mon, { ...tue, period: 4 }], later)).toBe("updated");
    expect(db.getTimetable(term)!.entries[1]).toEqual({ ...tue, period: 4 });
    expect(db.replaceTimetable(term, [mon], later)).toBe("updated");
    expect(db.getTimetable(term)!.entries).toEqual([mon]);
    // 다른 학기는 따로
    expect(db.getTimetable({ year: 2026, semester: "1" })).toBeUndefined();
  });
});
