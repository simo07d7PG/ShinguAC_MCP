import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthRejectedError } from "../../src/auth/errors.js";
import { SessionManager } from "../../src/auth/session-manager.js";
import { ConfigError, type Config } from "../../src/config/config.js";
import { Secret } from "../../src/config/secret.js";
import { HttpClient } from "../../src/http/http-client.js";
import { RequestQueue } from "../../src/queue/request-queue.js";
import { ArchiveDb } from "../../src/store/archive-db.js";
import { CategoryService } from "../../src/service/category-service.js";

const SENTINEL = "SENTINEL-PW-9f3a";
const NOW = new Date("2026-10-26T12:00:00+09:00");

const fixture = (name: string): string => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
const html = (name: string): Response =>
  new Response(fixture(name), { status: 200, headers: { "content-type": "text/html;charset=UTF-8" } });

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: URLSearchParams;
}

const ROUTES: Record<string, () => Response> = {
  "GET student.shingu.ac.kr/dashboard/dashboard": () => html("dashboard.html"),
  "GET student.shingu.ac.kr/SSE/SSE013R/SSE013R": () => html("timetable/SSE013R.html"),
  "GET student.shingu.ac.kr/SSJ/SSJ018P/SSJ018P": () => html("grades/SSJ018P-current.html"),
  "GET student.shingu.ac.kr/SSJ/SSJ019P/SSJ019P": () => html("grades/SSJ019P-confirmed.html"),
  "GET student.shingu.ac.kr/SSG/SSG005P/SSG005P": () => html("grades/SSG005P-credits.html"),
  "GET student.shingu.ac.kr/eclass/home": () => html("eclass/home-2026-2.html"),
  "POST student.shingu.ac.kr/eclass/clas/home": () => html("eclass/clas-home.html"),
  "GET student.shingu.ac.kr/eclass/clas/room/homework/homeworkList": () => html("eclass/homework-list.html"),
  "GET student.shingu.ac.kr/eclass/clas/room/homework/homeworkDetail": () =>
    html("eclass/homework-detail-not-submitted.html"),
  "GET student.shingu.ac.kr/eclass/clas/info/intro/introView": () => html("eclass/intro-view.html"),
  "GET student.shingu.ac.kr/eclass/clas/info/plan/planView": () => html("eclass/plan-view.html"),
  "GET student.shingu.ac.kr/eclass/clas/board/list": () => html("eclass/board-list-notice-filled.html"),
  "GET student.shingu.ac.kr/eclass/clas/board/detail": () => html("eclass/board-detail-notice.html"),
  "GET www.shingu.ac.kr/cms/FR_BBS_CON/BoardView.do": () => html("cms/BoardView.html"),
  "POST www.shingu.ac.kr/ajaxf/FR_BBS_SVC/BoardViewData.do": () =>
    new Response(fixture("cms/BoardViewData.json"), {
      status: 200,
      headers: { "content-type": "application/json;charset=UTF-8" },
    }),
};

function connRefused(): never {
  throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
}

let root: string;
let requests: Recorded[];
/** true면 모든 요청, 함수면 그 조건을 만족하는 요청이 ECONNREFUSED로 실패한다. */
let offline: boolean | ((key: string) => boolean);
let login: ReturnType<typeof vi.fn<(client: HttpClient, id: string, password: string) => Promise<void>>>;
let loadConfig: () => Config;

function makeService(now: Date = NOW, archiveDb?: ArchiveDb): { service: CategoryService } {
  const fetchMock = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const key = `${method} ${url.host}${url.pathname}`;
    requests.push({
      method,
      url: url.href,
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: new URLSearchParams(typeof init?.body === "string" ? init.body : ""),
    });
    if (offline === true || (typeof offline === "function" && offline(key))) connRefused();
    const route = ROUTES[key];
    if (!route) throw new Error(`unexpected request: ${key}`);
    return route();
  };
  const client = new HttpClient({ fetch: fetchMock as typeof fetch, queue: new RequestQueue({ minGapMs: 0 }) });
  const session = new SessionManager({ client, login, loadConfig });
  const logger = { debug: () => {}, info: () => {}, warn: () => {} };
  return { service: new CategoryService({ session, client, now: () => now, logger, ...(archiveDb ? { archive: { db: archiveDb, filesDir: join(root, "files") } } : {}) }) };
}

