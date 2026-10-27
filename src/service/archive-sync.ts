import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, posix, resolve, sep } from "node:path";
import type { SessionManager } from "../auth/session-manager.js";
import { ConfigError } from "../config/config.js";
import type { HttpClient } from "../http/http-client.js";
import { logger as defaultLogger } from "../log/logger.js";
import { redact } from "../log/redact.js";
import { effectiveDeadline, parseHomeworkDetail } from "../parsers/assignments.js";
import { ParseError, fragmentToText } from "../parsers/common.js";
import type { EclassLecture } from "../parsers/eclass.js";
import { parseNoticeId } from "../parsers/notices.js";
import { parseSubmitControls } from "../parsers/submit.js";
import { enterLecture, fetchEclassBoardAll, fetchEclassBoardPost, fetchEclassHome, fetchHomeworkList } from "../portal/eclass.js";
import { currentAcademicTerm } from "../portal/semester.js";
import { fetchFileInfo, fetchHomeworkDetailHtml, fetchSubmitForm } from "../portal/submit.js";
import { PORTAL_ORIGIN } from "../portal/urls.js";
import type { ArchiveDb, Board, PendingAttachment } from "../store/archive-db.js";
import { BOARD_IDS } from "../store/archive-db.js";
import { Mutex } from "../util/mutex.js";
import { nowKst } from "../util/time.js";

const DAY_MS = 24 * 60 * 60 * 1000;

type Logger = Pick<typeof defaultLogger, "debug" | "info" | "warn">;

export interface SyncOptions {
  /** false면 첨부 메타데이터만 저장하고 파일은 받지 않는다(다음 동기화에서 받음). 기본 true. */
  downloadFiles?: boolean;
  /** true면 이미 저장한 게시글·지난 과제도 다시 읽는다. 기본 false(증분). */
  full?: boolean;
}

interface Counts {
  total: number;
  new: number;
  updated: number;
}

export interface CourseSyncSummary {
  lectureSeq: string;
  courseName: string;
  assignments: Counts;
  submissions: Omit<Counts, "total">;
  notices: Counts;
  materials: Counts;
  error?: string;
}

export interface SyncSummary {
  term: string;
  syncedAt: string;
  courses: CourseSyncSummary[];
  /** 과제·게시글이 하나도 없어 저장하지 않은 강의 수. */
  skippedEmptyCourses: number;
  files: { downloaded: number; reused: number; failed: number; pending: number };
  warnings: string[];
  dbPath: string;
  filesDir: string;
}

export interface ArchiveSyncOptions {
  session: SessionManager;
  client: HttpClient;
  db: ArchiveDb;
  dbPath: string;
  filesDir: string;
  /** CategoryService와 공유하는 강의 진입 잠금(세션의 "현재 강의"가 섞이지 않도록). */
  eclassLock: Mutex;
  now?: () => Date;
  logger?: Logger;
}

const errorSummary = (err: unknown): string =>
  redact(err instanceof Error ? `${err.name}: ${err.message}` : String(err));

/** 사용자가 조치해야 하는 오류(자격증명·설정)는 과목 단위로 넘기지 않고 동기화 전체를 멈춘다. */
const isFatal = (err: unknown): boolean =>
  err instanceof ConfigError || typeof (err as { userAction?: unknown } | null)?.userAction === "string";

const WIN_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** Windows·POSIX 모두에서 안전한 파일/폴더 이름. 경로 구분자·예약 이름·끝 점을 없애고 길이를 줄인다. */
export function safeName(name: string, maxLen = 120): string {
  let s = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "");
  if (!s || s === "." || s === "..") s = "file";
  if (WIN_RESERVED.test(s)) s = `_${s}`;
  if (s.length > maxLen) {
    const dot = s.lastIndexOf(".");
    const ext = dot > 0 && s.length - dot <= 16 ? s.slice(dot) : "";
    s = s.slice(0, maxLen - ext.length).trimEnd() + ext;
  }
  return s;
}

