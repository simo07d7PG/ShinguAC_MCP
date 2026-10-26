import { z } from "zod";
import { LoginFailedError, SessionExpiredError } from "../auth/errors.js";
import type { SessionManager } from "../auth/session-manager.js";
import { HttpStatusError, NetworkError, TimeoutError } from "../http/errors.js";
import type { HttpClient } from "../http/http-client.js";
import { logger as defaultLogger } from "../log/logger.js";
import { redact } from "../log/redact.js";
import { buildAssignments, type HomeworkDetail } from "../parsers/assignments.js";
import { ParseError } from "../parsers/common.js";
import { mergeCourseContacts } from "../parsers/courses.js";
import { buildCmsUrl, parseNoticeId } from "../parsers/notices.js";
import { fetchCurrentCourses } from "../portal/courses.js";
import {
  enterLecture,
  fetchEclassBoardDetail,
  fetchEclassBoardList,
  fetchEclassHome,
  fetchHomeworkDetail,
  fetchHomeworkList,
  fetchProfessorIntro,
  fetchSyllabus,
} from "../portal/eclass.js";
import { fetchGrades } from "../portal/grades.js";
import { fetchCmsNoticeDetail, fetchDashboardNotices } from "../portal/notices.js";
import { currentAcademicTerm, parseSemesterArg } from "../portal/semester.js";
import { fetchTimetable } from "../portal/timetable.js";
import type {
  Assignment,
  Category,
  CategoryData,
  Course,
  Grades,
  Meta,
  NoticeDetail,
  NoticeSummary,
  TimetableEntry,
} from "../schema/index.js";
import type { SnapshotRecord, SnapshotStore } from "../store/snapshot-store.js";
import { nowKst } from "../util/time.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DETAIL_DAYS = 14;

type Logger = Pick<typeof defaultLogger, "debug" | "info" | "warn">;

export interface CategoryServiceOptions {
  session: SessionManager;
  /** 로그인 불필요 요청(공개 CMS 공지)에 쓰는 클라이언트. 보통 session과 같은 HttpClient. */
  client: HttpClient;
  store: SnapshotStore;
  now?: () => Date;
  logger?: Logger;
}

export interface Result<T> {
  data: T;
  meta: Meta;
}

export interface RefreshSummary {
  category: Category;
  ok: boolean;
  fetchedAt?: string;
  error?: string;
}

/** 포털 장애·파서 예외처럼 스냅샷으로 대체할 수 있는 오류인가. 설정·자격증명 오류는 사용자가 조치해야 하므로 제외. */
function isFallbackError(err: unknown): boolean {
  return (
    err instanceof NetworkError ||
    err instanceof TimeoutError ||
    err instanceof HttpStatusError ||
    err instanceof SessionExpiredError ||
    err instanceof LoginFailedError ||
    err instanceof ParseError ||
    err instanceof z.ZodError
  );
}

