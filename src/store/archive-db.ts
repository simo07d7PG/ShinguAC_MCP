import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CourseSchema, type Course } from "../schema/course.js";
import { GradesSchema, type Grades } from "../schema/grade.js";
import type { TimetableEntry } from "../schema/timetable.js";

/** 저장본(시간표·수강 과목·성적·E클래스 과제)을 그대로 돌려주는 최대 경과 시간. 넘으면 조회 시 포털에서 다시 읽는다. */
export const STALE_MS = 24 * 60 * 60 * 1000;

/** 실패한 강의가 있던 E클래스 동기화 시도 뒤, get_assignments가 다시 동기화하기까지 기다리는 시간. */
export const RETRY_BACKOFF_MS = 60 * 60 * 1000;

/**
 * 저장 시각이 없거나(저장본 없음) STALE_MS보다 오래됐으면 true.
 * 해석할 수 없는 시각과 지금보다 미래인 시각(시계가 바뀐 경우)도 오래된 것으로 본다.
 */
export function isStale(storedAt: string | null | undefined, now: Date, maxAgeMs = STALE_MS): boolean {
  if (!storedAt) return true;
  const t = Date.parse(storedAt);
  return Number.isNaN(t) || t > now.getTime() || now.getTime() - t > maxAgeMs;
}

/** 다시 읽어야 한다고 표시할 때 쓰는 fetched_at(항상 STALE_MS보다 오래됨). 읽은 시각을 전혀 모를 때의 fetchedAt으로도 쓴다. */
export const STALE_MARK = "1970-01-01T09:00:00+09:00";

export interface Term {
  year: number;
  semester: string;
}

/** 게시판 종류. 수업공지 boardId=1, 자료실 boardId=3. */
export type Board = "notice" | "material";
export const BOARD_IDS: Record<Board, string> = { notice: "1", material: "3" };

export type OwnerType = "assignment" | "submission" | "post";

export interface CourseRow {
  lectureSeq: string;
  courseName: string;
  year: number;
  semester: string;
  section?: string;
  professor?: string;
}

export interface AssignmentRow {
  reportSeq: string;
  lectureSeq: string;
  title: string;
  startAt: string | null;
  dueAt: string | null;
  extendedDueAt: string | null;
  penaltyNote: string | null;
  contentHtml: string;
  contentText: string;
  submitStatus: string;
  /** v3. 생략(undefined)하면 저장된 값을 유지한다. */
  submittedCount?: number | null;
  totalCount?: number | null;
  scored?: boolean | null;
}

/** 이번 학기 과제 목록(get_assignments)용 저장 행. 마감은 원래 값. */
export interface StoredAssignment {
  lectureSeq: string;
  courseName: string;
  professor: string | null;
  reportSeq: string;
  title: string;
  startAt: string | null;
  dueAt: string | null;
  extendedDueAt: string | null;
  submitStatus: string;
  submittedCount: number | null;
  totalCount: number | null;
  scored: boolean | null;
}

/** 과제 상세(get_assignment)용 저장본. 마감은 원래 값. */
export interface StoredAssignmentDetail extends StoredAssignment {
  penaltyNote: string | null;
  contentText: string;
  attachments: AttachmentRef[];
  fetchedAt: string;
}

export interface SubmissionRow {
  reportSeq: string;
  title: string;
  contentHtml: string;
  contentText: string;
}

export interface PostRow {
  lectureSeq: string;
  board: Board;
  wrId: string;
  title: string;
  postedAt: string | null;
  author: string | null;
  bodyHtml: string;
  bodyText: string;
}

export interface AttachmentRef {
  name: string;
  url: string;
}

export interface PendingAttachment {
  id: number;
  ownerType: OwnerType;
  ownerKey: string;
  lectureSeq: string;
  courseName: string;
  name: string;
  url: string;
}

/** 검색 결과의 첨부. localPath는 files 디렉터리 기준 상대 경로(내려받기 전이면 null). url·error는 담지 않는다. */
export interface ArchiveAttachmentHit {
  name: string;
  localPath: string | null;
}

export interface AssignmentSearchFilter {
  course?: string;
  query?: string;
  status?: string;
  /** KST 날짜 YYYY-MM-DD. 마감(연장기한 우선)이 이 날 0시 이후. */
  dueFrom?: string;
  /** KST 날짜 YYYY-MM-DD. 마감(연장기한 우선)이 이 날 23:59:59까지. */
  dueTo?: string;
  limit: number;
}

export interface AssignmentHit {
  lectureSeq: string;
  courseName: string;
  reportSeq: string;
  title: string;
  startAt: string | null;
  dueAt: string | null;
  extendedDueAt: string | null;
  submitStatus: string;
  contentText: string;
  attachments: ArchiveAttachmentHit[];
  submission?: { title: string; contentText: string; attachments: ArchiveAttachmentHit[] };
}

export interface PostSearchFilter {
  course?: string;
  query?: string;
  board?: Board;
  limit: number;
}

export interface PostHit {
  lectureSeq: string;
  courseName: string;
  board: Board;
  wrId: string;
  title: string;
  postedAt: string | null;
  author: string | null;
  bodyText: string;
  attachments: ArchiveAttachmentHit[];
}

