import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/auth/session-manager.js";
import type { Config } from "../../src/config/config.js";
import { Secret } from "../../src/config/secret.js";
import { HttpClient } from "../../src/http/http-client.js";
import { RequestQueue } from "../../src/queue/request-queue.js";
import type { Assignment, SubmitResult } from "../../src/schema/index.js";
import { CategoryService, type SubmitOptions } from "../../src/service/category-service.js";
import { ArchiveDb, isStale } from "../../src/store/archive-db.js";


const fixture = (name: string): string => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
const html = (text: string): Response =>
  new Response(text, { status: 200, headers: { "content-type": "text/html;charset=UTF-8" } });
const json = (v: unknown): Response =>
  new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "text/plain;charset=UTF-8" } });

interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  form?: URLSearchParams;
  multipart?: FormData;
  /** 요청 시점의 세션 "현재 강의". */
  lecture: string | null;
}

/** 제출 상태를 가진 포털 모의. 제출 POST가 오면 상태·저장값이 바뀐다. */
interface PortalState {
  status: "not_submitted" | "submitted" | "not_open";
  scoredLocked: boolean;
  title: string;
  content: string;
  masterKey: string;
  files: Array<Record<string, string>>;
  /** false면 제출 POST를 받아도 저장하지 않는다(실패 재현). */
  accept: boolean;
  submitResponse: string;
  failSubmit: boolean;
  /** 제출 POST에 세션 만료 응답(로그인 페이지)을 돌려준다. */
  expireOnSubmit: boolean;
  /** 제출 뒤 editModal을 깨진 HTML로 돌려준다(검증 단계 오류 재현). */
  breakVerify: boolean;
  /** 상세 HTML 가공(마감·연장기한 바꾸기 등). */
  patchDetail?: (html: string) => string;
  /** 상세가 돌려줄 과제 번호(기본: 요청한 번호). */
  detailReportSeq?: string;
}

let root: string;
let requests: Recorded[];
let state: PortalState;
let current: string | null;
let now: Date;
/** 응답 지연(ms). 병렬 흐름이 실제로 겹치게 할 때 쓴다. */
let delayMs: number;

