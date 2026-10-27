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

function makeService(): { service: CategoryService } {
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
  return { service: new CategoryService({ session, client, now: () => NOW, logger }) };
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
});