/**
 * E클래스 아카이브 동기화: 이번 학기 강의마다 과제방·수업공지·자료실을 읽어 DB에 저장하고 첨부를 내려받는다.
 * 요청: 1(E클래스 홈) + 과목당 [진입 1 + 과제 목록 1 + 게시판 목록 페이지 수 + 새/진행 중 과제 상세(+제출 폼·첨부 목록) + 새 게시글 본문].
 */
export class ArchiveSync {
  private readonly session: SessionManager;
  private readonly client: HttpClient;
  private readonly db: ArchiveDb;
  private readonly dbPath: string;
  private readonly filesDir: string;
  private readonly eclassLock: Mutex;
  private readonly now: () => Date;
  private readonly logger: Logger;
  /** 동기화 두 개가 겹치면 같은 파일을 동시에 쓰게 되므로 한 번에 하나만 돈다. */
  private readonly syncLock = new Mutex();

  constructor(options: ArchiveSyncOptions) {
    this.session = options.session;
    this.client = options.client;
    this.db = options.db;
    this.dbPath = options.dbPath;
    this.filesDir = resolve(options.filesDir);
    this.eclassLock = options.eclassLock;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? defaultLogger;
  }

  sync(opts: SyncOptions = {}): Promise<SyncSummary> {
    return this.syncLock.run(async () => {
      const term = currentAcademicTerm(this.now());
      const syncedAt = nowKst(this.now());
      const warnings: string[] = [];
      const lectures = await this.eclassLock.run(() => fetchEclassHome(this.session, term));
      const courses: CourseSyncSummary[] = [];
      let skippedEmptyCourses = 0;
      for (const lecture of lectures) {
        try {
          const summary = await this.eclassLock.run(() =>
            this.syncLecture(lecture, term, syncedAt, opts.full ?? false, warnings),
          );
          if (summary) courses.push(summary);
          else skippedEmptyCourses++;
        } catch (err) {
          if (isFatal(err)) throw err;
          this.logger.warn(`아카이브: ${lecture.courseName} 동기화 실패`, errorSummary(err));
          courses.push({
            lectureSeq: lecture.lectureSeq,
            courseName: lecture.courseName,
            assignments: { total: 0, new: 0, updated: 0 },
            submissions: { new: 0, updated: 0 },
            notices: { total: 0, new: 0, updated: 0 },
            materials: { total: 0, new: 0, updated: 0 },
            error: errorSummary(err),
          });
        }
      }
      const files =
        opts.downloadFiles === false
          ? { downloaded: 0, reused: 0, failed: 0, pending: this.db.pendingAttachments().length }
          : await this.downloadPending(warnings);
      return {
        term: `${term.year}-${term.semester}`,
        syncedAt,
        courses,
        skippedEmptyCourses,
        files,
        warnings,
        dbPath: this.dbPath,
        filesDir: this.filesDir,
      };
    });
  }