/** 픽스처의 과제 번호를 요청한 번호로 바꾼다(포털은 요청한 과제의 화면을 준다). */
const withSeq = (h: string, seq: string | null): string =>
  seq ? h.replace(/(name="reportSeq" id="reportSeq" value=")\d+"/g, `$1${seq}"`) : h;

function detailHtml(seq: string | null): string {
  let h: string;
  if (state.status === "not_submitted") h = fixture("eclass/homework-detail-not-submitted.html");
  else if (state.status === "not_open") h = fixture("eclass/homework-detail-not-open.html");
  else {
    h = fixture("eclass/homework-detail-submitted.html");
    if (state.scoredLocked) h = h.replace('data-wr-re="Y" data-score=""', 'data-wr-re="N" data-score="10"');
  }
  h = withSeq(h, state.detailReportSeq ?? seq);
  return state.patchDetail ? state.patchDetail(h) : h;
}

function editModalHtml(seq: string | null): string {
  if (state.breakVerify && state.accept && state.status === "submitted") return "<html>점검 중</html>";
  return withSeq(fixture("eclass/homework-edit-modal.html"), seq)
    .replace("value='2000000000 홍길동_8주차'", `value='${state.title}'`)
    .replace("<p>기존 제출 본문</p>", state.content)
    .replace(
      'data-file-master-key="20260101000000-00000000000000000000000000000000"',
      `data-file-master-key="${state.masterKey}"`,
    );
}

async function route(r: Recorded): Promise<Response> {
  const seq = r.query.get("reportSeq");
  switch (`${r.method} ${r.path}`) {
    case "POST /eclass/clas/home":
      current = r.form?.get("lectureSeq") ?? null;
      return html(fixture("eclass/clas-home.html"));
    case "GET /eclass/clas/room/homework/homeworkDetail":
      return html(detailHtml(seq));
    case "GET /eclass/clas/room/homework/registerModal":
      return html(withSeq(fixture("eclass/homework-register-modal.html"), seq));
    case "GET /eclass/clas/room/homework/editModal":
      return html(editModalHtml(seq));
    case "GET /file/masterKey":
      return json({ fileMasterKey: "MK-NEW" });
    case "GET /file/info":
      return json({ fileMasterKey: r.query.get("fileMasterKey"), fileDetails: state.files });
    case "POST /file/upload": {
      const file = r.multipart?.get("cmmFileUpload") as File;
      const detail = {
        fileMasterKey: String(r.multipart?.get("fileMasterKey")),
        fileSection: "submitAttach",
        fileAccessType: "PUBLIC",
        fileKey: "FK-UP",
        oriFileNm: file.name,
      };
      return json({ result: true, message: "업로드 완료", fileDetails: [detail] });
    }
    case "POST /eclass/clas/room/homework/insertReportSubmit":
    case "POST /eclass/clas/room/homework/updateReportSubmit": {
      if (state.failSubmit) throw Object.assign(new TypeError("fetch failed"), { cause: new Error("ECONNRESET") });
      if (state.expireOnSubmit) return html(fixture("login/notlogin.html"));
      if (state.accept) {
        state.status = "submitted";
        state.title = r.form!.get("reportTitle")!;
        state.content = r.form!.get("reportContent")!;
        state.masterKey = r.form!.get("submitAttachFileMasterKey") ?? "";
        const keys = r.form!.getAll("submitAttachFileKey");
        state.files = keys.map((fileKey) => ({ fileKey, fileSection: "submitAttach", fileAccessType: "PUBLIC" }));
      }
      return html(state.submitResponse);
    }
    default:
      throw new Error(`unexpected request: ${r.method} ${r.path}`);
  }
}

function makeService(db?: ArchiveDb): { service: CategoryService } {
  const fetchMock = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const r: Recorded = {
      method,
      path: url.pathname,
      query: url.searchParams,
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      lecture: current,
    };
    if (typeof init?.body === "string") r.form = new URLSearchParams(init.body);
    else if (init?.body instanceof FormData) r.multipart = init.body;
    requests.push(r);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return route(r);
  };
  const client = new HttpClient({ fetch: fetchMock as typeof fetch, queue: new RequestQueue({ minGapMs: 0 }) });
  const loadConfig = (): Config => ({
    id: "2000000000",
    password: new Secret("pw"),
    homeDir: root,
  });
  const session = new SessionManager({ client, login: vi.fn(async () => {}), loadConfig });
  const logger = { debug: () => {}, info: () => {}, warn: () => {} };
  const archive = db ? { archive: { db, dbPath: ":memory:", filesDir: join(root, "files") } } : {};
  return { service: new CategoryService({ session, client, now: () => now, logger, ...archive }) };
}

const sent = (path: string): Recorded[] => requests.filter((r) => r.path === path);
const SUBMIT = "/eclass/clas/room/homework/insertReportSubmit";
const UPDATE = "/eclass/clas/room/homework/updateReportSubmit";
const OK_RESPONSE = "<script>location.href='/eclass/clas/room/homework/homeworkDetail?reportSeq=34771'</script>";

/** 미리보기 → 받은 토큰으로 제출(사용자 승인 흐름). */
async function previewThenSubmit(service: CategoryService, opts: SubmitOptions): Promise<SubmitResult> {
  const preview = await service.submitAssignment(opts);
  expect(preview.submitted).toBe(false);
  expect(preview.confirmToken).toBeTruthy();
  return service.submitAssignment({ ...opts, confirmToken: preview.confirmToken });
}

beforeEach(async () => {
  // Windows 임시 폴더는 AppData 아래라 첨부 가드에 걸리므로 저장소 안에 만든다.
  root = await mkdtemp(join(process.cwd(), "tmp-submit-"));
  requests = [];
  current = null;
  delayMs = 0;
  now = new Date("2026-10-26T12:00:00+09:00");
  state = {
    status: "not_submitted",
    scoredLocked: false,
    title: "",
    content: "",
    masterKey: "",
    files: [],
    accept: true,
    submitResponse: OK_RESPONSE,
    failSubmit: false,
    expireOnSubmit: false,
    breakVerify: false,
  };
});
afterEach(() => rm(root, { recursive: true, force: true }));