function errorSummary(err: unknown): string {
  return redact(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
}

function inRange(iso: string | null, from: number, to: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return t >= from && t <= to;
}

export class CategoryService {
  private readonly session: SessionManager;
  private readonly client: HttpClient;
  private readonly store: SnapshotStore;
  private readonly now: () => Date;
  private readonly logger: Logger;

  constructor(options: CategoryServiceOptions) {
    this.session = options.session;
    this.client = options.client;
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? defaultLogger;
  }

  /**
   * 과제: 1(E클래스 홈) + 과목당 2(진입·목록) + 상세 N.
   * 상세(제출 상태)는 마감이 [now, now+dueWithinDays](미지정 14일) 안인 과제만 조회하고 나머지는 `unknown`.
   * 스냅샷은 필터 전 전체, 반환은 dueWithinDays 지정 시 그 범위만.
   */
  async getAssignments(opts: { dueWithinDays?: number } = {}): Promise<Result<Assignment[]>> {
    const result = await this.withSnapshot("assignments", async () => {
      const from = this.now().getTime();
      const to = from + (opts.dueWithinDays ?? DEFAULT_DETAIL_DAYS) * DAY_MS;
      const lectures = await fetchEclassHome(this.session, currentAcademicTerm(this.now()));
      const all: Assignment[] = [];
      for (const lecture of lectures) {
        await enterLecture(this.session, lecture.lectureSeq);
        const rows = await fetchHomeworkList(this.session);
        const details = new Map<string, HomeworkDetail>();
        for (const row of rows) {
          // 연장 기한이 있으면 그때까지 제출 가능하므로 연장 기한 기준으로 상세 조회 대상을 정한다.
          if (inRange(row.extendedDueAt ?? row.dueAt, from, to)) {
            details.set(row.reportSeq, await fetchHomeworkDetail(this.session, row.reportSeq));
          }
        }
        all.push(...buildAssignments(lecture, rows, details));
      }
      return all;
    });
    if (opts.dueWithinDays === undefined) return result;
    const from = this.now().getTime();
    const to = from + opts.dueWithinDays * DAY_MS;
    // 반환 필터도 연장 기한 기준(아직 제출 가능한 과제 포함).
    return { ...result, data: result.data.filter((a) => inRange(a.extendedDueAt ?? a.dueAt, from, to)) };
  }

  /** 시간표: 1요청. */
  getTimetable(): Promise<Result<TimetableEntry[]>> {
    return this.withSnapshot("timetable", async () => {
      const page = await fetchTimetable(this.session, currentAcademicTerm(this.now()));
      return page.entries;
    });
  }

  /** 수강 과목: 1(SSJ018P) + 1(E클래스 홈) [+ 매칭 과목당 3(진입·교수소개·수업계획서) — includeContacts]. */
  getCourses(opts: { includeContacts?: boolean } = {}): Promise<Result<Course[]>> {
    const includeContacts = opts.includeContacts ?? true;
    return this.withSnapshot("courses", async () => {
      const courses = await fetchCurrentCourses(this.session);
      const lectures = await fetchEclassHome(this.session, currentAcademicTerm(this.now()));
      const out: Course[] = [];
      for (const course of courses) {
        const lecture =
          lectures.find((l) => l.courseName === course.courseName && l.section === course.section) ??
          lectures.find((l) => l.courseName === course.courseName);
        if (!lecture) {
          out.push(course);
          continue;
        }
        let merged: Course = { ...course, lectureSeq: lecture.lectureSeq };
        if (includeContacts) {
          await enterLecture(this.session, lecture.lectureSeq);
          try {
            const intro = await fetchProfessorIntro(this.session);
            const syllabus = await fetchSyllabus(this.session);
            merged = mergeCourseContacts(merged, intro, syllabus);
          } catch (err) {
            // 연락처는 선택 필드라 한 과목 화면의 파싱 실패로 전체를 실패시키지 않는다.
            if (!(err instanceof ParseError)) throw err;
            this.logger.warn(`연락처 파싱 실패(${course.courseName})`, errorSummary(err));
          }
        }
        out.push(merged);
      }
      return out;
    });
  }

  /**
   * 공지 목록: 1(대시보드) [+ 1(E클래스 홈) + 과목당 2(진입·수업공지 목록) — includeEclass].
   * 스냅샷은 전체, 반환은 category 필터 → 게시일 내림차순 → limit.
   */
  async getNotices(
    opts: { category?: string; limit?: number; includeEclass?: boolean } = {},
  ): Promise<Result<NoticeSummary[]>> {
    const result = await this.withSnapshot("notices", async () => {
      const notices = await fetchDashboardNotices(this.session);
      if (opts.includeEclass) {
        const lectures = await fetchEclassHome(this.session, currentAcademicTerm(this.now()));
        for (const lecture of lectures) {
          await enterLecture(this.session, lecture.lectureSeq);
          notices.push(...(await fetchEclassBoardList(this.session, "1", lecture)));
        }
      }
      return notices;
    });
    const data = result.data
      .filter((n) => !opts.category || n.category === opts.category)
      .map((n, i) => ({ n, i }))
      .sort((a, b) => (b.n.postedAt ?? "").localeCompare(a.n.postedAt ?? "") || a.i - b.i)
      .map(({ n }) => n)
      .slice(0, opts.limit ?? 20);
    return { ...result, data };
  }

  /** 공지 본문: univ/scholarship → 공개 CMS 2요청(로그인 없음), eclass → 진입 + 본문 2요청. */
  getNotice(id: string): Promise<Result<NoticeDetail>> {
    const parsed = parseNoticeId(id);
    return this.withFallback(
      `notice ${id}`,
      async () => {
        const known = (await this.store.read("notices"))?.data.find((n) => n.id === id);
        if (parsed.category === "eclass") {
          const { lectureSeq, boardId, wrId } = parsed as Required<typeof parsed>;
          const summary: NoticeSummary = known ?? {
            id,
            category: "eclass",
            title: "",
            postedAt: null,
            url: `/eclass/clas/board/detail?boardId=${boardId}&wrId=${wrId}`,
          };
          await enterLecture(this.session, lectureSeq);
          return fetchEclassBoardDetail(this.session, boardId, wrId, summary);
        }
        const summary: NoticeSummary = known ?? {
          id,
          category: parsed.category,
          title: "",
          postedAt: null,
          url: buildCmsUrl(parsed.category, parsed.bbsSeq!),
        };
        return fetchCmsNoticeDetail(this.client, summary);
      },
      (detail, fetchedAt) => this.store.writeNotice(id, detail, fetchedAt),
      () => this.store.readNotice(id),
    );
  }

  /** 성적: 3요청. semester(`YYYY-H`) 지정 시 해당 학기 행만 반환(이수학점 "전체" 합계 행은 유지). */
  async getGrades(opts: { semester?: string } = {}): Promise<Result<Grades>> {
    const term = opts.semester === undefined ? undefined : parseSemesterArg(opts.semester);
    const result = await this.withSnapshot("grades", () => fetchGrades(this.session));
    if (!term) return result;
    const match = (r: { year?: number; semester?: string }): boolean =>
      r.year === term.year && r.semester === term.semester;
    const g = result.data;
    return {
      ...result,
      data: {
        semesters: g.semesters.filter(match),
        credits: g.credits.filter((c) => c.total || match(c)),
        current: g.current.filter(match),
      },
    };
  }

  /** 5개 범주를 순차로 수집한다. 스냅샷으로 대체된 범주는 ok=false. */
  async refreshAll(): Promise<RefreshSummary[]> {
    const jobs: Array<[Category, () => Promise<Result<unknown>>]> = [
      ["assignments", () => this.getAssignments()],
      ["timetable", () => this.getTimetable()],
      ["courses", () => this.getCourses()],
      ["notices", () => this.getNotices()],
      ["grades", () => this.getGrades()],
    ];
    const out: RefreshSummary[] = [];
    for (const [category, job] of jobs) {
      try {
        const { meta } = await job();
        out.push(
          meta.stale
            ? { category, ok: false, error: meta.warning ?? "스냅샷으로 대체됨" }
            : { category, ok: true, fetchedAt: meta.fetchedAt },
        );
      } catch (err) {
        out.push({ category, ok: false, error: errorSummary(err) });
      }
    }
    return out;
  }

  private withSnapshot<K extends Category>(
    category: K,
    fetcher: () => Promise<CategoryData[K]>,
  ): Promise<Result<CategoryData[K]>> {
    return this.withFallback(
      category,
      fetcher,
      (data, fetchedAt) => this.store.write(category, data, fetchedAt),
      () => this.store.read(category),
    );
  }

  /** live 성공 → 스냅샷 저장 후 live 메타. fallback 대상 오류 → 스냅샷(stale), 스냅샷이 없으면 원 오류. */
  private async withFallback<T>(
    label: string,
    fetcher: () => Promise<T>,
    write: (data: T, fetchedAt: string) => Promise<void>,
    read: () => Promise<SnapshotRecord<T> | null>,
  ): Promise<Result<T>> {
    let data: T;
    try {
      data = await fetcher();
    } catch (err) {
      if (!isFallbackError(err)) throw err;
      const summary = errorSummary(err);
      const snap = await read();
      if (!snap) {
        this.logger.warn(`${label}: live 실패, 스냅샷 없음`, summary);
        throw err;
      }
      this.logger.warn(`${label}: live 실패, 스냅샷 사용`, summary);
      return {
        data: snap.data,
        meta: {
          fetchedAt: snap.fetchedAt,
          stale: true,
          source: "snapshot",
          warning: `포털 조회 실패로 저장된 스냅샷을 반환합니다 (${summary})`,
        },
      };
    }
    const fetchedAt = nowKst(this.now());
    await write(data, fetchedAt);
    this.logger.debug(`${label}: live 수집 완료`);
    return { data, meta: { fetchedAt, stale: false, source: "live" } };
  }
}
