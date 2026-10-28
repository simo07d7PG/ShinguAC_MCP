import { existsSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, posix, resolve, sep } from "node:path";
import type { SessionManager } from "../auth/session-manager.js";
import { ConfigError } from "../config/config.js";
import { AbortError } from "../http/errors.js";
import { DOWNLOAD_TEMP_RE, type HttpClient } from "../http/http-client.js";
import { logger as defaultLogger } from "../log/logger.js";
import { redact } from "../log/redact.js";
import { effectiveDeadline, keepSubmitted, needsSubmitProbe, parseHomeworkDetail, type HomeworkRow } from "../parsers/assignments.js";
import { ParseError, fragmentToText } from "../parsers/common.js";
import type { EclassLecture } from "../parsers/eclass.js";
import { parseNoticeId } from "../parsers/notices.js";
import { judgeSubmission, type FileDetail, type SubmitForm } from "../parsers/submit.js";
import { fetchCoursesWithLectures } from "../portal/courses.js";
import { enterLecture, fetchEclassBoardAll, fetchEclassBoardPost, fetchEclassHome, fetchHomeworkList } from "../portal/eclass.js";
import { fetchGrades } from "../portal/grades.js";
import { currentAcademicTerm, type AcademicTerm } from "../portal/semester.js";
import { fetchFileInfo, fetchHomeworkDetailHtml, fetchSubmissionForm } from "../portal/submit.js";
import { fetchTimetable } from "../portal/timetable.js";
import { PORTAL_ORIGIN } from "../portal/urls.js";
import type { ArchiveDb, Board, PendingAttachment } from "../store/archive-db.js";
import { BOARD_IDS, isStale, RETRY_BACKOFF_MS } from "../store/archive-db.js";
import { Mutex } from "../util/mutex.js";
import { nowKst } from "../util/time.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** 증분 동기화에서도 다시 읽는 게시글의 등록일 범위(일). 수정은 게시 직후에 몰린다고 본다. */
export const POST_RECHECK_DAYS = 14;
/** 시작할 때 지우는 다운로드 임시 파일의 최소 경과 시간. */
const PART_FILE_GRACE_MS = 10 * 60 * 1000;

type Logger = Pick<typeof defaultLogger, "debug" | "info" | "warn">;

export interface SyncOptions {
  /** false면 첨부 메타데이터만 저장하고 파일은 받지 않는다(다음 동기화에서 받음). 기본 true. */
  downloadFiles?: boolean;
  /** true면 이미 저장한 게시글·지난 과제도 다시 읽는다. 기본 false(증분). */
  full?: boolean;
  /** abort되면 다음 경계(강의·과제·게시글·첨부 전)에서 멈추고 `cancelled: true` 요약을 돌려준다. 받던 첨부도 끊는다. */
  signal?: AbortSignal;
  /** 진행률. progress는 줄지 않고 total ≥ progress. total은 첨부 수를 알게 되면 늘어난다. */
  onProgress?: (p: SyncProgress) => void;
}

export interface SyncProgress {
  progress: number;
  total: number;
  message: string;
}

/** 저장본 하나(시간표·수강 과목·성적)의 갱신 결과. */
export type ViewRefresh<T> = (T & { status: "new" | "updated" | "same" }) | { status: "failed"; error: string };

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
  /** 이번 학기 시간표 갱신 결과. 취소로 시작하지 못했으면 없다. */
  timetable?: ViewRefresh<{ entries: number }>;
  /** 이번 학기 수강 과목(연락처 포함) 갱신 결과. 취소로 시작하지 못했으면 없다. */
  enrolledCourses?: ViewRefresh<{ entries: number }>;
  /** 성적 갱신 결과(semesters: 학기별 성적 행 수). 취소로 시작하지 못했으면 없다. */
  grades?: ViewRefresh<{ semesters: number }>;
  /** 도중에 취소됐으면 true. 그때까지 저장한 것은 남는다. */
  cancelled?: boolean;
}