/** LIKE 패턴용으로 %, _, \를 이스케이프하고 양쪽에 %를 붙인다(ESCAPE '\\'와 함께 쓴다). */
function likePattern(input: string): string {
  return `%${input.replace(/[\\%_]/g, "\\$&")}%`;
}

const MIGRATIONS: string[] = [
  `
  CREATE TABLE courses (
    lecture_seq TEXT PRIMARY KEY,
    course_name TEXT NOT NULL,
    year        INTEGER NOT NULL,
    semester    TEXT NOT NULL,
    section     TEXT,
    professor   TEXT,
    synced_at   TEXT NOT NULL
  );
  CREATE TABLE assignments (
    report_seq      TEXT PRIMARY KEY,
    lecture_seq     TEXT NOT NULL REFERENCES courses(lecture_seq),
    title           TEXT NOT NULL,
    start_at        TEXT,
    due_at          TEXT,
    extended_due_at TEXT,
    penalty_note    TEXT,
    content_html    TEXT NOT NULL,
    content_text    TEXT NOT NULL,
    submit_status   TEXT NOT NULL,
    fetched_at      TEXT NOT NULL
  );
  CREATE TABLE submissions (
    report_seq   TEXT PRIMARY KEY REFERENCES assignments(report_seq),
    title        TEXT NOT NULL,
    content_html TEXT NOT NULL,
    content_text TEXT NOT NULL,
    fetched_at   TEXT NOT NULL
  );
  CREATE TABLE posts (
    lecture_seq TEXT NOT NULL REFERENCES courses(lecture_seq),
    board       TEXT NOT NULL CHECK (board IN ('notice', 'material')),
    wr_id       TEXT NOT NULL,
    title       TEXT NOT NULL,
    posted_at   TEXT,
    author      TEXT,
    body_html   TEXT NOT NULL,
    body_text   TEXT NOT NULL,
    fetched_at  TEXT NOT NULL,
    PRIMARY KEY (lecture_seq, board, wr_id)
  );
  -- owner_key: assignment·submission은 report_seq, post는 '<lecture_seq>:<board>:<wr_id>'.
  -- local_path는 files 디렉터리 기준 상대 경로. 내려받기 전이면 NULL.
  CREATE TABLE attachments (
    id            INTEGER PRIMARY KEY,
    owner_type    TEXT NOT NULL CHECK (owner_type IN ('assignment', 'submission', 'post')),
    owner_key     TEXT NOT NULL,
    lecture_seq   TEXT NOT NULL REFERENCES courses(lecture_seq),
    position      INTEGER NOT NULL,
    name          TEXT NOT NULL,
    url           TEXT NOT NULL,
    local_path    TEXT,
    size          INTEGER,
    sha256        TEXT,
    downloaded_at TEXT,
    error         TEXT,
    UNIQUE (owner_type, owner_key, position)
  );
  CREATE INDEX assignments_lecture ON assignments(lecture_seq);
  CREATE INDEX attachments_pending ON attachments(local_path) WHERE local_path IS NULL;
  `,
  // v2: 개인 시간표. timetables 행이 있으면 그 학기를 동기화한 적이 있다(항목이 0개여도).
  `
  CREATE TABLE timetables (
    year       INTEGER NOT NULL,
    semester   TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (year, semester)
  );
  CREATE TABLE timetable_entries (
    year           INTEGER NOT NULL,
    semester       TEXT NOT NULL,
    position       INTEGER NOT NULL,
    day            INTEGER NOT NULL,
    period         INTEGER NOT NULL,
    start_time     TEXT,
    end_time       TEXT,
    course_name    TEXT NOT NULL,
    professor_name TEXT NOT NULL,
    building       TEXT,
    room           TEXT,
    room_alias     TEXT,
    PRIMARY KEY (year, semester, position),
    FOREIGN KEY (year, semester) REFERENCES timetables(year, semester) ON DELETE CASCADE
  );
  `,
  // v3: 수강 과목·성적 저장본(학기별 JSON, 읽을 때 스키마 검증), 학기별 마지막 E클래스 동기화 시각,
  // 과제 상세만으로 답하기 위한 제출현황·평가 여부.
  `
  CREATE TABLE views (
    kind       TEXT NOT NULL CHECK (kind IN ('courses', 'grades')),
    year       INTEGER NOT NULL,
    semester   TEXT NOT NULL,
    data       TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (kind, year, semester)
  );
  CREATE TABLE eclass_syncs (
    year      INTEGER NOT NULL,
    semester  TEXT NOT NULL,
    synced_at TEXT NOT NULL,
    PRIMARY KEY (year, semester)
  );
  ALTER TABLE assignments ADD COLUMN submitted_count INTEGER;
  ALTER TABLE assignments ADD COLUMN total_count INTEGER;
  ALTER TABLE assignments ADD COLUMN scored INTEGER;
  `,
  // v4: 실패한 강의가 있던 E클래스 동기화 시도 시각(get_assignments가 매번 다시 동기화하지 않도록 RETRY_BACKOFF_MS 동안 둔다).
  `
  CREATE TABLE eclass_sync_attempts (
    year         INTEGER NOT NULL,
    semester     TEXT NOT NULL,
    attempted_at TEXT NOT NULL,
    PRIMARY KEY (year, semester)
  );
  `,
];

type ViewKind = "courses" | "grades";
const VIEW_SCHEMAS = { courses: z.array(CourseSchema), grades: GradesSchema } as const;