const paths = (method: string, path: string): Recorded[] =>
  requests.filter((r) => r.method === method && new URL(r.url).pathname === path);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "svc-"));
  requests = [];
  offline = false;
  login = vi.fn(async (_c: HttpClient, _id: string, _pw: string) => {});
  loadConfig = () => ({ id: "2000000000", password: new Secret(SENTINEL), homeDir: root });
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("CategoryService.getAssignments", () => {
  it("live: fetchedAt 메타, 상세는 마감 범위 과제에만 요청", async () => {
    const { service } = makeService();
    const res = await service.getAssignments({ dueWithinDays: 1 });

    expect(res.meta).toEqual({ fetchedAt: "2026-10-26T12:00:00+09:00" });
    // E클래스 홈은 현재 학년도/학기를 명시한다.
    const home = paths("GET", "/eclass/home");
    expect(home).toHaveLength(1);
    expect(new URL(home[0]!.url).searchParams.get("lectureYear")).toBe("2026");
    expect(new URL(home[0]!.url).searchParams.get("lectureTerm")).toBe("2");
    // 4과목 진입 + 목록
    const enters = paths("POST", "/eclass/clas/home");
    expect(enters.map((r) => r.body.get("lectureSeq"))).toEqual(["27931", "28153", "27488", "27962"]);
    expect(enters.every((r) => r.body.get("redirect") === "")).toBe(true);
    expect(paths("GET", "/eclass/clas/room/homework/homeworkList")).toHaveLength(4);

    // 연장기한(없으면 마감) ∈ [now, 2026-10-27T12:00] 인 과제 (과목당 8건)
    const detailSeqs = paths("GET", "/eclass/clas/room/homework/homeworkDetail").map((r) =>
      new URL(r.url).searchParams.get("reportSeq"),
    );
    expect(detailSeqs).toHaveLength(32);
    expect(new Set(detailSeqs)).toEqual(
      new Set(["34771", "34757", "34712", "34706", "34584", "34582", "34579", "34577"]),
    );

    expect(res.data).toHaveLength(32);
    expect(res.data.every((a) => a.submitStatus === "not_submitted")).toBe(true);
  });

  it("due_within_days 미지정: 상세는 14일 범위, 반환은 전체", async () => {
    const { service } = makeService();
    const res = await service.getAssignments();
    // 연장기한(없으면 마감) 기준 14일 범위 12건 중 제출 시작 전 1건(34710)은 상세 생략 → 과목당 11건
    expect(paths("GET", "/eclass/clas/room/homework/homeworkDetail")).toHaveLength(44);
    expect(res.data).toHaveLength(120);
    // 범위 밖은 unknown, 제출 시작 전(34710)은 상세 없이 not_open
    expect(res.data.find((a) => a.reportSeq === "34710")?.submitStatus).toBe("not_open");
    expect(res.data.find((a) => a.reportSeq === "34771")?.submitStatus).toBe("not_submitted");
  });

  it("포털 실패: 원 오류 throw", async () => {
    const { service } = makeService();
    offline = true;
    await expect(service.getAssignments()).rejects.toMatchObject({ name: "NetworkError" });
  });

  it("AuthRejectedError는 요청 없이 그대로 전달", async () => {
    login = vi.fn(async (_c: HttpClient, _id: string, _pw: string): Promise<void> => {
      throw new AuthRejectedError();
    });
    const { service } = makeService();
    await expect(service.getAssignments()).rejects.toBeInstanceOf(AuthRejectedError);
    expect(requests).toHaveLength(0);
  });

  it("ConfigError도 그대로 전달", async () => {
    loadConfig = () => {
      throw new ConfigError("자격증명을 찾을 수 없습니다.");
    };
    const { service } = makeService();
    await expect(service.getTimetable()).rejects.toBeInstanceOf(ConfigError);
  });
});