  /** 강의 하나. 과제·게시글이 하나도 없으면 저장하지 않고 null. eclassLock 안에서 호출한다. */
  private async syncLecture(
    lecture: EclassLecture,
    term: { year: number; semester: string },
    syncedAt: string,
    full: boolean,
    warnings: string[],
  ): Promise<CourseSyncSummary | null> {
    await enterLecture(this.session, lecture.lectureSeq);
    const homework = await fetchHomeworkList(this.session);
    const boards = {
      notice: await fetchEclassBoardAll(this.session, BOARD_IDS.notice, lecture),
      material: await fetchEclassBoardAll(this.session, BOARD_IDS.material, lecture),
    };
    if (homework.length === 0 && boards.notice.length === 0 && boards.material.length === 0) return null;

    this.db.upsertCourse(
      {
        lectureSeq: lecture.lectureSeq,
        courseName: lecture.courseName,
        year: term.year,
        semester: term.semester,
        section: lecture.section,
        professor: lecture.professorName || undefined,
      },
      syncedAt,
    );
    const summary: CourseSyncSummary = {
      lectureSeq: lecture.lectureSeq,
      courseName: lecture.courseName,
      assignments: { total: homework.length, new: 0, updated: 0 },
      submissions: { new: 0, updated: 0 },
      notices: { total: boards.notice.length, new: 0, updated: 0 },
      materials: { total: boards.material.length, new: 0, updated: 0 },
    };
    const label = (s: string): string => `${lecture.courseName} ${s}`;

    for (const row of homework) {
      if (!full && !this.needsAssignmentRefresh(row.reportSeq)) continue;
      const html = await fetchHomeworkDetailHtml(this.session, row.reportSeq);
      const d = parseHomeworkDetail(html);
      const fetchedAt = nowKst(this.now());
      const res = this.db.transaction(() => {
        const r = this.db.upsertAssignment(
          {
            reportSeq: row.reportSeq,
            lectureSeq: lecture.lectureSeq,
            title: d.title || row.title,
            startAt: d.startAt ?? row.startAt,
            dueAt: d.dueAt ?? row.dueAt,
            extendedDueAt: d.extendedDueAt ?? row.extendedDueAt,
            penaltyNote: d.penaltyNote ?? null,
            contentHtml: d.bodyHtml,
            contentText: fragmentToText(d.bodyHtml),
            submitStatus: d.submitStatus,
          },
          fetchedAt,
        );
        this.db.replaceAttachments("assignment", row.reportSeq, lecture.lectureSeq, d.attachments);
        return r;
      });
      if (res !== "same") summary.assignments[res]++;

      if (d.submitStatus !== "submitted") continue;
      try {
        const controls = parseSubmitControls(html);
        const form = await fetchSubmitForm(this.session, "edit", row.reportSeq, controls.reportNm);
        const files = form.attach.fileMasterKey ? await fetchFileInfo(this.session, form.attach.fileMasterKey) : [];
        const attachments = files
          .map((f) => ({ key: String(f["fileKey"] ?? ""), name: String(f["oriFileNm"] ?? f["fileKey"] ?? "") }))
          .filter((f) => f.key)
          .map((f) => ({ name: f.name, url: `${PORTAL_ORIGIN}/file/download?fileKey=${encodeURIComponent(f.key)}` }));
        const sub = this.db.transaction(() => {
          const r = this.db.upsertSubmission(
            {
              reportSeq: row.reportSeq,
              title: form.title,
              contentHtml: form.contentHtml,
              contentText: fragmentToText(form.contentHtml),
            },
            nowKst(this.now()),
          );
          this.db.replaceAttachments("submission", row.reportSeq, lecture.lectureSeq, attachments);
          return r;
        });
        if (sub !== "same") summary.submissions[sub]++;
      } catch (err) {
        if (!(err instanceof ParseError)) throw err;
        warnings.push(`${label(`과제 ${row.reportSeq}`)}: 제출 내용을 읽지 못했습니다(${errorSummary(err)})`);
      }
    }

    for (const board of ["notice", "material"] as const satisfies readonly Board[]) {
      const counts = board === "notice" ? summary.notices : summary.materials;
      for (const item of boards[board]) {
        const { wrId } = parseNoticeId(item.id);
        if (!wrId) continue;
        if (!full && this.db.hasPost(lecture.lectureSeq, board, wrId)) continue;
        const post = await fetchEclassBoardPost(this.session, BOARD_IDS[board], wrId);
        const res = this.db.transaction(() => {
          const r = this.db.upsertPost(
            {
              lectureSeq: lecture.lectureSeq,
              board,
              wrId,
              title: post.title || item.title,
              postedAt: post.postedAt ?? item.postedAt,
              author: post.author ?? null,
              bodyHtml: post.bodyHtml,
              bodyText: post.body,
            },
            nowKst(this.now()),
          );
          this.db.replaceAttachments("post", `${lecture.lectureSeq}:${board}:${wrId}`, lecture.lectureSeq, post.attachments);
          return r;
        });
        if (res !== "same") counts[res]++;
      }
    }
    this.logger.info(`아카이브: ${lecture.courseName} 동기화 완료`);
    return summary;
  }