const base = { reportSeq: "34771", lectureSeq: "27962", title: "2000000000 홍길동_8주차", content: "첫 줄\n둘째 줄" };

describe("submitAssignment: 미리보기", () => {
  it("토큰이 없으면 읽기 3요청만 하고 아무것도 보내지 않는다", async () => {
    const { service } = makeService();
    const res = await service.submitAssignment(base);
    expect(res.submitted).toBe(false);
    expect(res.verified).toBe(false);
    expect(res.mode).toBe("register");
    expect(res.confirmToken).toMatch(/^\d+\.[A-Za-z0-9_-]{43}$/);
    expect(res.existingAttachments).toEqual([]);
    // 마감 00:00은 전날 23:59로 보정된다.
    expect(res.dueAt).toBe("2026-10-26T23:59:00+09:00");
    expect(res.inExtension).toBe(false);
    expect(res.message).toContain("confirm_token");
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /eclass/clas/home",
      "GET /eclass/clas/room/homework/homeworkDetail",
      "GET /eclass/clas/room/homework/registerModal",
    ]);
    // registerModal에는 상세의 과제명(reportNm)을 함께 보낸다.
    expect(sent("/eclass/clas/room/homework/registerModal")[0]!.query.get("reportNm")?.length).toBeGreaterThan(0);
  });

  it("지어낸 토큰·다른 인자의 토큰·만료된 토큰이면 제출하지 않고 새 미리보기", async () => {
    const { service } = makeService();
    const preview = await service.submitAssignment(base);
    const token = preview.confirmToken!;

    const forged = await service.submitAssignment({ ...base, confirmToken: `${now.getTime()}.${"A".repeat(43)}` });
    expect(forged.submitted).toBe(false);
    expect(forged.warnings[0]).toContain("제출하지 않았습니다");

    const changed = await service.submitAssignment({ ...base, title: "다른 제목", confirmToken: token });
    expect(changed.submitted).toBe(false);

    now = new Date(now.getTime() + 11 * 60 * 1000);
    const expired = await service.submitAssignment({ ...base, confirmToken: token });
    expect(expired.submitted).toBe(false);
    expect(expired.confirmToken).not.toBe(token);

    expect(sent(SUBMIT)).toHaveLength(0);
  });

  it("미리보기 뒤 포털 상태가 바뀌면(다른 곳에서 제출됨) 덮어쓰지 않는다", async () => {
    const { service } = makeService();
    const preview = await service.submitAssignment(base);
    state.status = "submitted";
    state.title = "브라우저에서 낸 제목";
    state.content = "<p>브라우저 본문</p>";
    const res = await service.submitAssignment({ ...base, confirmToken: preview.confirmToken });
    expect(res.submitted).toBe(false);
    expect(res.mode).toBe("resubmit");
    expect(sent(SUBMIT)).toHaveLength(0);
    expect(sent(UPDATE)).toHaveLength(0);
  });
});