describe("CategoryService 기타 범주", () => {
  it("getTimetable: SSE013R에 Yy/Haggi 전달", async () => {
    const { service } = makeService();
    const res = await service.getTimetable();
    const req = paths("GET", "/SSE/SSE013R/SSE013R")[0]!;
    expect(new URL(req.url).searchParams.get("Yy")).toBe("2026");
    expect(new URL(req.url).searchParams.get("Haggi")).toBe("2");
    expect(res.data.length).toBeGreaterThan(0);
    expect(res.meta.fetchedAt).toBe("2026-10-26T12:00:00+09:00");
  });

  it("getCourses: E클래스 과목만 lectureSeq·연락처 병합, includeContacts=false면 진입 안 함", async () => {
    const { service } = makeService();
    const res = await service.getCourses();
    const ui = res.data.find((c) => c.courseName === "UI화면설계");
    expect(ui?.lectureSeq).toBe("27962");
    expect(ui?.professor.email).toBe("user@example.com");
    expect(res.data.filter((c) => c.lectureSeq)).toHaveLength(4);
    expect(paths("POST", "/eclass/clas/home")).toHaveLength(4);

    requests = [];
    const lite = await service.getCourses({ includeContacts: false });
    expect(paths("POST", "/eclass/clas/home")).toHaveLength(0);
    expect(lite.data.find((c) => c.courseName === "UI화면설계")?.professor.email).toBeUndefined();
  });

  it("getNotices: category 필터와 limit, includeEclass 기본 false", async () => {
    const { service } = makeService();
    const res = await service.getNotices({ category: "scholarship", limit: 3 });
    expect(res.data).toHaveLength(3);
    expect(res.data.every((n) => n.category === "scholarship")).toBe(true);
    expect(requests).toHaveLength(1);

    requests = [];
    const withEclass = await service.getNotices({ includeEclass: true, limit: 100 });
    expect(paths("GET", "/eclass/clas/board/list")).toHaveLength(4);
    expect(withEclass.data.some((n) => n.category === "eclass")).toBe(true);
  });

  it("getGrades: 3요청, semester 필터는 반환 직전", async () => {
    const { service } = makeService();
    await service.getGrades();
    expect(requests).toHaveLength(3);
    const filtered = await service.getGrades({ semester: "2026-1" });
    expect(filtered.data.semesters.every((s) => s.year === 2026 && s.semester === "1")).toBe(true);
    expect(filtered.data.current).toHaveLength(0);
    expect(filtered.data.credits.every((c) => c.total || (c.year === 2026 && c.semester === "1"))).toBe(true);
  });
});

describe("CategoryService.getNotice", () => {
  it("univ:17703 → 페이지 GET 후 BoardViewData POST(sendForm 필드), 로그인 없이", async () => {
    const { service } = makeService();
    const res = await service.getNotice("univ:17703");

    expect(login).not.toHaveBeenCalled();
    expect(requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      "GET /cms/FR_BBS_CON/BoardView.do",
      "POST /ajaxf/FR_BBS_SVC/BoardViewData.do",
    ]);
    const pageUrl = requests[0]!.url;
    expect(pageUrl).toBe(
      "https://www.shingu.ac.kr/cms/FR_BBS_CON/BoardView.do?MENU_ID=1400&SITE_NO=2&BOARD_SEQ=4&BBS_SEQ=17703",
    );
    const post = requests[1]!;
    expect(Object.fromEntries(post.body)).toEqual({
      MENU_ID: "1400",
      CONTENTS_NO: "1",
      SITE_NO: "2",
      BOARD_SEQ: "4",
      BBS_SEQ: "17703",
      P_BBS_SEQ: "",
      CATE_SEQ: "",
      PWD: "",
      pageNo: "",
      SEARCH_SEQ: "",
      SEARCH_FLD: "",
      SEARCH: "",
      PREV_IDX: "17546",
      NEXT_IDX: "17693",
    });
    expect(post.headers["X-Requested-With"]).toBe("XMLHttpRequest");
    expect(post.headers["Referer"]).toBe(pageUrl);

    expect(res.data.title).toBe("[대구한의대학교] K-MOOC 「청년 경제 토크콘서트」 개최 안내");
    expect(res.data.body).toContain("대구한의대학교에서 K-MOOC 「청년 경제 토크콘서트」를 개최하오니");
    expect(res.data.postedAt).toBe("2026-10-26T14:10:00+09:00");
    expect(res.data.attachments[0]).toEqual({
      name: "[대구한의대학교] 청년 경제 토크콘서트 홍보 포스터.png",
      url: "https://www.shingu.ac.kr/ajaxfile/FR_SVC/FileDown.do?GBN=X01&BOARD_SEQ=4&SITE_NO=2&BBS_SEQ=17703&FILE_SEQ=1",
    });
  });

  it("eclass:<lectureSeq>:1:<wrId> → 강의 진입 후 board/detail, 목록 결과의 요약을 이어받음", async () => {
    const { service } = makeService();
    await service.getNotices({ includeEclass: true, limit: 100 });
    requests = [];
    const id = "eclass:28153:1:00000000000000000002";
    const res = await service.getNotice(id);
    expect(requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      "POST /eclass/clas/home",
      "GET /eclass/clas/board/detail",
    ]);
    expect(requests[0]!.body.get("lectureSeq")).toBe("28153");
    expect(new URL(requests[1]!.url).searchParams.get("wrId")).toBe("00000000000000000002");
    expect(res.data.id).toBe(id);
    expect(res.data.courseName).toBe("게임그래픽응용");
    expect(res.data.title).toBe("3ds max 설치 링크 (교육용으로 설치)");
    expect(res.data.body).toContain("autodesk.com");
  });
});

