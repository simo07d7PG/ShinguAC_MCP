import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { LoginFailedError, SessionExpiredError, WriteSessionLostError } from "../auth/errors.js";
import type { SessionManager } from "../auth/session-manager.js";
import { HttpStatusError, NetworkError, TimeoutError } from "../http/errors.js";
import type { HttpClient } from "../http/http-client.js";
import { logger as defaultLogger } from "../log/logger.js";
import { redact } from "../log/redact.js";
import { buildAssignments, effectiveDeadline, parseHomeworkDetail, type HomeworkDetail } from "../parsers/assignments.js";
import { ParseError } from "../parsers/common.js";
import { mergeCourseContacts } from "../parsers/courses.js";
import { buildCmsUrl, parseNoticeId } from "../parsers/notices.js";
import {
  attachFields,
  extractAlert,
  parseSubmitControls,
  plainOf,
  textToHtml,
  type FileDetail,
} from "../parsers/submit.js";
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
import {
  fetchFileInfo,
  fetchFileMasterKey,
  fetchHomeworkDetailHtml,
  fetchSubmitForm,
  postReportSubmit,
  uploadAttachment,
} from "../portal/submit.js";
import { fetchTimetable } from "../portal/timetable.js";
import type {
  Assignment,
  AssignmentDetail,
  Category,
  CategoryData,
  Course,
  Grades,
  Meta,
  NoticeDetail,
  NoticeSummary,
  SubmitResult,
  TimetableEntry,
} from "../schema/index.js";
import type { SnapshotRecord, SnapshotStore } from "../store/snapshot-store.js";
import { Mutex } from "../util/mutex.js";
import { nowKst } from "../util/time.js";
import { loadUploadFile, PORTAL_WIDGET_MAX_BYTES } from "./upload-file.js";

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

export interface SubmitOptions {
  reportSeq: string;
  lectureSeq?: string;
  title: string;
  /** 평문. 줄마다 `<p>` 단락으로 바꿔 보낸다. */
  content: string;
  /** 첨부할 로컬 파일 절대 경로(포털 제한상 1개). */
  filePath?: string;
  /** 미리보기가 돌려준 토큰. 있을 때만(그리고 맞을 때만) 실제로 제출한다. */
  confirmToken?: string;
}

/** 미리보기 토큰 유효 시간. */
const PREVIEW_TTL_MS = 10 * 60 * 1000;