describe("submitAssignment: 신규 제출", () => {
  it("본문만: 포털 폼 필드로 1회 POST하고 다시 읽어 검증한다", async () => {
    const { service } = makeService();
    const res = await previewThenSubmit(service, base);
    expect(res).toMatchObject({ submitted: true, verified: true, mode: "register", keepsExistingAttachment: false });
    expect(res.confirmToken).toBeUndefined();
    expect(sent(SUBMIT)).toHaveLength(1);
    const post = sent(SUBMIT)[0]!;
    expect([...post.form!.keys()]).toEqual([
      "reportSeq",
      "studentNo",
      "reportTitle",
      "reportContent",
      "submitAttachFileMasterKey",
    ]);
    expect(post.form!.get("reportSeq")).toBe("34771");
    expect(post.form!.get("studentNo")).toBe("2000000000");
    expect(post.form!.get("reportContent")).toBe("<p>첫 줄</p>\n<p>둘째 줄</p>");
    expect(post.form!.get("submitAttachFileMasterKey")).toBe("MK-NEW");
    expect(post.lecture).toBe("27962");
    expect(sent("/file/upload")).toHaveLength(0);
    // POST 직전 재진입, 이후 검증: 재진입 → 상세 → editModal
    const i = requests.indexOf(post);
    expect(requests[i - 1]!.path).toBe("/eclass/clas/home");
    expect(requests.slice(i + 1).map((r) => r.path)).toEqual([
      "/eclass/clas/home",
      "/eclass/clas/room/homework/homeworkDetail",
      "/eclass/clas/room/homework/editModal",
    ]);
    // 첨부 JSON 요청은 화면의 jQuery ajax와 같은 헤더를 쓴다.
    expect(sent("/file/masterKey")[0]!.headers["X-Requested-With"]).toBe("XMLHttpRequest");
  });

  it("첨부 1개: 위젯과 같은 multipart로 올리고 반환 키를 숨은 필드로 붙인다", async () => {
    const path = join(root, "보고서.pdf");
    await writeFile(path, "%PDF-1.4 test");
    const { service } = makeService();
    const res = await previewThenSubmit(service, { ...base, filePath: path });
    expect(res).toMatchObject({ submitted: true, verified: true, file: { name: "보고서.pdf", size: 13 } });
    expect(res.file?.path.endsWith("보고서.pdf")).toBe(true);

    const up = sent("/file/upload");
    expect(up).toHaveLength(1);
    const mp = up[0]!.multipart!;
    expect(mp.get("fileMasterKey")).toBe("MK-NEW");
    expect(mp.get("fileKey")).toBe("");
    expect(mp.get("fileSection")).toBe("submitAttach");
    expect(mp.get("fileAccessType")).toBe("PUBLIC");
    expect(mp.get("prefix")).toBe("submitAttach");
    expect(mp.get("maxFileCount")).toBe("1");
    const file = mp.get("cmmFileUpload") as File;
    expect(file.name).toBe("보고서.pdf");
    expect(file.type).toBe("application/pdf");

    const form = sent(SUBMIT)[0]!.form!;
    expect(form.get("submitAttachFileMasterKey")).toBe("MK-NEW");
    expect(form.get("submitAttachFileKey")).toBe("FK-UP");
    expect(form.get("submitAttachFileSection")).toBe("submitAttach");
    expect(form.get("submitAttachFileAccessType")).toBe("PUBLIC");
  });

  it("미리보기 뒤 첨부 파일 내용이 바뀌면 제출하지 않는다", async () => {
    const path = join(root, "a.pdf");
    await writeFile(path, "v1");
    const { service } = makeService();
    const preview = await service.submitAssignment({ ...base, filePath: path });
    await writeFile(path, "v2");
    const res = await service.submitAssignment({ ...base, filePath: path, confirmToken: preview.confirmToken });
    expect(res.submitted).toBe(false);
    expect(sent("/file/upload")).toHaveLength(0);
  });

  it("제출 후에도 미제출이면 포털 alert 문구와 함께 실패", async () => {
    state.accept = false;
    state.submitResponse = "<script>alert('제출 기간이 아닙니다.');history.back();</script>";
    const { service } = makeService();
    await expect(previewThenSubmit(service, base)).rejects.toThrow(/제출 확인 실패.*제출 기간이 아닙니다/);
  });

  it("제출 POST는 큐에서 재시도하지 않는다(중복 제출 방지)", async () => {
    state.failSubmit = true;
    const { service } = makeService();
    await expect(previewThenSubmit(service, base)).rejects.toThrow(/반영됐을 수도/);
    expect(sent(SUBMIT)).toHaveLength(1);
  });

  it("제출 POST가 세션 만료를 만나도 재로그인 후 자동 재전송하지 않는다", async () => {
    state.expireOnSubmit = true;
    const { service } = makeService();
    await expect(previewThenSubmit(service, base)).rejects.toThrow(/자동으로 다시 보내지 않습니다.*제출되지 않았을 가능성/);
    expect(sent(SUBMIT)).toHaveLength(1);
  });

  it("POST 뒤 검증 단계 오류는 '전송됨, 확인 못 함'으로 돌려준다(실패로 보고하지 않음)", async () => {
    state.breakVerify = true;
    const { service } = makeService();
    const res = await previewThenSubmit(service, base);
    expect(res).toMatchObject({ submitted: true, verified: false });
    expect(res.warnings.join(" ")).toContain("다시 보내지 말고");
  });
});