describe("CategoryService.getAssignments (아카이브 상태)", () => {
  it("상세를 읽지 않은 unknown 과제는 아카이브 DB의 저장 상태를 쓰고 포털 요청은 늘지 않는다", async () => {
    const plain = await makeService().service.getAssignments();
    const target = plain.data.find((a) => a.submitStatus === "unknown")!;
    const baseline = requests.length;
    requests = [];

    const db = new ArchiveDb(join(root, "eclass.db"));
    try {
      db.upsertCourse({ lectureSeq: target.lectureSeq, courseName: target.courseName, year: 2026, semester: "2" }, "2026-10-26T12:00:00+09:00");
      db.upsertAssignment(
        {
          reportSeq: target.reportSeq,
          lectureSeq: target.lectureSeq,
          title: target.title,
          startAt: null,
          dueAt: target.dueAt,
          extendedDueAt: target.extendedDueAt,
          penaltyNote: null,
          contentHtml: "",
          contentText: "",
          submitStatus: "submitted",
        },
        "2026-10-26T12:00:00+09:00",
      );
      const res = await makeService(NOW, db).service.getAssignments();
      expect(requests).toHaveLength(baseline);
      const same = (a: { reportSeq: string }): boolean => a.reportSeq === target.reportSeq;
      expect(res.data.filter(same).every((a) => a.submitStatus === "submitted")).toBe(true);
      // 저장된 상태가 없는 unknown은 그대로 unknown
      const unknownLeft = (list: typeof res.data): number => list.filter((a) => a.submitStatus === "unknown" && !same(a)).length;
      expect(unknownLeft(res.data)).toBe(unknownLeft(plain.data));
    } finally {
      db.close();
    }
  });

  it("저장된 미제출·기간 아님은 쓰지 않는다(저장 뒤에 바뀌었을 수 있음)", async () => {
    const plain = await makeService().service.getAssignments();
    const targets = plain.data.filter((a) => a.submitStatus === "unknown").slice(0, 2);
    expect(targets).toHaveLength(2);
    const db = new ArchiveDb(join(root, "eclass.db"));
    try {
      targets.forEach((t, i) => {
        db.upsertCourse({ lectureSeq: t.lectureSeq, courseName: t.courseName, year: 2026, semester: "2" }, "2026-10-26T12:00:00+09:00");
        db.upsertAssignment(
          {
            reportSeq: t.reportSeq,
            lectureSeq: t.lectureSeq,
            title: t.title,
            startAt: null,
            dueAt: t.dueAt,
            extendedDueAt: t.extendedDueAt,
            penaltyNote: null,
            contentHtml: "",
            contentText: "",
            submitStatus: i === 0 ? "not_submitted" : "not_open",
          },
          "2026-10-26T12:00:00+09:00",
        );
      });
      const res = await makeService(NOW, db).service.getAssignments();
      for (const t of targets) {
        expect(res.data.find((a) => a.reportSeq === t.reportSeq)?.submitStatus).toBe("unknown");
      }
    } finally {
      db.close();
    }
  });
});