  /**
   * 증분 동기화에서 과제 상세를 다시 읽을지. 처음 보는 과제, 마감(연장 포함)이 없거나 하루 이상 지나지 않은 과제,
   * 제출했는데 제출 내용이 아직 없는 과제만 읽는다. 마감이 지난 과제는 더 바뀌지 않는다고 본다.
   */
  private needsAssignmentRefresh(reportSeq: string): boolean {
    const state = this.db.getAssignmentState(reportSeq);
    if (!state) return true;
    if (state.submitStatus === "submitted" && !this.db.hasSubmission(reportSeq)) return true;
    const deadline = effectiveDeadline(state.extendedDueAt ?? state.dueAt);
    return deadline === null || this.now().getTime() <= Date.parse(deadline) + DAY_MS;
  }

  /** DB에서 아직 받지 않은 첨부를 차례로 내려받는다. 실패한 것은 다음 동기화에서 다시 시도한다. */
  private async downloadPending(warnings: string[]): Promise<SyncSummary["files"]> {
    const out = { downloaded: 0, reused: 0, failed: 0, pending: 0 };
    for (const att of this.db.pendingAttachments()) {
      try {
        const rel = this.relativePathFor(att);
        const dest = resolve(this.filesDir, rel);
        if (!dest.startsWith(this.filesDir + sep)) throw new Error(`저장 경로가 files 디렉터리 밖입니다: ${rel}`);
        await mkdir(dirname(dest), { recursive: true });
        const { size, sha256 } = await this.client.download(att.url, dest);
        let localPath = rel;
        const same = this.db.findDownloadedBySha(sha256);
        if (same && same !== rel && existsSync(join(this.filesDir, same))) {
          await rm(dest, { force: true });
          localPath = same;
          out.reused++;
        } else {
          out.downloaded++;
        }
        this.db.markDownloaded(att.id, { localPath, size, sha256, downloadedAt: nowKst(this.now()) });
      } catch (err) {
        if (isFatal(err)) throw err;
        const msg = errorSummary(err);
        this.db.markDownloadFailed(att.id, msg);
        warnings.push(`${att.courseName} 첨부 "${att.name}" 다운로드 실패: ${msg}`);
        out.failed++;
      }
    }
    out.pending = this.db.pendingAttachments().length;
    return out;
  }

  /** `<lectureSeq>_<과목명>/<assignments|submissions|notices|materials>/<번호>/<파일명>` (files 기준, `/` 구분 상대 경로). */
  private relativePathFor(att: PendingAttachment): string {
    const course = safeName(`${att.lectureSeq}_${att.courseName}`, 80);
    let dir: string;
    if (att.ownerType === "post") {
      const [, board, wrId] = att.ownerKey.split(":");
      dir = posix.join(board === "notice" ? "notices" : "materials", safeName(wrId ?? "unknown"));
    } else {
      dir = posix.join(att.ownerType === "assignment" ? "assignments" : "submissions", safeName(att.ownerKey));
    }
    const base = safeName(att.name);
    let rel = posix.join(course, dir, base);
    // 같은 글에 이름이 같은 첨부가 둘 이상이면 뒤에 번호를 붙인다.
    for (let n = 2; this.db.isPathTaken(rel, att.id); n++) {
      const dot = base.lastIndexOf(".");
      rel = posix.join(course, dir, dot > 0 ? `${base.slice(0, dot)} (${n})${base.slice(dot)}` : `${base} (${n})`);
    }
    return rel;
  }
}