describe("submitAssignment: 아카이브 저장본", () => {
  const T = "2026-10-26T12:00:00+09:00";
  let db: ArchiveDb;
  beforeEach(() => {
    db = new ArchiveDb(":memory:");
    db.upsertCourse({ lectureSeq: "27962", courseName: "UI화면설계", year: 2026, semester: "2" }, T);
    db.upsertAssignment(
      {
        reportSeq: "34771",
        lectureSeq: "27962",
        title: "과제",
        startAt: null,
        dueAt: "2026-10-28T00:00:00+09:00",
        extendedDueAt: null,
        penaltyNote: null,
        contentHtml: "",
        contentText: "",
        submitStatus: "not_submitted",
        scored: false,
      },
      T,
    );
  });
  afterEach(() => db.close());

  it("미리보기는 저장본을 바꾸지 않고, 보낸 제출은 제출 상태 + 오래된 것으로 표시한다", async () => {
    const { service } = makeService(db);
    const preview = await service.submitAssignment(base);
    expect(db.getAssignmentDetail("34771")).toMatchObject({ submitStatus: "not_submitted", fetchedAt: T });
    const res = await service.submitAssignment({ ...base, confirmToken: preview.confirmToken });
    expect(res.submitted).toBe(true);
    expect(sent(SUBMIT)).toHaveLength(1);
    const saved = db.getAssignmentDetail("34771")!;
    expect(saved.submitStatus).toBe("submitted");
    expect(isStale(saved.fetchedAt, now)).toBe(true);
    // 다음 get_assignment는 포털에서 다시 읽고 저장한다
    requests = [];
    const detail = await service.getAssignment({ reportSeq: "34771" });
    expect(sent("/eclass/clas/room/homework/homeworkDetail")).toHaveLength(1);
    expect(detail.data.submitStatus).toBe("submitted");
    expect(db.getAssignmentDetail("34771")?.fetchedAt).toBe(T);
  });

  it("전송됐지만 확인 못 했으면 상태는 두고 오래된 것으로만 표시하고, 반영되지 않은 제출(오류)은 표시하지 않는다", async () => {
    state.breakVerify = true;
    const sentButUnverified = await previewThenSubmit(makeService(db).service, base);
    expect(sentButUnverified).toMatchObject({ submitted: true, verified: false });
    const saved = db.getAssignmentDetail("34771")!;
    expect(saved.submitStatus).toBe("not_submitted");
    expect(isStale(saved.fetchedAt, now)).toBe(true);

    db.upsertAssignment(
      { reportSeq: "34771", lectureSeq: "27962", title: "과제", startAt: null, dueAt: null, extendedDueAt: null, penaltyNote: null, contentHtml: "", contentText: "", submitStatus: "not_submitted" },
      T,
    );
    state = { ...state, status: "not_submitted", breakVerify: false, accept: false };
    await expect(previewThenSubmit(makeService(db).service, base)).rejects.toThrow(/제출 확인 실패/);
    expect(db.getAssignmentDetail("34771")).toMatchObject({ submitStatus: "not_submitted", fetchedAt: T });
  });
});