describe("CategoryService.getAssignment", () => {
  it("강의 진입 후 상세를 가져오고 본문·첨부·제출 상태를 반환한다", async () => {
    const { service } = makeService();
    const res = await service.getAssignment({ reportSeq: "34771", lectureSeq: "27962" });
    expect(res.meta.fetchedAt).toBe("2026-10-26T12:00:00+09:00");
    expect(res.data.reportSeq).toBe("34771");
    expect(res.data.lectureSeq).toBe("27962");
    expect(res.data.title.length).toBeGreaterThan(0);
    expect(typeof res.data.body).toBe("string");
    expect(["submitted", "not_submitted", "not_open"]).toContain(res.data.submitStatus);
    expect(paths("POST", "/eclass/clas/home")).toHaveLength(1);
    expect(paths("GET", "/eclass/clas/room/homework/homeworkDetail")).toHaveLength(1);
  });

  it("lecture_seq가 없고 스냅샷에도 없으면 안내 오류", async () => {
    const { service } = makeService();
    await expect(service.getAssignment({ reportSeq: "999" })).rejects.toThrow(/get_assignments/);
  });

  describe("마감 지난 not_open 과제의 제출 판정", () => {
    const DETAIL = "GET student.shingu.ac.kr/eclass/clas/room/homework/homeworkDetail";
    const EDIT = "GET student.shingu.ac.kr/eclass/clas/room/homework/editModal";
    const LATER = new Date("2026-11-30T12:00:00+09:00");
    const emptyModal = (): string =>
      fixture("eclass/homework-edit-modal.html")
        .replace(/(name="reportTitle"[^>]*value=')[^']*'/, "$1'")
        .replace(/(<textarea[^>]*name="reportContent"[^>]*>)[\s\S]*?(<\/textarea>)/, "$1$2")
        .replace(/data-file-master-key="[^"]*"/, 'data-file-master-key=""');
    const modalRoute = (body: string) => (): Response =>
      new Response(body, { status: 200, headers: { "content-type": "text/html;charset=UTF-8" } });
    const editCount = (): number => paths("GET", "/eclass/clas/room/homework/editModal").length;
    const call = (now: Date) => makeService(now).service.getAssignment({ reportSeq: "34771", lectureSeq: "27962" });

    beforeEach(() => {
      ROUTES[DETAIL] = () => html("eclass/homework-detail-not-open.html");
    });
    afterEach(() => {
      ROUTES[DETAIL] = () => html("eclass/homework-detail-not-submitted.html");
      delete ROUTES[EDIT];
    });

    it("editModal에 내용이 있으면 submitted, 요청은 1회만 늘어난다", async () => {
      ROUTES[EDIT] = () => html("eclass/homework-edit-modal.html");
      const res = await call(LATER);
      expect(res.data.submitStatus).toBe("submitted");
      expect(editCount()).toBe(1);
      expect(paths("GET", "/eclass/clas/room/homework/homeworkDetail")).toHaveLength(1);
      expect(paths("GET", "/file/info")).toHaveLength(0);
      expect(requests).toHaveLength(3); // 진입 + 상세 + editModal
    });

    it("editModal이 비어 있으면 not_open 유지", async () => {
      ROUTES[EDIT] = modalRoute(emptyModal());
      const res = await call(LATER);
      expect(res.data.submitStatus).toBe("not_open");
      expect(editCount()).toBe(1);
    });

    it("editModal을 읽지 못하면(ParseError) not_open 유지", async () => {
      ROUTES[EDIT] = modalRoute("<html><body>없음</body></html>");
      const res = await call(LATER);
      expect(res.data.submitStatus).toBe("not_open");
    });

    it("editModal 요청이 네트워크 오류면 not_open을 유지하고 상세는 돌려준다", async () => {
      ROUTES[EDIT] = () => html("eclass/homework-edit-modal.html");
      offline = (key) => key === EDIT;
      const res = await call(LATER);
      expect(res.data.submitStatus).toBe("not_open");
      expect(res.data.title).toBeTruthy();
      expect(editCount()).toBeGreaterThanOrEqual(1);
    });

    it("상세에 마감이 없으면 알던 마감(아카이브 DB)으로 판정한다", async () => {
      ROUTES[EDIT] = () => html("eclass/homework-edit-modal.html");
      ROUTES[DETAIL] = () =>
        new Response(fixture("eclass/homework-detail-not-open.html").replaceAll('data-role="date"', 'data-role="none"'), {
          status: 200,
          headers: { "content-type": "text/html;charset=UTF-8" },
        });
      // 알던 마감이 없으면 판정하지 않는다.
      expect((await call(LATER)).data.submitStatus).toBe("not_open");
      expect(editCount()).toBe(0);

      const db = new ArchiveDb(join(root, "eclass.db"));
      try {
        db.upsertCourse({ lectureSeq: "27962", courseName: "UI화면설계", year: 2026, semester: "2" }, "2026-10-26T12:00:00+09:00");
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
            submitStatus: "not_open",
          },
          "2026-10-26T12:00:00+09:00",
        );
        const res = await makeService(LATER, db).service.getAssignment({ reportSeq: "34771", lectureSeq: "27962" });
        expect(res.data.submitStatus).toBe("submitted");
        expect(editCount()).toBe(1);
      } finally {
        db.close();
      }
    });

    it("마감 전(제출 시작 전)이면 editModal을 읽지 않는다", async () => {
      const res = await call(NOW);
      expect(res.data.submitStatus).toBe("not_open");
      expect(editCount()).toBe(0);
    });
  });
});