/** 제출 POST 뒤 포털을 다시 읽었더니 반영되지 않은 것이 확실한 경우. */
class SubmitNotAppliedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubmitNotAppliedError";
  }
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
  /**
   * `POST /eclass/clas/home`(강의 진입)은 세션에 "현재 강의"를 저장한다.
   * 진입~후속 `/eclass/clas/...` 요청 묶음이 병렬 호출과 섞이지 않도록 이 잠금 안에서만 실행한다.
   */
  private readonly eclassLock = new Mutex();
  /** 미리보기 토큰 서명 키. 프로세스마다 새로 만들어, 모델이 토큰을 지어낼 수 없게 한다. */
  private readonly previewSecret = randomBytes(32);

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
    const result = await this.withSnapshot("assignments", () => this.eclassLock.run(async () => {
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
          // 제출 시작 전(startAt > now)인 과제는 상세 없이 not_open으로 확정되므로 요청을 아낀다.
          const notOpenYet = row.startAt !== null && new Date(row.startAt).getTime() > from;
          if (!notOpenYet && inRange(row.extendedDueAt ?? row.dueAt, from, to)) {
            details.set(row.reportSeq, await fetchHomeworkDetail(this.session, row.reportSeq));
          }
        }
        all.push(...buildAssignments(lecture, rows, details, this.now()));
      }
      return all;
    }));
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
    return this.withSnapshot("courses", () => this.eclassLock.run(async () => {
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
    }));
  }

  /**
   * 공지 목록: 1(대시보드) [+ 1(E클래스 홈) + 과목당 2(진입·수업공지 목록) — includeEclass].
   * 스냅샷은 전체, 반환은 category 필터 → 게시일 내림차순 → limit.
   */
  async getNotices(
    opts: { category?: string; limit?: number; includeEclass?: boolean } = {},
  ): Promise<Result<NoticeSummary[]>> {
    const result = await this.withSnapshot("notices", () => this.eclassLock.run(async () => {
      const notices = await fetchDashboardNotices(this.session);
      if (opts.includeEclass) {
        const lectures = await fetchEclassHome(this.session, currentAcademicTerm(this.now()));
        for (const lecture of lectures) {
          await enterLecture(this.session, lecture.lectureSeq);
          notices.push(...(await fetchEclassBoardList(this.session, "1", lecture)));
        }
      }
      return notices;
    }));
    const data = result.data
      .filter((n) => !opts.category || n.category === opts.category)
      .map((n, i) => ({ n, i }))
      .sort((a, b) => (b.n.postedAt ?? "").localeCompare(a.n.postedAt ?? "") || a.i - b.i)
      .map(({ n }) => n)
      .slice(0, opts.limit ?? 20);
    return { ...result, data };
  }

  /**
   * 과제 상세(본문·첨부·제출 상태): 강의 진입 + 상세 = 2요청.
   * lectureSeq가 없으면 assignments 스냅샷에서 reportSeq로 찾는다(get_assignments를 먼저 호출해야 함).
   * 상세는 스냅샷을 두지 않으므로 포털 장애 시 fallback 없이 오류를 반환한다.
   */
  async getAssignment(opts: { reportSeq: string; lectureSeq?: string }): Promise<Result<AssignmentDetail>> {
    const { reportSeq, lectureSeq, known } = await this.resolveLecture(opts.reportSeq, opts.lectureSeq);
    const fetchedAt = nowKst(this.now());
    const d = await this.eclassLock.run(async () => {
      await enterLecture(this.session, lectureSeq);
      return fetchHomeworkDetail(this.session, reportSeq);
    });
    const data: AssignmentDetail = {
      lectureSeq,
      reportSeq,
      courseName: known?.courseName,
      title: d.title,
      startAt: d.startAt,
      dueAt: d.dueAt,
      extendedDueAt: d.extendedDueAt,
      penaltyNote: d.penaltyNote,
      submittedCount: d.submittedCount ?? undefined,
      totalCount: d.totalCount ?? undefined,
      body: d.body,
      attachments: d.attachments,
      submitStatus: d.submitStatus,
      scored: d.scored,
      detailUrl: `/eclass/clas/room/homework/homeworkDetail?reportSeq=${reportSeq}`,
    };
    return { data, meta: { fetchedAt, stale: false, source: "live" } };
  }

  /**
   * 과제 제출(포털 쓰기). 두 단계로 동작한다.
   * 1) `confirmToken` 없이: 아무것도 보내지 않고 미리보기 + `confirmToken`을 돌려준다.
   *    요청: 진입·상세·제출 폼 [+ 기존 첨부 목록] = 3~4.
   * 2) 그 토큰과 같은 인자로: 토큰이 지금의 입력·포털 상태와 맞을 때만 제출한다(다르면 새 미리보기).
   *    + 첨부 키/업로드 0~2 + 재진입·제출 POST 2(재시도·재전송 없음) + 검증(진입·상세·저장된 폼[·첨부 목록]) 3~4.
   * 제출 POST 응답 형식은 정찰하지 못했으므로, 보낸 뒤 포털을 다시 읽어 실제 반영을 확인한다.
   */
  async submitAssignment(opts: SubmitOptions): Promise<SubmitResult> {
    const title = opts.title.trim();
    if (!title) throw new Error("과제 제목(title)이 비어 있습니다.");
    const content = opts.content.trim();
    if (!content) throw new Error("과제 내용(content)이 비어 있습니다.");
    const { reportSeq, lectureSeq, known } = await this.resolveLecture(opts.reportSeq, opts.lectureSeq);
    const file = opts.filePath ? await loadUploadFile(opts.filePath) : undefined;
    const contentHtml = textToHtml(content);
    const label = `과제(reportSeq ${reportSeq})`;

    return this.eclassLock.run(async () => {
      await enterLecture(this.session, lectureSeq);
      const detailHtml = await fetchHomeworkDetailHtml(this.session, reportSeq);
      const detail = parseHomeworkDetail(detailHtml);
      const controls = parseSubmitControls(detailHtml);
      if (detail.reportSeq !== reportSeq) {
        throw new Error(`${label}: 포털 상세 화면의 과제 번호(${detail.reportSeq ?? "없음"})가 다릅니다. 제출하지 않았습니다.`);
      }
      if (detail.submitStatus === "not_open") {
        throw new Error(`${label}는 지금 제출 기간이 아닙니다(제출 시작 전이거나 마감됨).`);
      }
      const mode = detail.submitStatus === "submitted" ? "resubmit" : "register";
      if (mode === "resubmit" && controls.resubmit && !controls.resubmit.allowed) {
        throw new Error(`${label}는 평가가 완료되어 다시 제출할 수 없습니다.`);
      }
      const kind = mode === "register" ? "register" : "edit";
      const form = await fetchSubmitForm(this.session, kind, reportSeq, controls.reportNm);
      if (form.reportSeq !== reportSeq) {
        throw new Error(`${label}: 포털 제출 폼의 과제 번호(${form.reportSeq})가 다릅니다. 제출하지 않았습니다.`);
      }
      // 포털 위젯은 첨부가 없어도 묶음 키를 발급하므로, 실제 첨부 유무는 목록으로 판단한다.
      const existingFiles = form.attach.fileMasterKey ? await fetchFileInfo(this.session, form.attach.fileMasterKey) : [];
      const existingKeys = existingFiles.map((f) => String(f["fileKey"] ?? ""));
      const existingAttachments = existingFiles.map((f) => String(f["oriFileNm"] ?? f["fileKey"] ?? "")).filter(Boolean);
      const hadAttachment = existingFiles.length > 0;

      const dueAt = effectiveDeadline(detail.dueAt);
      const extendedDueAt = effectiveDeadline(detail.extendedDueAt);
      const pastDue = dueAt !== null && this.now().getTime() > Date.parse(dueAt);
      const extended = extendedDueAt !== null && dueAt !== null && Date.parse(extendedDueAt) > Date.parse(dueAt);
      const inExtension = controls.resubmit?.inExtension === true || (pastDue && extended);
      const warnings: string[] = [];
      if (inExtension) warnings.push(`지금은 연장 기간입니다. ${detail.penaltyNote ?? "감점 여부를 확인하세요."}`);
      if (mode === "resubmit") warnings.push("이미 제출한 과제입니다. 다시 제출하면 기존 제목·본문을 덮어씁니다.");
      if (mode === "resubmit" && file && hadAttachment) warnings.push("기존 첨부 파일은 새 파일로 교체됩니다.");
      if (file && file.size > PORTAL_WIDGET_MAX_BYTES) {
        warnings.push(`첨부 파일이 포털 업로드 화면의 설정값(${PORTAL_WIDGET_MAX_BYTES}바이트)보다 커서 거부될 수 있습니다.`);
      }

      const base = {
        mode,
        lectureSeq,
        reportSeq,
        courseName: known?.courseName,
        assignmentTitle: detail.title,
        dueAt,
        extendedDueAt,
        inExtension,
        penaltyNote: detail.penaltyNote,
        title,
        contentLength: content.length,
        file: file ? { name: file.name, path: file.path, size: file.size } : undefined,
        keepsExistingAttachment: mode === "resubmit" && !file && hadAttachment,
        existingAttachments,
      } as const;

      // 미리보기에서 사용자가 본 것(입력·대상·상태)이 제출 시점에도 같을 때만 보낸다.
      const fingerprint = JSON.stringify([
        reportSeq, lectureSeq, mode, inExtension, title, contentHtml, file?.name ?? null, file?.sha256 ?? null,
        existingKeys, form.title, form.contentHtml,
      ]);
      const preview = (extra: string[], message: string): SubmitResult => ({
        ...base,
        submitted: false,
        verified: false,
        warnings: [...extra, ...warnings],
        confirmToken: this.signPreview(fingerprint),
        message,
      });
      const PREVIEW_MESSAGE =
        "아직 제출하지 않았습니다(미리보기). 사용자에게 과제·제목·내용·첨부·경고를 보여 주고 명시적으로 승인받은 뒤, 같은 인자에 confirm_token을 더해 다시 호출하세요.";
      if (!opts.confirmToken) return preview([], PREVIEW_MESSAGE);
      if (!this.verifyPreview(opts.confirmToken, fingerprint)) {
        return preview(
          ["미리보기 이후 입력·첨부 파일·포털 상태가 바뀌었거나 토큰이 만료(10분)되어 제출하지 않았습니다. 새 미리보기를 다시 확인받으세요."],
          PREVIEW_MESSAGE,
        );
      }

      // 포털 화면과 같은 폼을 만든다: 기본 4필드 + 첨부 위젯의 숨은 필드.
      const fields: Array<[string, string]> = [
        ["reportSeq", form.reportSeq],
        ["studentNo", form.studentNo],
        ["reportTitle", title],
        ["reportContent", contentHtml],
      ];
      let masterKey = form.attach.fileMasterKey;
      let files: FileDetail[] = existingFiles;
      if (file) {
        masterKey ||= await fetchFileMasterKey(this.session);
        files = [await uploadAttachment(this.session, form.attach, masterKey, file)];
      } else if (!masterKey) {
        masterKey = await fetchFileMasterKey(this.session);
      }
      fields.push(...attachFields(form.attach, masterKey, files));

      // 업로드 등 앞 요청에서 재로그인됐다면 "현재 강의"가 풀렸으므로 POST 직전에 다시 진입한다.
      await enterLecture(this.session, lectureSeq);
      this.logger.info(`${label} ${mode === "register" ? "제출" : "다시 제출"} POST 전송`);
      let responseHtml: string;
      try {
        responseHtml = await postReportSubmit(this.session, kind, fields);
      } catch (err) {
        if (err instanceof WriteSessionLostError) {
          throw new Error(
            `${err.message} 제출되지 않았을 가능성이 높습니다. get_assignment로 상태를 확인한 뒤 새 미리보기부터 다시 진행하세요.`,
          );
        }
        throw new Error(
          `제출 요청이 실패했습니다(${errorSummary(err)}). 반영됐을 수도 있으니 get_assignment로 제출 상태를 확인한 뒤 다시 시도하세요.`,
        );
      }
      const alert = extractAlert(responseHtml);
      const fail = (why: string): SubmitNotAppliedError =>
        new SubmitNotAppliedError(
          `제출 확인 실패: ${why}${alert ? ` (포털 메시지: ${alert})` : ""}. 포털에서 직접 확인하세요.`,
        );

      try {
        // 검증: 재로그인으로 현재 강의가 풀렸을 수 있으므로 다시 진입한 뒤 읽는다.
        await enterLecture(this.session, lectureSeq);
        const after = parseHomeworkDetail(await fetchHomeworkDetailHtml(this.session, reportSeq));
        if (after.submitStatus !== "submitted") throw fail("상세 화면이 여전히 미제출 상태입니다");
        const saved = await fetchSubmitForm(this.session, "edit", reportSeq, controls.reportNm);
        const sameAsSent = saved.title.trim() === title && plainOf(saved.contentHtml) === plainOf(contentHtml);
        const sentEqualsOld = form.title.trim() === title && plainOf(form.contentHtml) === plainOf(contentHtml);
        let verified = true;
        if (mode === "resubmit") {
          const changed = saved.title !== form.title || plainOf(saved.contentHtml) !== plainOf(form.contentHtml);
          if (!sameAsSent && !changed) throw fail("저장된 제목·본문이 바뀌지 않았습니다");
          if (sentEqualsOld && !file) {
            verified = false;
            warnings.push("보낸 제목·본문이 기존 제출과 같아 반영 여부를 구분할 수 없습니다.");
          }
        }
        if (!sameAsSent) warnings.push("저장된 제목·본문이 보낸 값과 조금 다릅니다(포털이 형식을 바꿨을 수 있음).");
        if (file) {
          const rawUploaded = files[0]?.["fileKey"];
          const uploadedKey = rawUploaded === undefined || rawUploaded === null ? undefined : String(rawUploaded);
          const savedKeys = saved.attach.fileMasterKey
            ? (await fetchFileInfo(this.session, saved.attach.fileMasterKey)).map((f) => String(f["fileKey"] ?? ""))
            : [];
          const oldKeys = existingKeys.filter((k) => k !== uploadedKey);
          if (uploadedKey === undefined || !savedKeys.includes(uploadedKey)) {
            verified = false;
            warnings.push("첨부 파일 반영을 확인하지 못했습니다. 포털에서 첨부를 확인하세요.");
          } else if (oldKeys.some((k) => savedKeys.includes(k))) {
            verified = false;
            warnings.push("기존 첨부 파일이 아직 남아 있습니다. 포털에서 첨부를 확인하세요.");
          } else if (mode === "resubmit" && sentEqualsOld && oldKeys.length === 0) {
            // 업로드만으로도 묶음에 파일이 보일 수 있어, 바뀐 것이 새 첨부뿐이면 POST 반영을 구분할 수 없다.
            verified = false;
            warnings.push("바뀐 것이 새 첨부뿐이라 다시 제출 반영 여부를 구분할 수 없습니다.");
          }
        }
        this.logger.info(`${label} 제출 검증 완료(verified=${verified})`);
        return {
          ...base,
          submitted: true,
          verified,
          warnings,
          message: verified
            ? `${mode === "register" ? "제출" : "다시 제출"}했습니다. 포털을 다시 읽어 반영을 확인했습니다.`
            : "제출 요청은 보냈지만 반영을 완전히 확인하지 못했습니다. 포털에서 확인하세요.",
        };
      } catch (err) {
        if (err instanceof SubmitNotAppliedError) throw err;
        // POST는 이미 나갔다. "실패"로 보고하면 같은 제출을 다시 보낼 수 있으므로 전송 사실을 알린다.
        this.logger.warn(`${label} 제출 후 검증 오류`, errorSummary(err));
        return {
          ...base,
          submitted: true,
          verified: false,
          warnings: [
            ...warnings,
            `제출 요청은 전송됐지만 반영 확인 중 오류가 났습니다(${errorSummary(err)}). 같은 제출을 다시 보내지 말고 get_assignment로 상태를 확인하세요.`,
          ],
          message: "제출 요청은 보냈지만 반영을 확인하지 못했습니다. get_assignment로 상태를 확인하세요.",
        };
      }
    });
  }

  /** 미리보기 토큰: `<발급 ms>.<HMAC(발급 ms + 지문)>`. 비밀키는 프로세스마다 새로 만든다. */
  private signPreview(fingerprint: string, issuedAt = this.now().getTime()): string {
    const mac = createHmac("sha256", this.previewSecret).update(`${issuedAt}\n${fingerprint}`).digest("base64url");
    return `${issuedAt}.${mac}`;
  }

  private verifyPreview(token: string, fingerprint: string): boolean {
    const m = /^(\d{1,16})\.([A-Za-z0-9_-]{43})$/.exec(token.trim());
    if (!m) return false;
    const issuedAt = Number(m[1]);
    const age = this.now().getTime() - issuedAt;
    if (age < -60_000 || age > PREVIEW_TTL_MS) return false;
    const expected = Buffer.from(this.signPreview(fingerprint, issuedAt));
    const given = Buffer.from(token.trim());
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  /**
   * reportSeq·lectureSeq 검증. lectureSeq가 없으면 assignments 스냅샷에서 찾는다.
   * 둘 다 있는데 스냅샷의 강의와 다르면 거부한다(다른 과목 맥락으로 요청하지 않도록).
   */
  private async resolveLecture(
    rawReportSeq: string,
    rawLectureSeq?: string,
  ): Promise<{ reportSeq: string; lectureSeq: string; known?: Assignment }> {
    const reportSeq = rawReportSeq.trim();
    if (!/^\d+$/.test(reportSeq)) throw new Error(`report_seq는 숫자여야 합니다: ${reportSeq}`);
    const known = (await this.store.read("assignments"))?.data.find((a) => a.reportSeq === reportSeq);
    const given = rawLectureSeq?.trim();
    if (given && known && known.lectureSeq !== given) {
      throw new Error(
        `lecture_seq(${given})가 과제 ${reportSeq}의 강의(${known.lectureSeq})와 다릅니다. get_assignments 결과의 값을 쓰세요.`,
      );
    }
    const lectureSeq = given || known?.lectureSeq;
    if (!lectureSeq) {
      throw new Error(
        `과제 ${reportSeq}의 강의(lecture_seq)를 알 수 없습니다. get_assignments를 먼저 호출하거나 lecture_seq를 함께 주세요.`,
      );
    }
    if (!/^\d+$/.test(lectureSeq)) throw new Error(`lecture_seq는 숫자여야 합니다: ${lectureSeq}`);
    return { reportSeq, lectureSeq, known };
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
          return this.eclassLock.run(async () => {
            await enterLecture(this.session, lectureSeq);
            return fetchEclassBoardDetail(this.session, boardId, wrId, summary);
          });
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