/** 시간표 항목 ↔ DB 행. 비교·저장 모두 이 순서를 쓴다. */
const TIMETABLE_COLUMNS = [
  "day",
  "period",
  "start_time",
  "end_time",
  "course_name",
  "professor_name",
  "building",
  "room",
  "room_alias",
] as const;

function timetableRow(e: TimetableEntry): Array<string | number | null> {
  return [
    e.day,
    e.period,
    e.startTime ?? null,
    e.endTime ?? null,
    e.courseName,
    e.professorName,
    e.building ?? null,
    e.room ?? null,
    e.roomAlias ?? null,
  ];
}

/**
 * E클래스 아카이브(SQLite). 과목·과제·내 제출·게시글(수업공지·자료실)·첨부 메타데이터를 저장한다.
 * 첨부 파일 자체는 디스크(files 디렉터리)에 두고 여기에는 이름·원본 링크·로컬 경로만 남긴다.
 */
export class ArchiveDb {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    try {
      this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
      this.migrate();
    } catch (err) {
      // 열다 실패하면 파일 잠금이 남지 않게 닫는다.
      this.db.close();
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const { user_version: version } = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version > MIGRATIONS.length) {
      throw new Error(`아카이브 DB 스키마(v${version})가 이 버전(v${MIGRATIONS.length})보다 새롭습니다. shingu-mcp를 업데이트하세요.`);
    }
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  transaction<T>(fn: () => T): T {
    // 다른 프로세스와 겹칠 때 읽기→쓰기 승격에서 바로 SQLITE_BUSY가 나지 않도록 처음부터 쓰기 잠금을 잡는다.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  upsertCourse(c: CourseRow, syncedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO courses (lecture_seq, course_name, year, semester, section, professor, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (lecture_seq) DO UPDATE SET course_name = excluded.course_name, year = excluded.year,
           semester = excluded.semester, section = excluded.section, professor = excluded.professor,
           synced_at = excluded.synced_at`,
      )
      .run(c.lectureSeq, c.courseName, c.year, c.semester, c.section ?? null, c.professor ?? null, syncedAt);
  }

  /** 저장된 과제의 동기화 판단용 정보. */
  getAssignmentState(reportSeq: string): { dueAt: string | null; extendedDueAt: string | null; submitStatus: string } | undefined {
    const row = this.db
      .prepare("SELECT due_at, extended_due_at, submit_status FROM assignments WHERE report_seq = ?")
      .get(reportSeq) as { due_at: string | null; extended_due_at: string | null; submit_status: string } | undefined;
    return row && { dueAt: row.due_at, extendedDueAt: row.extended_due_at, submitStatus: row.submit_status };
  }

  /** report_seq로 강의를 찾는다(lecture_seq 생략 시). 마감은 저장된 원래 값. */
  findAssignmentLecture(
    reportSeq: string,
  ): { lectureSeq: string; courseName: string; title: string; dueAt: string | null; extendedDueAt: string | null } | undefined {
    const row = this.db
      .prepare(
        `SELECT a.lecture_seq, c.course_name, a.title, a.due_at, a.extended_due_at FROM assignments a
         JOIN courses c ON c.lecture_seq = a.lecture_seq WHERE a.report_seq = ?`,
      )
      .get(reportSeq) as
      | { lecture_seq: string; course_name: string; title: string; due_at: string | null; extended_due_at: string | null }
      | undefined;
    return (
      row && {
        lectureSeq: row.lecture_seq,
        courseName: row.course_name,
        title: row.title,
        dueAt: row.due_at,
        extendedDueAt: row.extended_due_at,
      }
    );
  }

  /** 과제를 저장한다. 새로 생기면 "new", 내용이 바뀌면 "updated", 같으면 "same". */
  upsertAssignment(a: AssignmentRow, fetchedAt: string): "new" | "updated" | "same" {
    const prev = this.db
      .prepare(
        `SELECT title, start_at, due_at, extended_due_at, penalty_note, content_html, submit_status
         FROM assignments WHERE report_seq = ?`,
      )
      .get(a.reportSeq) as Record<string, unknown> | undefined;
    const next = {
      title: a.title,
      start_at: a.startAt,
      due_at: a.dueAt,
      extended_due_at: a.extendedDueAt,
      penalty_note: a.penaltyNote,
      content_html: a.contentHtml,
      submit_status: a.submitStatus,
    };
    const changed = !prev || Object.entries(next).some(([k, v]) => prev[k] !== v);
    // 제출현황·평가 여부는 다른 학생 제출만으로도 바뀌므로 변경 판정에 넣지 않고 늘 덮어쓴다(undefined면 유지).
    // fetched_at은 마지막으로 포털에서 읽은 시각이라 내용이 같아도 갱신한다.
    const v3 = [a.submittedCount ?? null, a.totalCount ?? null, a.scored === undefined || a.scored === null ? null : a.scored ? 1 : 0];
    if (!changed) {
      this.db
        .prepare(
          `UPDATE assignments SET fetched_at = ?, submitted_count = COALESCE(?, submitted_count),
             total_count = COALESCE(?, total_count), scored = COALESCE(?, scored) WHERE report_seq = ?`,
        )
        .run(fetchedAt, ...v3, a.reportSeq);
      return "same";
    }
    this.db
      .prepare(
        `INSERT INTO assignments (report_seq, lecture_seq, title, start_at, due_at, extended_due_at, penalty_note,
           content_html, content_text, submit_status, fetched_at, submitted_count, total_count, scored)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (report_seq) DO UPDATE SET lecture_seq = excluded.lecture_seq, title = excluded.title,
           start_at = excluded.start_at, due_at = excluded.due_at, extended_due_at = excluded.extended_due_at,
           penalty_note = excluded.penalty_note, content_html = excluded.content_html,
           content_text = excluded.content_text, submit_status = excluded.submit_status, fetched_at = excluded.fetched_at,
           submitted_count = COALESCE(excluded.submitted_count, submitted_count),
           total_count = COALESCE(excluded.total_count, total_count), scored = COALESCE(excluded.scored, scored)`,
      )
      .run(
        a.reportSeq,
        a.lectureSeq,
        a.title,
        a.startAt,
        a.dueAt,
        a.extendedDueAt,
        a.penaltyNote,
        a.contentHtml,
        a.contentText,
        a.submitStatus,
        fetchedAt,
        ...v3,
      );
    return prev ? "updated" : "new";
  }

  /** 내 제출을 저장한다. 반환은 upsertAssignment와 같다. */
  upsertSubmission(s: SubmissionRow, fetchedAt: string): "new" | "updated" | "same" {
    const prev = this.db
      .prepare("SELECT title, content_html FROM submissions WHERE report_seq = ?")
      .get(s.reportSeq) as { title: string; content_html: string } | undefined;
    if (prev && prev.title === s.title && prev.content_html === s.contentHtml) return "same";
    this.db
      .prepare(
        `INSERT INTO submissions (report_seq, title, content_html, content_text, fetched_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (report_seq) DO UPDATE SET title = excluded.title, content_html = excluded.content_html,
           content_text = excluded.content_text, fetched_at = excluded.fetched_at`,
      )
      .run(s.reportSeq, s.title, s.contentHtml, s.contentText, fetchedAt);
    return prev ? "updated" : "new";
  }

  hasSubmission(reportSeq: string): boolean {
    return this.db.prepare("SELECT 1 FROM submissions WHERE report_seq = ?").get(reportSeq) !== undefined;
  }

  /** 저장된 게시글의 등록일시. 글이 없으면 undefined, 등록일시를 모르면 null. */
  getPostPostedAt(lectureSeq: string, board: Board, wrId: string): string | null | undefined {
    const row = this.db
      .prepare("SELECT posted_at FROM posts WHERE lecture_seq = ? AND board = ? AND wr_id = ?")
      .get(lectureSeq, board, wrId) as { posted_at: string | null } | undefined;
    return row ? row.posted_at : undefined;
  }

  upsertPost(p: PostRow, fetchedAt: string): "new" | "updated" | "same" {
    const prev = this.db
      .prepare("SELECT title, posted_at, author, body_html FROM posts WHERE lecture_seq = ? AND board = ? AND wr_id = ?")
      .get(p.lectureSeq, p.board, p.wrId) as Record<string, unknown> | undefined;
    if (prev && prev["title"] === p.title && prev["posted_at"] === p.postedAt && prev["author"] === p.author && prev["body_html"] === p.bodyHtml) {
      return "same";
    }
    this.db
      .prepare(
        `INSERT INTO posts (lecture_seq, board, wr_id, title, posted_at, author, body_html, body_text, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (lecture_seq, board, wr_id) DO UPDATE SET title = excluded.title, posted_at = excluded.posted_at,
           author = excluded.author, body_html = excluded.body_html, body_text = excluded.body_text,
           fetched_at = excluded.fetched_at`,
      )
      .run(p.lectureSeq, p.board, p.wrId, p.title, p.postedAt, p.author, p.bodyHtml, p.bodyText, fetchedAt);
    return prev ? "updated" : "new";
  }

  /**
   * 소유자(과제·제출·게시글)의 첨부 목록을 맞춘다. 같은 위치에 같은 이름·링크면 다운로드 기록을 유지하고,
   * 바뀌었으면 다시 내려받도록 비운다. 사라진 위치의 행은 지운다(디스크 파일은 지우지 않는다).
   * 추가·변경·삭제된 첨부가 있으면 true.
   */
  replaceAttachments(ownerType: OwnerType, ownerKey: string, lectureSeq: string, list: AttachmentRef[]): boolean {
    const existing = this.db
      .prepare("SELECT position, name, url FROM attachments WHERE owner_type = ? AND owner_key = ?")
      .all(ownerType, ownerKey) as { position: number; name: string; url: string }[];
    const byPos = new Map(existing.map((r) => [r.position, r]));
    let changed = false;
    list.forEach((att, position) => {
      const prev = byPos.get(position);
      if (prev && prev.name === att.name && prev.url === att.url) return;
      changed = true;
      this.db
        .prepare(
          `INSERT INTO attachments (owner_type, owner_key, lecture_seq, position, name, url)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (owner_type, owner_key, position) DO UPDATE SET name = excluded.name, url = excluded.url,
             local_path = NULL, size = NULL, sha256 = NULL, downloaded_at = NULL, error = NULL`,
        )
        .run(ownerType, ownerKey, lectureSeq, position, att.name, att.url);
    });
    const removed = this.db
      .prepare("DELETE FROM attachments WHERE owner_type = ? AND owner_key = ? AND position >= ?")
      .run(ownerType, ownerKey, list.length);
    return changed || Number(removed.changes) > 0;
  }

  /** 아직 내려받지 않은 첨부. */
  pendingAttachments(): PendingAttachment[] {
    const rows = this.db
      .prepare(
        `SELECT a.id, a.owner_type, a.owner_key, a.lecture_seq, c.course_name, a.name, a.url
         FROM attachments a JOIN courses c ON c.lecture_seq = a.lecture_seq
         WHERE a.local_path IS NULL ORDER BY a.id`,
      )
      .all() as {
      id: number;
      owner_type: OwnerType;
      owner_key: string;
      lecture_seq: string;
      course_name: string;
      name: string;
      url: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      ownerType: r.owner_type,
      ownerKey: r.owner_key,
      lectureSeq: r.lecture_seq,
      courseName: r.course_name,
      name: r.name,
      url: r.url,
    }));
  }

  /** 같은 내용(sha256)의 파일을 이미 받아 둔 경로. */
  findDownloadedBySha(sha256: string): string | undefined {
    const row = this.db
      .prepare("SELECT local_path FROM attachments WHERE sha256 = ? AND local_path IS NOT NULL LIMIT 1")
      .get(sha256) as { local_path: string } | undefined;
    return row?.local_path;
  }

  /** 다른 첨부가 이미 이 로컬 경로를 쓰고 있는가. Windows·macOS 파일시스템처럼 대소문자·유니코드 정규화를 무시한다. */
  isPathTaken(localPath: string, exceptId: number): boolean {
    const key = localPath.normalize("NFC").toLowerCase();
    const rows = this.db
      .prepare("SELECT local_path FROM attachments WHERE local_path IS NOT NULL AND id <> ?")
      .all(exceptId) as { local_path: string }[];
    return rows.some((r) => r.local_path.normalize("NFC").toLowerCase() === key);
  }

  /**
   * 내려받은 기록. url을 주면 그 사이 동기화가 링크를 바꾼 행(다시 받아야 함)에는 쓰지 않는다
   * (다운로드는 E클래스 단계와 다른 잠금에서 돈다).
   */
  markDownloaded(id: number, info: { localPath: string; size: number; sha256: string; downloadedAt: string; url?: string }): void {
    this.db
      .prepare(
        `UPDATE attachments SET local_path = ?, size = ?, sha256 = ?, downloaded_at = ?, error = NULL
         WHERE id = ? AND (? IS NULL OR url = ?)`,
      )
      .run(info.localPath, info.size, info.sha256, info.downloadedAt, id, info.url ?? null, info.url ?? null);
  }

  markDownloadFailed(id: number, error: string): void {
    this.db.prepare("UPDATE attachments SET error = ? WHERE id = ?").run(error, id);
  }

  /** 과목 행이 하나라도 있는가(아카이브가 비었는지 판단). */
  hasCourses(): boolean {
    return this.db.prepare("SELECT 1 FROM courses LIMIT 1").get() !== undefined;
  }

  private attachmentHits(ownerType: OwnerType, ownerKey: string): ArchiveAttachmentHit[] {
    return (
      this.db
        .prepare("SELECT name, local_path FROM attachments WHERE owner_type = ? AND owner_key = ? ORDER BY position")
        .all(ownerType, ownerKey) as { name: string; local_path: string | null }[]
    ).map((r) => ({ name: r.name, localPath: r.local_path }));
  }

  /** 과제 검색. 마감(연장기한 우선) 오름차순, 마감 없음은 뒤. total은 limit 적용 전 건수. */
  searchAssignments(f: AssignmentSearchFilter): { total: number; items: AssignmentHit[] } {
    // DB에는 원래 마감을 둔다. 필터·정렬은 실제 마감(00:00 → 전날 23:59, `effectiveDeadline`) 기준이다.
    const raw = "COALESCE(a.extended_due_at, a.due_at)";
    const due = `(CASE WHEN substr(${raw}, 11) = 'T00:00:00+09:00'
      THEN strftime('%Y-%m-%dT23:59:00+09:00', substr(${raw}, 1, 10), '-1 day') ELSE ${raw} END)`;
    const where: string[] = [];
    const params: string[] = [];
    if (f.course) {
      where.push("c.course_name LIKE ? ESCAPE '\\'");
      params.push(likePattern(f.course));
    }
    if (f.query) {
      where.push("(a.title LIKE ? ESCAPE '\\' OR a.content_text LIKE ? ESCAPE '\\')");
      params.push(likePattern(f.query), likePattern(f.query));
    }
    if (f.status) {
      where.push("a.submit_status = ?");
      params.push(f.status);
    }
    if (f.dueFrom) {
      where.push(`${due} >= ?`);
      params.push(`${f.dueFrom}T00:00:00+09:00`);
    }
    if (f.dueTo) {
      where.push(`${due} <= ?`);
      params.push(`${f.dueTo}T23:59:59+09:00`);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const from = "FROM assignments a JOIN courses c ON c.lecture_seq = a.lecture_seq";
    const { n } = this.db.prepare(`SELECT COUNT(*) AS n ${from} ${clause}`).get(...params) as { n: number };
    const rows = this.db
      .prepare(
        `SELECT a.lecture_seq, c.course_name, a.report_seq, a.title, a.start_at, a.due_at, a.extended_due_at,
           a.submit_status, a.content_text, s.title AS sub_title, s.content_text AS sub_text
         ${from} LEFT JOIN submissions s ON s.report_seq = a.report_seq
         ${clause}
         ORDER BY (${due} IS NULL), ${due} ASC, a.report_seq LIMIT ?`,
      )
      .all(...params, f.limit) as {
      lecture_seq: string;
      course_name: string;
      report_seq: string;
      title: string;
      start_at: string | null;
      due_at: string | null;
      extended_due_at: string | null;
      submit_status: string;
      content_text: string;
      sub_title: string | null;
      sub_text: string | null;
    }[];
    const items = rows.map((r): AssignmentHit => {
      const hit: AssignmentHit = {
        lectureSeq: r.lecture_seq,
        courseName: r.course_name,
        reportSeq: r.report_seq,
        title: r.title,
        startAt: r.start_at,
        dueAt: r.due_at,
        extendedDueAt: r.extended_due_at,
        submitStatus: r.submit_status,
        contentText: r.content_text,
        attachments: this.attachmentHits("assignment", r.report_seq),
      };
      if (r.sub_title !== null) {
        hit.submission = {
          title: r.sub_title,
          contentText: r.sub_text ?? "",
          attachments: this.attachmentHits("submission", r.report_seq),
        };
      }
      return hit;
    });
    return { total: n, items };
  }

  /** 게시글 검색. 등록일시 내림차순(등록일시 없음은 뒤). total은 limit 적용 전 건수. */
  searchPosts(f: PostSearchFilter): { total: number; items: PostHit[] } {
    const where: string[] = [];
    const params: string[] = [];
    if (f.course) {
      where.push("c.course_name LIKE ? ESCAPE '\\'");
      params.push(likePattern(f.course));
    }
    if (f.query) {
      where.push("(p.title LIKE ? ESCAPE '\\' OR p.body_text LIKE ? ESCAPE '\\')");
      params.push(likePattern(f.query), likePattern(f.query));
    }
    if (f.board) {
      where.push("p.board = ?");
      params.push(f.board);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const from = "FROM posts p JOIN courses c ON c.lecture_seq = p.lecture_seq";
    const { n } = this.db.prepare(`SELECT COUNT(*) AS n ${from} ${clause}`).get(...params) as { n: number };
    const rows = this.db
      .prepare(
        `SELECT p.lecture_seq, c.course_name, p.board, p.wr_id, p.title, p.posted_at, p.author, p.body_text
         ${from} ${clause}
         ORDER BY (p.posted_at IS NULL), p.posted_at DESC, CAST(p.wr_id AS INTEGER) DESC LIMIT ?`,
      )
      .all(...params, f.limit) as {
      lecture_seq: string;
      course_name: string;
      board: Board;
      wr_id: string;
      title: string;
      posted_at: string | null;
      author: string | null;
      body_text: string;
    }[];
    const items = rows.map(
      (r): PostHit => ({
        lectureSeq: r.lecture_seq,
        courseName: r.course_name,
        board: r.board,
        wrId: r.wr_id,
        title: r.title,
        postedAt: r.posted_at,
        author: r.author,
        bodyText: r.body_text,
        attachments: this.attachmentHits("post", `${r.lecture_seq}:${r.board}:${r.wr_id}`),
      }),
    );
    return { total: n, items };
  }

  /** 저장된 학기 시간표. 그 학기를 동기화한 적이 없으면 undefined(동기화했는데 비어 있으면 빈 배열). */
  getTimetable(term: { year: number; semester: string }): { entries: TimetableEntry[]; fetchedAt: string } | undefined {
    const head = this.db
      .prepare("SELECT fetched_at FROM timetables WHERE year = ? AND semester = ?")
      .get(term.year, term.semester) as { fetched_at: string } | undefined;
    if (!head) return undefined;
    const rows = this.db
      .prepare(
        `SELECT ${TIMETABLE_COLUMNS.join(", ")} FROM timetable_entries
         WHERE year = ? AND semester = ? ORDER BY position`,
      )
      .all(term.year, term.semester) as Record<(typeof TIMETABLE_COLUMNS)[number], string | number | null>[];
    const entries = rows.map((r) => {
      const e: TimetableEntry = {
        day: Number(r.day),
        period: Number(r.period),
        courseName: String(r.course_name),
        professorName: String(r.professor_name),
      };
      if (r.start_time !== null) e.startTime = String(r.start_time);
      if (r.end_time !== null) e.endTime = String(r.end_time);
      if (r.building !== null) e.building = String(r.building);
      if (r.room !== null) e.room = String(r.room);
      if (r.room_alias !== null) e.roomAlias = String(r.room_alias);
      return e;
    });
    return { entries, fetchedAt: head.fetched_at };
  }

  /**
   * 학기 시간표를 통째로 바꾼다. 처음이면 "new", 항목이 바뀌었으면 "updated", 같으면 "same".
   * 같아도 fetched_at은 갱신한다(마지막으로 포털과 맞춰 본 시각).
   */
  replaceTimetable(
    term: { year: number; semester: string },
    entries: TimetableEntry[],
    fetchedAt: string,
  ): "new" | "updated" | "same" {
    return this.transaction(() => {
      const prev = this.getTimetable(term);
      const same =
        prev !== undefined &&
        prev.entries.length === entries.length &&
        prev.entries.every((p, i) => JSON.stringify(timetableRow(p)) === JSON.stringify(timetableRow(entries[i]!)));
      this.db
        .prepare(
          `INSERT INTO timetables (year, semester, fetched_at) VALUES (?, ?, ?)
           ON CONFLICT (year, semester) DO UPDATE SET fetched_at = excluded.fetched_at`,
        )
        .run(term.year, term.semester, fetchedAt);
      if (same) return "same";
      this.db.prepare("DELETE FROM timetable_entries WHERE year = ? AND semester = ?").run(term.year, term.semester);
      const insert = this.db.prepare(
        `INSERT INTO timetable_entries (year, semester, position, ${TIMETABLE_COLUMNS.join(", ")})
         VALUES (?, ?, ?, ${TIMETABLE_COLUMNS.map(() => "?").join(", ")})`,
      );
      entries.forEach((e, position) => insert.run(term.year, term.semester, position, ...timetableRow(e)));
      return prev ? "updated" : "new";
    });
  }

  /** 학기 수강 과목 저장본(연락처 포함). 없거나 스키마에 맞지 않으면 undefined. */
  getCourses(term: Term): { data: Course[]; fetchedAt: string } | undefined {
    return this.getView("courses", term);
  }

  /** 학기 수강 과목 저장본을 바꾼다. 반환은 replaceTimetable과 같다(같아도 fetched_at은 갱신). */
  replaceCourses(term: Term, courses: Course[], fetchedAt: string): "new" | "updated" | "same" {
    return this.replaceView("courses", term, courses, fetchedAt);
  }

  /** 성적 저장본(전체 학기). 읽은 시점의 학기 키로 둔다. 없거나 스키마에 맞지 않으면 undefined. */
  getGrades(term: Term): { data: Grades; fetchedAt: string } | undefined {
    return this.getView("grades", term);
  }

  replaceGrades(term: Term, grades: Grades, fetchedAt: string): "new" | "updated" | "same" {
    return this.replaceView("grades", term, grades, fetchedAt);
  }

  private getView<K extends ViewKind>(
    kind: K,
    term: Term,
  ): { data: z.infer<(typeof VIEW_SCHEMAS)[K]>; fetchedAt: string } | undefined {
    const row = this.db
      .prepare("SELECT data, fetched_at FROM views WHERE kind = ? AND year = ? AND semester = ?")
      .get(kind, term.year, term.semester) as { data: string; fetched_at: string } | undefined;
    if (!row) return undefined;
    let json: unknown;
    try {
      json = JSON.parse(row.data);
    } catch {
      return undefined;
    }
    // 다른 버전이 쓴 형식이거나 손상됐으면 저장본이 없는 것으로 보고 다시 읽게 한다.
    const parsed = VIEW_SCHEMAS[kind].safeParse(json);
    return parsed.success ? { data: parsed.data as z.infer<(typeof VIEW_SCHEMAS)[K]>, fetchedAt: row.fetched_at } : undefined;
  }

  private replaceView(kind: ViewKind, term: Term, data: unknown, fetchedAt: string): "new" | "updated" | "same" {
    const json = JSON.stringify(data);
    return this.transaction(() => {
      const prev = this.db
        .prepare("SELECT data FROM views WHERE kind = ? AND year = ? AND semester = ?")
        .get(kind, term.year, term.semester) as { data: string } | undefined;
      this.db
        .prepare(
          `INSERT INTO views (kind, year, semester, data, fetched_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (kind, year, semester) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`,
        )
        .run(kind, term.year, term.semester, json, fetchedAt);
      return !prev ? "new" : prev.data === json ? "same" : "updated";
    });
  }

  /** 학기 E클래스 동기화를 (취소·강의 실패 없이) 마친 시각을 남긴다. */
  markEclassSynced(term: Term, syncedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO eclass_syncs (year, semester, synced_at) VALUES (?, ?, ?)
         ON CONFLICT (year, semester) DO UPDATE SET synced_at = excluded.synced_at`,
      )
      .run(term.year, term.semester, syncedAt);
  }

  /** 학기 E클래스 동기화를 끝까지 돌았지만 실패한 강의가 있었던 시각을 남긴다. */
  markEclassAttempted(term: Term, attemptedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO eclass_sync_attempts (year, semester, attempted_at) VALUES (?, ?, ?)
         ON CONFLICT (year, semester) DO UPDATE SET attempted_at = excluded.attempted_at`,
      )
      .run(term.year, term.semester, attemptedAt);
  }

  /** 학기 E클래스 동기화를 마지막으로 (실패한 강의와 함께) 시도한 시각. 없으면 undefined. */
  getEclassAttemptedAt(term: Term): string | undefined {
    const row = this.db
      .prepare("SELECT attempted_at FROM eclass_sync_attempts WHERE year = ? AND semester = ?")
      .get(term.year, term.semester) as { attempted_at: string } | undefined;
    return row?.attempted_at;
  }

  /** 학기 강의의 과제 중 가장 최근에 포털에서 읽은 시각(다시 읽기 표시 행 제외). 없으면 undefined. */
  newestAssignmentFetchedAt(term: Term): string | undefined {
    const row = this.db
      .prepare(
        `SELECT MAX(a.fetched_at) AS t FROM assignments a JOIN courses c ON c.lecture_seq = a.lecture_seq
         WHERE c.year = ? AND c.semester = ? AND a.fetched_at <> ?`,
      )
      .get(term.year, term.semester, STALE_MARK) as { t: string | null };
    return row.t ?? undefined;
  }

  /** 학기 E클래스 동기화를 마지막으로 마친 시각. 없으면 undefined. */
  getEclassSyncedAt(term: Term): string | undefined {
    const row = this.db
      .prepare("SELECT synced_at FROM eclass_syncs WHERE year = ? AND semester = ?")
      .get(term.year, term.semester) as { synced_at: string } | undefined;
    return row?.synced_at;
  }

  private static readonly STORED_ASSIGNMENT_SELECT = `SELECT a.lecture_seq, c.course_name, c.professor, a.report_seq, a.title,
      a.start_at, a.due_at, a.extended_due_at, a.submit_status, a.submitted_count, a.total_count, a.scored`;

  private static storedAssignment(r: Record<string, unknown>): StoredAssignment {
    const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
    const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
    return {
      lectureSeq: String(r["lecture_seq"]),
      courseName: String(r["course_name"]),
      professor: str(r["professor"]),
      reportSeq: String(r["report_seq"]),
      title: String(r["title"]),
      startAt: str(r["start_at"]),
      dueAt: str(r["due_at"]),
      extendedDueAt: str(r["extended_due_at"]),
      submitStatus: String(r["submit_status"]),
      submittedCount: num(r["submitted_count"]),
      totalCount: num(r["total_count"]),
      scored: r["scored"] === null || r["scored"] === undefined ? null : Number(r["scored"]) === 1,
    };
  }

  /** 학기 강의의 저장된 과제. 강의 번호 → 과제 번호 내림차순(포털 목록처럼 최신 과제 먼저). */
  listAssignments(term: Term): StoredAssignment[] {
    const rows = this.db
      .prepare(
        `${ArchiveDb.STORED_ASSIGNMENT_SELECT}
         FROM assignments a JOIN courses c ON c.lecture_seq = a.lecture_seq
         WHERE c.year = ? AND c.semester = ?
         ORDER BY CAST(c.lecture_seq AS INTEGER), CAST(a.report_seq AS INTEGER) DESC`,
      )
      .all(term.year, term.semester) as Record<string, unknown>[];
    return rows.map((r) => ArchiveDb.storedAssignment(r));
  }

  /** 과제 상세 저장본(본문 텍스트·첨부 이름과 원본 링크 포함). 없으면 undefined. */
  getAssignmentDetail(reportSeq: string): StoredAssignmentDetail | undefined {
    const row = this.db
      .prepare(
        `${ArchiveDb.STORED_ASSIGNMENT_SELECT}, a.penalty_note, a.content_text, a.fetched_at
         FROM assignments a JOIN courses c ON c.lecture_seq = a.lecture_seq WHERE a.report_seq = ?`,
      )
      .get(reportSeq) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const attachments = this.db
      .prepare("SELECT name, url FROM attachments WHERE owner_type = 'assignment' AND owner_key = ? ORDER BY position")
      .all(reportSeq) as { name: string; url: string }[];
    return {
      ...ArchiveDb.storedAssignment(row),
      penaltyNote: row["penalty_note"] === null ? null : String(row["penalty_note"]),
      contentText: String(row["content_text"]),
      attachments: attachments.map((a) => ({ name: a.name, url: a.url })),
      fetchedAt: String(row["fetched_at"]),
    };
  }

  /** 강의 행이 있는가(과제를 저장할 수 있는지 — 외래키). */
  hasCourse(lectureSeq: string): boolean {
    return this.db.prepare("SELECT 1 FROM courses WHERE lecture_seq = ?").get(lectureSeq) !== undefined;
  }

  /**
   * 제출을 보낸 과제: 다음 get_assignment가 포털에서 다시 읽도록 오래된 것으로 표시한다.
   * confirmed(포털에서 반영을 확인함)일 때만 상태도 제출로 바꾼다.
   */
  markSubmitted(reportSeq: string, confirmed: boolean): void {
    this.db
      .prepare(
        `UPDATE assignments SET fetched_at = ?, submit_status = CASE WHEN ? THEN 'submitted' ELSE submit_status END
         WHERE report_seq = ?`,
      )
      .run(STALE_MARK, confirmed ? 1 : 0, reportSeq);
  }

  /** 목록에서 본 제출현황만 맞춘다(상세를 다시 읽지 않은 과제). null이면 저장값 유지. */
  updateAssignmentCounts(reportSeq: string, submittedCount: number | null, totalCount: number | null): void {
    this.db
      .prepare(
        `UPDATE assignments SET submitted_count = COALESCE(?, submitted_count), total_count = COALESCE(?, total_count)
         WHERE report_seq = ?`,
      )
      .run(submittedCount, totalCount, reportSeq);
  }

  /** 테스트·진단용 단순 조회. */
  all<T = Record<string, unknown>>(sql: string, ...params: Array<string | number | null>): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }
}