/** 누적 진행률 하나. 단계마다 progress를 1 올리고, 새로 알게 된 작업만큼 total을 늘린다. */
class ProgressCounter {
  private progress = 0;
  private total = 0;
  private reported = false;
  constructor(private readonly onProgress?: (p: SyncProgress) => void) {}

  /** 총량만 늘린다. 진행률이 그대로인 알림은 보내지 않는다(첫 알림만 예외 — 진행률은 매번 증가해야 한다). */
  addTotal(n: number, message: string): void {
    this.total += n;
    if (!this.reported) this.report(message);
  }

  step(message: string): void {
    this.progress++;
    this.total = Math.max(this.total, this.progress);
    this.report(message);
  }

  private report(message: string): void {
    this.reported = true;
    this.onProgress?.({ progress: this.progress, total: this.total, message });
  }
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

const WIN_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d|conin\$|conout\$)(\..*)?$/i;

/** Windows·POSIX 모두에서 안전한 파일/폴더 이름. 경로 구분자·예약 이름·끝 점을 없애고 길이를 줄인다. */
export function safeName(name: string, maxLen = 120): string {
  let s = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "");
  if (!s || s === "." || s === "..") s = "file";
  if (WIN_RESERVED.test(s)) s = `_${s}`;
  if (s.length > maxLen) {
    const dot = s.lastIndexOf(".");
    const ext = dot > 0 && s.length - dot <= 16 ? s.slice(dot) : "";
    s = s.slice(0, maxLen - ext.length).replace(/[. ]+$/, "") + ext;
    if (!s || s === ext) s = `file${ext}`;
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
  /** E클래스 단계(DB 쓰기)는 한 번에 하나만 돈다. */
  private readonly syncLock = new Mutex();
  /** 첨부 다운로드는 같은 파일을 동시에 쓰지 않도록 한 번에 하나만 돈다(E클래스 단계와는 따로). */
  private readonly downloadLock = new Mutex();

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

  /**
   * 전체 동기화. E클래스 단계(시간표·수강 과목·성적 + 강의별 과제·게시글)는 syncLock 안에서 하고,
   * 첨부 다운로드는 그 잠금을 놓은 뒤 downloadLock 안에서 한다. 그래서 다운로드 중에도
   * get_assignments의 자동 동기화(syncIfStale)는 다른 동기화의 E클래스 단계만 기다린다.
   */
  async sync(opts: SyncOptions = {}): Promise<SyncSummary> {
    const progress = new ProgressCounter(opts.onProgress);
    // 임시 파일 정리는 다른 sync_eclass가 받는 중인 파일을 건드리지 않도록 downloadLock을 기다린다(의도된 대기).
    if (!opts.signal?.aborted) await this.downloadLock.run(() => this.removePartFiles());
    const phase = await this.syncLock.run(() => this.runEclassPhase(opts, progress, true));
    let { cancelled } = phase;
    let files: SyncSummary["files"];
    if (cancelled || opts.downloadFiles === false) {
      files = { downloaded: 0, reused: 0, failed: 0, pending: this.db.pendingAttachments().length };
    } else {
      const res = await this.downloadLock.run(() => this.downloadPending(phase.summary.warnings, opts.signal, progress));
      files = res.files;
      cancelled = res.cancelled;
    }
    if (cancelled) {
      this.logger.info(
        `아카이브: 동기화 취소됨(강의 ${phase.summary.courses.length + phase.summary.skippedEmptyCourses}/${phase.lectures}개, 첨부 ${files.downloaded + files.reused}개 처리)`,
      );
    }
    return { ...phase.summary, files, ...(cancelled ? { cancelled: true } : {}) };
  }

  /**
   * 이번 학기 동기화 기록이 없거나 STALE_MS보다 오래됐을 때만 E클래스 과제·게시글 단계를 돈다
   * (시간표·수강 과목·성적은 각 조회 도구가 스스로 갱신하므로 건너뛰고, 첨부 파일은 받지 않는다).
   * 기록이 신선하면 잠금을 기다리지 않고 바로 돌아오며, 잠금 안에서 다시 확인해 겹친 호출이 두 번 동기화하지 않는다.
   * 동기화했으면 요약, 아니면 undefined.
   */
  async syncIfStale(opts: Pick<SyncOptions, "signal" | "onProgress"> = {}): Promise<SyncSummary | undefined> {
    // 성공한 동기화는 STALE_MS, 실패한 강의가 있던 시도는 RETRY_BACKOFF_MS 동안 신선한 것으로 본다.
    const stale = (): boolean => {
      const term = currentAcademicTerm(this.now());
      return (
        isStale(this.db.getEclassSyncedAt(term), this.now()) &&
        isStale(this.db.getEclassAttemptedAt(term), this.now(), RETRY_BACKOFF_MS)
      );
    };
    if (!stale()) return undefined;
    const phase = await this.syncLock.run(async () =>
      stale() ? this.runEclassPhase(opts, new ProgressCounter(opts.onProgress), false) : undefined,
    );
    if (!phase) return undefined;
    return {
      ...phase.summary,
      files: { downloaded: 0, reused: 0, failed: 0, pending: this.db.pendingAttachments().length },
      ...(phase.cancelled ? { cancelled: true } : {}),
    };
  }

  /** E클래스 단계. syncLock 안에서 호출한다. views=false면 시간표·수강 과목·성적 갱신을 건너뛴다. */
  private async runEclassPhase(
    opts: SyncOptions,
    progress: ProgressCounter,
    views: boolean,
  ): Promise<{ summary: Omit<SyncSummary, "files" | "cancelled">; cancelled: boolean; lectures: number }> {
    const term = currentAcademicTerm(this.now());
    const syncedAt = nowKst(this.now());
    const warnings: string[] = [];
    const { signal } = opts;
    const courses: CourseSyncSummary[] = [];
    let skippedEmptyCourses = 0;
    let cancelled = signal?.aborted ?? false;
    // 시간표·수강 과목·성적은 강의 동기화 전에 갱신한다(각각 실패해도 계속).
    const view = async <T>(label: string, fn: () => Promise<T & { status: "new" | "updated" | "same" }>) => {
      if (!views || cancelled) return undefined;
      const r = await this.refreshView(label, warnings, fn);
      cancelled ||= signal?.aborted ?? false;
      return r;
    };
    const timetable = await view("시간표", () => this.syncTimetable(term));
    const enrolledCourses = await view("수강 과목", () => this.syncCourses(term));
    const grades = await view("성적", () => this.syncGrades(term));
    const lectures = cancelled ? [] : await this.eclassLock.run(() => fetchEclassHome(this.session, term));
    progress.addTotal(lectures.length, `강의 ${lectures.length}개`);
    for (const lecture of lectures) {
      if (signal?.aborted) {
        cancelled = true;
        break;
      }
      try {
        const summary = await this.eclassLock.run(() =>
          this.syncLecture(lecture, term, syncedAt, opts.full ?? false, warnings, signal),
        );
        if (summary) courses.push(summary);
        else skippedEmptyCourses++;
      } catch (err) {
        // 취소는 과목 실패가 아니다. 그때까지 저장한 것은 그대로 두고 멈춘다.
        if (err instanceof AbortError) {
          cancelled = true;
          break;
        }
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
      progress.step(`${lecture.courseName} 완료`);
    }
    // 조회 도구(get_assignments)가 저장본의 신선도를 판단하는 기준.
    // 강의를 끝까지 돌지 못했거나(취소) 실패한 강의가 있으면 남기지 않는다(다음 조회가 다시 동기화한다).
    // 실패한 강의가 있으면 시도 시각만 남겨, 한동안(RETRY_BACKOFF_MS) 매 조회마다 다시 돌지 않게 한다.
    if (!cancelled) {
      if (courses.every((c) => c.error === undefined)) this.db.markEclassSynced(term, syncedAt);
      else this.db.markEclassAttempted(term, syncedAt);
    }
    return {
      summary: {
        term: `${term.year}-${term.semester}`,
        syncedAt,
        courses,
        skippedEmptyCourses,
        warnings,
        dbPath: this.dbPath,
        filesDir: this.filesDir,
        ...(timetable ? { timetable } : {}),
        ...(enrolledCourses ? { enrolledCourses } : {}),
        ...(grades ? { grades } : {}),
      },
      cancelled,
      lectures: lectures.length,
    };
  }

  /** 저장본 하나를 갱신한다. 실패해도 E클래스 동기화는 계속하고 경고만 남긴다(자격증명 오류는 멈춤, 저장본은 그대로). */
  private async refreshView<T>(
    label: string,
    warnings: string[],
    fn: () => Promise<T & { status: "new" | "updated" | "same" }>,
  ): Promise<ViewRefresh<T>> {
    try {
      return await fn();
    } catch (err) {
      if (isFatal(err)) throw err;
      const error = errorSummary(err);
      warnings.push(`${label}을(를) 갱신하지 못했습니다(저장본은 그대로): ${error}`);
      return { status: "failed", error };
    }
  }

  /** 이번 학기 시간표(요청 1회). */
  private async syncTimetable(term: AcademicTerm): Promise<{ entries: number; status: "new" | "updated" | "same" }> {
    const page = await fetchTimetable(this.session, term);
    return { entries: page.entries.length, status: this.db.replaceTimetable(term, page.entries, nowKst(this.now())) };
  }

  /** 이번 학기 수강 과목(연락처 포함): 2 + 매칭 과목당 3요청. 강의 진입이 있어 eclassLock 안에서 읽는다. */
  private async syncCourses(term: AcademicTerm): Promise<{ entries: number; status: "new" | "updated" | "same" }> {
    const fetchedAt = nowKst(this.now());
    const courses = await this.eclassLock.run(() =>
      fetchCoursesWithLectures(this.session, term, {
        includeContacts: true,
        onContactError: (c, err) => this.logger.warn(`아카이브: 연락처 파싱 실패(${c.courseName})`, errorSummary(err)),
      }),
    );
    return { entries: courses.length, status: this.db.replaceCourses(term, courses, fetchedAt) };
  }

  /** 성적(요청 3회). 전체 학기를 이번 학기 키로 저장한다. */
  private async syncGrades(term: AcademicTerm): Promise<{ semesters: number; status: "new" | "updated" | "same" }> {
    const fetchedAt = nowKst(this.now());
    const grades = await fetchGrades(this.session);
    return { semesters: grades.semesters.length, status: this.db.replaceGrades(term, grades, fetchedAt) };
  }

  /** 이전 동기화가 중단되며 남긴 다운로드 임시 파일을 지운다. 실패는 무시한다(다음 동기화에서 다시 시도). */
  private async removePartFiles(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.filesDir, { recursive: true });
    } catch {
      return;
    }
    // 최근에 바뀐 임시 파일은 다른 서버 인스턴스가 내려받는 중일 수 있어 남긴다(실제 시계 기준 — 파일 mtime과 비교).
    const cutoff = Date.now() - PART_FILE_GRACE_MS;
    await Promise.all(
      entries
        .filter((f) => DOWNLOAD_TEMP_RE.test(f))
        .map(async (f) => {
          const path = join(this.filesDir, f);
          try {
            if ((await stat(path)).mtimeMs <= cutoff) await rm(path, { force: true });
          } catch {
            // 그새 사라졌거나 지울 수 없으면 그대로 둔다.
          }
        }),
    );
  }

  /** 강의 하나. 과제·게시글이 하나도 없으면 저장하지 않고 null. eclassLock 안에서 호출한다. */
  private async syncLecture(
    lecture: EclassLecture,
    term: { year: number; semester: string },
    syncedAt: string,
    full: boolean,
    warnings: string[],
    signal: AbortSignal | undefined,
  ): Promise<CourseSyncSummary | null> {
    const checkAbort = (): void => {
      if (signal?.aborted) throw new AbortError();
    };
    await enterLecture(this.session, lecture.lectureSeq);
    const homework = await fetchHomeworkList(this.session);
    const lists = {
      notice: await fetchEclassBoardAll(this.session, BOARD_IDS.notice, lecture),
      material: await fetchEclassBoardAll(this.session, BOARD_IDS.material, lecture),
    };
    const boards = { notice: lists.notice.rows, material: lists.material.rows };
    if (homework.length === 0 && boards.notice.length === 0 && boards.material.length === 0) return null;
    for (const board of ["notice", "material"] as const) {
      const { rows, total } = lists[board];
      if (total > rows.length) {
        warnings.push(`${lecture.courseName} ${board === "notice" ? "수업공지" : "자료실"}: 목록 ${total}건 중 ${rows.length}건만 읽었습니다.`);
      }
    }

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
      if (!full && !this.needsAssignmentRefresh(row)) {
        // 상세는 다시 읽지 않지만 목록에 보이는 제출현황은 맞춰 둔다(요청 없음).
        this.db.updateAssignmentCounts(row.reportSeq, row.submittedCount, row.totalCount);
        continue;
      }
      checkAbort();
      const html = await fetchHomeworkDetailHtml(this.session, row.reportSeq);
      const d = parseHomeworkDetail(html);
      // 마감이 지나면 상세 화면에 제출 버튼이 모두 사라져 "기간 아님"으로 보이지만, 제출했다면 editModal에 내용이 남아 있다
      // (실측 2026-10-27: 마감 지난 25건 중 9건). 그런 과제는 제출 폼을 한 번 읽어 판정한다.
      let submission: { form: SubmitForm; files: FileDetail[] } | undefined;
      if (needsSubmitProbe(d.submitStatus, d.extendedDueAt ?? d.dueAt ?? row.extendedDueAt ?? row.dueAt, this.now())) {
        try {
          const form = await fetchSubmissionForm(this.session, html, row.reportSeq);
          if (form && judgeSubmission(form, d.submitStatus)) {
            const files = form.attach.fileMasterKey ? await fetchFileInfo(this.session, form.attach.fileMasterKey) : [];
            submission = { form, files };
          } else if (!form && d.submitStatus === "submitted") {
            warnings.push(`${label(`과제 ${row.reportSeq}`)}: 제출 내용을 읽지 못했습니다(제출 폼 형식 불일치)`);
          }
        } catch (err) {
          if (!(err instanceof ParseError)) throw err;
          if (d.submitStatus === "submitted") {
            warnings.push(`${label(`과제 ${row.reportSeq}`)}: 제출 내용을 읽지 못했습니다(${errorSummary(err)})`);
          }
        }
      }
      const submitStatus = keepSubmitted(this.db.getAssignmentState(row.reportSeq)?.submitStatus, submission ? "submitted" : d.submitStatus);
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
            submitStatus,
            submittedCount: d.submittedCount ?? row.submittedCount,
            totalCount: d.totalCount ?? row.totalCount,
            scored: d.scored,
          },
          fetchedAt,
        );
        const attChanged = this.db.replaceAttachments("assignment", row.reportSeq, lecture.lectureSeq, d.attachments);
        // 첨부만 바뀐 경우도 갱신으로 센다.
        return r === "same" && attChanged ? "updated" : r;
      });
      if (res !== "same") summary.assignments[res]++;

      if (!submission) continue;
      const { form, files } = submission;
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
        const attChanged = this.db.replaceAttachments("submission", row.reportSeq, lecture.lectureSeq, attachments);
        return r === "same" && attChanged ? "updated" : r;
      });
      if (sub !== "same") summary.submissions[sub]++;
    }

    for (const board of ["notice", "material"] as const satisfies readonly Board[]) {
      const counts = board === "notice" ? summary.notices : summary.materials;
      for (const item of boards[board]) {
        const { wrId } = parseNoticeId(item.id);
        if (!wrId) continue;
        if (!full && !this.needsPostRefresh(lecture.lectureSeq, board, wrId)) continue;
        checkAbort();
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
          const ownerKey = `${lecture.lectureSeq}:${board}:${wrId}`;
          const attChanged = this.db.replaceAttachments("post", ownerKey, lecture.lectureSeq, post.attachments);
          return r === "same" && attChanged ? "updated" : r;
        });
        if (res !== "same") counts[res]++;
      }
    }
    this.logger.info(`아카이브: ${lecture.courseName} 동기화 완료`);
    return summary;
  }

  /**
   * 증분 동기화에서 과제 상세를 다시 읽을지. 처음 보는 과제, 제출했는데 제출 내용이 아직 없는 과제,
   * 마감(연장 포함)이 없거나 하루 이상 지나지 않은 과제만 읽는다. 마감은 저장값과 방금 받은 목록 값을 모두 본다
   * (마감 뒤에 연장기한이 생기면 목록에만 먼저 보인다). 마감이 지난 과제는 더 바뀌지 않는다고 본다.
   */
  private needsAssignmentRefresh(row: HomeworkRow): boolean {
    const state = this.db.getAssignmentState(row.reportSeq);
    if (!state) return true;
    if (state.submitStatus === "submitted" && !this.db.hasSubmission(row.reportSeq)) return true;
    const open = (iso: string | null): boolean => {
      const deadline = effectiveDeadline(iso);
      return deadline === null || this.now().getTime() <= Date.parse(deadline) + DAY_MS;
    };
    return open(state.extendedDueAt ?? state.dueAt) || open(row.extendedDueAt ?? row.dueAt);
  }

  /**
   * 증분 동기화에서 게시글 본문을 다시 읽을지. 처음 보는 글과 등록일시가 POST_RECHECK_DAYS일 이내인 글만 읽는다
   * (바뀌지 않았으면 upsertPost가 "same"이라 갱신·재다운로드 없음). 등록일시를 모르는 저장 글은 다시 읽지 않는다.
   */
  private needsPostRefresh(lectureSeq: string, board: Board, wrId: string): boolean {
    const postedAt = this.db.getPostPostedAt(lectureSeq, board, wrId);
    if (postedAt === undefined) return true;
    if (postedAt === null) return false;
    const t = Date.parse(postedAt);
    return !Number.isNaN(t) && t >= this.now().getTime() - POST_RECHECK_DAYS * DAY_MS;
  }

  /** DB에서 아직 받지 않은 첨부를 차례로 내려받는다. 실패한 것은 다음 동기화에서 다시 시도한다. 취소는 실패로 기록하지 않는다. */
  private async downloadPending(
    warnings: string[],
    signal: AbortSignal | undefined,
    progress: ProgressCounter,
  ): Promise<{ files: SyncSummary["files"]; cancelled: boolean }> {
    const out = { downloaded: 0, reused: 0, failed: 0, pending: 0 };
    let cancelled = false;
    const pending = this.db.pendingAttachments();
    progress.addTotal(pending.length, `첨부 ${pending.length}개`);
    for (const [i, att] of pending.entries()) {
      if (signal?.aborted) {
        cancelled = true;
        break;
      }
      try {
        const rel = this.relativePathFor(att);
        const dest = resolve(this.filesDir, rel);
        if (!dest.startsWith(this.filesDir + sep)) throw new Error(`저장 경로가 files 디렉터리 밖입니다: ${rel}`);
        await mkdir(dirname(dest), { recursive: true });
        const { size, sha256 } = await this.client.download(att.url, dest, signal ? { signal } : {});
        let localPath = rel;
        const same = this.db.findDownloadedBySha(sha256);
        if (same && same !== rel && existsSync(join(this.filesDir, same))) {
          await rm(dest, { force: true });
          localPath = same;
          out.reused++;
        } else {
          out.downloaded++;
        }
        this.db.markDownloaded(att.id, { localPath, size, sha256, downloadedAt: nowKst(this.now()), url: att.url });
      } catch (err) {
        if (err instanceof AbortError || signal?.aborted) {
          cancelled = true;
          break;
        }
        if (isFatal(err)) throw err;
        const msg = errorSummary(err);
        this.db.markDownloadFailed(att.id, msg);
        warnings.push(`${att.courseName} 첨부 "${att.name}" 다운로드 실패: ${msg}`);
        out.failed++;
      }
      // 제출 파일 이름에는 학번·이름이 들어 있을 수 있어 진행률에는 번호만 싣는다.
      progress.step(`첨부 ${i + 1}/${pending.length}`);
    }
    out.pending = this.db.pendingAttachments().length;
    return { files: out, cancelled };
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