describe("submitAssignment: 다시 제출", () => {
  beforeEach(() => {
    state.status = "submitted";
    state.title = "예전 제목";
    state.content = "<p>예전 본문</p>";
    state.masterKey = "MK-OLD";
    state.files = [{ fileKey: "FK-OLD", fileSection: "submitAttach", fileAccessType: "PUBLIC", oriFileNm: "v1.zip" }];
  });

  it("첨부 없이: 기존 첨부를 유지한 채 updateReportSubmit", async () => {
    const { service } = makeService();
    const preview = await service.submitAssignment(base);
    expect(preview.mode).toBe("resubmit");
    expect(preview.keepsExistingAttachment).toBe(true);
    expect(preview.existingAttachments).toEqual(["v1.zip"]);
    expect(preview.warnings.join(" ")).toContain("덮어씁니다");

    const res = await service.submitAssignment({ ...base, confirmToken: preview.confirmToken });
    expect(res).toMatchObject({ submitted: true, verified: true });
    expect(sent(SUBMIT)).toHaveLength(0);
    const form = sent(UPDATE)[0]!.form!;
    expect(form.get("submitAttachFileMasterKey")).toBe("MK-OLD");
    expect(form.getAll("submitAttachFileKey")).toEqual(["FK-OLD"]);
    expect(sent("/file/masterKey")).toHaveLength(0);
  });

  it("묶음 키만 있고 파일이 없으면 '기존 첨부 유지'로 표시하지 않는다", async () => {
    state.files = [];
    const { service } = makeService();
    const preview = await service.submitAssignment(base);
    expect(preview.keepsExistingAttachment).toBe(false);
    expect(preview.existingAttachments).toEqual([]);
  });

  it("새 첨부: 기존 묶음 키로 올리고 새 파일만 남긴다(기존 파일이 사라졌는지로 검증)", async () => {
    const path = join(root, "v2.zip");
    await writeFile(path, "zip");
    const { service } = makeService();
    const res = await previewThenSubmit(service, { ...base, title: "예전 제목", content: "예전 본문", filePath: path });
    expect(res.verified).toBe(true);
    expect(res.warnings.join(" ")).toContain("교체");
    expect(sent("/file/upload")[0]!.multipart!.get("fileMasterKey")).toBe("MK-OLD");
    expect(sent(UPDATE)[0]!.form!.getAll("submitAttachFileKey")).toEqual(["FK-UP"]);
  });

  it("새 첨부인데 POST가 반영되지 않아 기존 파일이 남으면 verified=false", async () => {
    const path = join(root, "v2.zip");
    await writeFile(path, "zip");
    // 업로드는 묶음에 바로 저장되지만 제출 POST는 무시되는 포털을 흉내 낸다.
    state.accept = false;
    state.files.push({ fileKey: "FK-UP", fileSection: "submitAttach", fileAccessType: "PUBLIC" });
    const { service } = makeService();
    const res = await previewThenSubmit(service, { ...base, title: "예전 제목", content: "예전 본문", filePath: path });
    expect(res.submitted).toBe(true);
    expect(res.verified).toBe(false);
  });

  it("평가 완료(다시 제출 불가)면 요청 전에 거부", async () => {
    state.scoredLocked = true;
    const { service } = makeService();
    await expect(service.submitAssignment(base)).rejects.toThrow(/평가가 완료/);
    expect(sent(UPDATE)).toHaveLength(0);
  });

  it("보낸 값이 기존과 같으면 verified=false로 알린다", async () => {
    state.title = base.title;
    state.content = "<p>첫 줄</p>\n<p>둘째 줄</p>";
    const { service } = makeService();
    const res = await previewThenSubmit(service, base);
    expect(res.submitted).toBe(true);
    expect(res.verified).toBe(false);
  });
});

describe("submitAssignment: 연장 기간", () => {
  it("마감이 지났고 연장기한 안이면 inExtension + 감점 안내", async () => {
    // 픽스처: 제출 ~10-27 00:00, 연장 10-27 00:00 → 마감을 10-25 00:00(=10-24 23:59), 연장을 11-02로 바꾼다.
    state.patchDetail = (h) =>
      h
        .replace(/2026-10-27 00:00:00\.0<\/span> \(/, "2026-10-25 00:00:00.0</span> (")
        .replace(/(연장기한[\s\S]*?)2026-10-27 00:00:00\.0/, (_m, head: string) => `${head}2026-11-02 23:59:00.0`);
    const { service } = makeService();
    const res = await service.submitAssignment(base);
    expect(res.dueAt).toBe("2026-10-24T23:59:00+09:00");
    expect(res.extendedDueAt).toBe("2026-11-02T23:59:00+09:00");
    expect(res.inExtension).toBe(true);
    expect(res.warnings.join(" ")).toContain("감점 있음");
  });
});

describe("submitAssignment: 입력·상태 검증", () => {
  it("제출 기간이 아니면 거부", async () => {
    state.status = "not_open";
    const { service } = makeService();
    await expect(service.submitAssignment(base)).rejects.toThrow(/제출 기간이 아닙니다/);
  });

  it("포털이 다른 과제 화면을 주면 거부", async () => {
    state.detailReportSeq = "99999";
    const { service } = makeService();
    await expect(service.submitAssignment(base)).rejects.toThrow(/과제 번호/);
  });

  it("lecture_seq가 마지막 과제 목록의 강의와 다르면 거부", async () => {
    const { service } = makeService();
    (service as unknown as { knownAssignments: Map<string, Assignment> }).knownAssignments.set("34771", {
      lectureSeq: "27962",
      reportSeq: "34771",
      courseName: "과목",
      title: "t",
      startAt: null,
      dueAt: null,
      extendedDueAt: null,
      submitStatus: "not_submitted",
      detailUrl: "/x",
    });
    await expect(service.submitAssignment({ ...base, lectureSeq: "11111" })).rejects.toThrow(/강의\(27962\)와 다릅니다/);
    expect(requests).toHaveLength(0);
  });

  it("빈 제목·내용, 상대·UNC 경로, 숨김 폴더·비밀 파일은 포털 요청 전에 거부", async () => {
    const { service } = makeService();
    await expect(service.submitAssignment({ ...base, title: "  " })).rejects.toThrow(/제목/);
    await expect(service.submitAssignment({ ...base, content: "" })).rejects.toThrow(/내용/);
    await expect(service.submitAssignment({ ...base, filePath: "a.pdf" })).rejects.toThrow(/절대 경로/);
    for (const unc of ["\\\\evil.example\\share\\a.pdf", "//evil.example/share/a.pdf", "\\\\?\\C:\\a.pdf"]) {
      await expect(service.submitAssignment({ ...base, filePath: unc })).rejects.toThrow(/보안상/);
    }
    const hidden = join(root, ".aws");
    await mkdir(hidden);
    for (const [dir, name] of [
      [root, ".env"],
      [root, "prod.env"],
      [root, "id_rsa"],
      [root, "server.pem"],
      [hidden, "report.pdf"],
    ] as const) {
      const p = join(dir, name);
      await writeFile(p, "secret");
      await expect(service.submitAssignment({ ...base, filePath: p })).rejects.toThrow(/보안상/);
    }
    expect(requests).toHaveLength(0);
  });

  it("SHINGU_MCP_HOME 아래 자격증명 디렉터리도 거부", async () => {
    const dir = join(root, "cfg", ".shingu-mcp");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "config.json"), "{}");
    await writeFile(join(root, "cfg", "notes.pdf"), "ok");
    vi.stubEnv("SHINGU_MCP_HOME", join(root, "cfg"));
    try {
      const { service } = makeService();
      await expect(service.submitAssignment({ ...base, filePath: join(dir, "config.json") })).rejects.toThrow(/보안상/);
      // 같은 홈 아래라도 .shingu-mcp 밖의 일반 파일은 허용된다.
      expect((await service.submitAssignment({ ...base, filePath: join(root, "cfg", "notes.pdf") })).file?.name).toBe(
        "notes.pdf",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("E클래스 강의 잠금", () => {
  it("병렬 호출이 섞여도 제출 POST는 대상 강의에 진입한 상태에서 나간다", async () => {
    const { service } = makeService();
    const preview = await service.submitAssignment(base);
    requests = [];
    delayMs = 5;
    await Promise.all([
      service.getAssignment({ reportSeq: "1", lectureSeq: "11111" }),
      service.submitAssignment({ ...base, confirmToken: preview.confirmToken }),
      service.getAssignment({ reportSeq: "2", lectureSeq: "22222" }),
    ]);
    const post = sent(SUBMIT)[0]!;
    expect(post.lecture).toBe("27962");
    // 각 상세 요청은 직전에 진입한 강의 컨텍스트여야 한다.
    for (const r of sent("/eclass/clas/room/homework/homeworkDetail")) {
      const i = requests.indexOf(r);
      const enter = requests.slice(0, i).reverse().find((x) => x.path === "/eclass/clas/home")!;
      expect(r.lecture).toBe(enter.form!.get("lectureSeq"));
    }
    // 제출 흐름의 진입 3회(시작·POST 직전·검증)는 연속이며 사이에 다른 강의 진입이 끼지 않는다.
    const enters = sent("/eclass/clas/home").map((r) => r.form!.get("lectureSeq"));
    expect(enters.filter((s) => s === "27962")).toHaveLength(3);
    expect(enters.lastIndexOf("27962") - enters.indexOf("27962")).toBe(2);
  });
});
