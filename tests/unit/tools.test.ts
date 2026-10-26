import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthRejectedError } from "../../src/auth/errors.js";
import { NetworkError } from "../../src/http/errors.js";
import type { Assignment, Course, Grades, Meta, NoticeDetail, NoticeSummary, TimetableEntry } from "../../src/schema/index.js";
import { createServer } from "../../src/server.js";
import type { ToolService } from "../../src/tools/index.js";

const LIVE: Meta = { fetchedAt: "2026-10-26T12:00:00+09:00", stale: false, source: "live" };
const STALE: Meta = {
  fetchedAt: "2026-10-25T09:00:00+09:00",
  stale: true,
  source: "snapshot",
  warning: "포털 조회 실패로 저장된 스냅샷을 반환합니다",
};

const assignment: Assignment = {
  lectureSeq: "1",
  reportSeq: "10",
  courseName: "자료구조",
  title: "과제 1",
  startAt: null,
  dueAt: "2026-10-28T23:59:00+09:00",
  extendedDueAt: null,
  submitStatus: "not_submitted",
  detailUrl: "/eclass/x",
};
const entries: TimetableEntry[] = [
  { day: 1, period: 1, courseName: "자료구조", professorName: "김교수" },
  { day: 6, period: 2, courseName: "운영체제", professorName: "이교수" },
];
const course: Course = { courseName: "자료구조", year: 2026, semester: "2", professor: { name: "김교수" } };
const notice: NoticeSummary = { id: "univ:1", category: "univ", title: "공지", postedAt: null, url: "/n/1" };
const detail: NoticeDetail = { ...notice, body: "본문", attachments: [] };
const grades: Grades = { semesters: [], credits: [], current: [] };

function mockService(): { [K in keyof ToolService]: ReturnType<typeof vi.fn> } {
  return {
    getAssignments: vi.fn(async () => ({ data: [assignment], meta: LIVE })),
    getAssignment: vi.fn(async () => ({
      data: {
        ...assignment,
        body: "본문",
        attachments: [{ name: "a.pdf", url: "https://cec.shingu.ac.kr/x" }],
        scored: false,
        submitStatus: "not_submitted" as const,
      },
      meta: LIVE,
    })),
    getTimetable: vi.fn(async () => ({ data: entries, meta: LIVE })),
    getCourses: vi.fn(async () => ({ data: [course], meta: LIVE })),
    getNotices: vi.fn(async () => ({ data: [notice], meta: STALE })),
    getNotice: vi.fn(async () => ({ data: detail, meta: LIVE })),
    getGrades: vi.fn(async () => ({ data: grades, meta: LIVE })),
    refreshAll: vi.fn(async () => [
      { category: "assignments", ok: true, fetchedAt: LIVE.fetchedAt },
      { category: "grades", ok: false, error: "NetworkError: x" },
    ]),
  };
}

let service: ReturnType<typeof mockService>;
let client: Client;

beforeEach(async () => {
  service = mockService();
  const server = createServer({ service: service as unknown as ToolService });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(async () => {
  await client.close();
  vi.restoreAllMocks();
});

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  // listTools로 outputSchema를 캐시해야 클라이언트도 structuredContent를 검증한다.
  await client.listTools();
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function structured(res: CallToolResult): Record<string, unknown> {
  expect(res.isError).toBeFalsy();
  expect(res.structuredContent).toBeDefined();
  const text = res.content[0];
  expect(text?.type).toBe("text");
  expect(JSON.parse((text as { text: string }).text)).toEqual(res.structuredContent);
  return res.structuredContent!;
}

const TOOL_NAMES = [
  "get_assignment",
  "get_assignments",
  "get_courses",
  "get_grades",
  "get_notice",
  "get_notices",
  "get_timetable",
  "refresh_snapshots",
];

describe("tools/list", () => {
  it("8개 도구와 입력·출력 스키마, 출처 표기를 노출한다", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOL_NAMES);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.outputSchema?.type).toBe("object");
      expect(t.description).toContain("출처: 신구대학교 학생종합포털");
    }
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName["get_assignments"]!.inputSchema.properties ?? {})).toEqual(["due_within_days"]);
    expect(byName["get_assignments"]!.description).toContain("이번 주 과제/마감 질문에 사용");
    expect(Object.keys(byName["get_timetable"]!.inputSchema.properties ?? {})).toEqual(["week"]);
    expect(Object.keys(byName["get_courses"]!.inputSchema.properties ?? {})).toEqual(["include_contacts"]);
    expect(Object.keys(byName["get_notices"]!.inputSchema.properties ?? {}).sort()).toEqual([
      "category",
      "include_eclass",
      "limit",
    ]);
    expect(byName["get_notice"]!.inputSchema.required).toEqual(["id"]);
    expect(Object.keys(byName["get_grades"]!.inputSchema.properties ?? {})).toEqual(["semester"]);
  });
});

describe("조회 도구", () => {
  it.each([
    ["get_assignments", {}],
    ["get_assignment", { report_seq: "10" }],
    ["get_timetable", {}],
    ["get_courses", {}],
    ["get_notices", {}],
    ["get_notice", { id: "univ:1" }],
    ["get_grades", {}],
  ])("%s: data + 메타 3필드를 반환한다", async (name, args) => {
    const out = structured(await call(name, args));
    expect(out).toHaveProperty("data");
    expect(typeof out["fetchedAt"]).toBe("string");
    expect(typeof out["stale"]).toBe("boolean");
    expect(["live", "snapshot"]).toContain(out["source"]);
  });

  it("스냅샷 fallback 메타(stale·warning)를 그대로 전달한다", async () => {
    const out = structured(await call("get_notices"));
    expect(out).toMatchObject({ stale: true, source: "snapshot", fetchedAt: STALE.fetchedAt });
    expect(out["warning"]).toContain("스냅샷");
  });

  it("get_assignments: due_within_days를 dueWithinDays로 전달한다", async () => {
    await call("get_assignments", { due_within_days: 7 });
    expect(service.getAssignments).toHaveBeenLastCalledWith({ dueWithinDays: 7 });
    await call("get_assignments");
    expect(service.getAssignments).toHaveBeenLastCalledWith({ dueWithinDays: undefined });
  });

  it("get_timetable: week가 속한 주의 실제 날짜를 붙인다", async () => {
    // 2026-10-28은 수요일 → 그 주 월요일 2026-10-26
    const out = structured(await call("get_timetable", { week: "2026-10-28" }));
    expect(out["week"]).toEqual({ start: "2026-10-26", end: "2026-11-01" });
    expect((out["data"] as Array<{ day: number; date: string }>).map((e) => [e.day, e.date])).toEqual([
      [1, "2026-10-26"],
      [6, "2026-10-31"],
    ]);
  });

  it("get_timetable: 달력에 없는 날짜는 isError", async () => {
    const res = await call("get_timetable", { week: "2026-02-30" });
    expect(res.isError).toBe(true);
    expect(service.getTimetable).not.toHaveBeenCalled();
  });

  it("get_courses: include_contacts 기본 false, true 전달", async () => {
    await call("get_courses");
    expect(service.getCourses).toHaveBeenLastCalledWith({ includeContacts: false });
    await call("get_courses", { include_contacts: true });
    expect(service.getCourses).toHaveBeenLastCalledWith({ includeContacts: true });
  });

  it("get_notices: limit·category를 전달하고 기본 limit=20", async () => {
    await call("get_notices");
    expect(service.getNotices).toHaveBeenLastCalledWith({ category: undefined, limit: 20, includeEclass: false });
    await call("get_notices", { category: "scholarship", limit: 5 });
    expect(service.getNotices).toHaveBeenLastCalledWith({ category: "scholarship", limit: 5, includeEclass: false });
    await call("get_notices", { category: "eclass" });
    expect(service.getNotices).toHaveBeenLastCalledWith({ category: "eclass", limit: 20, includeEclass: true });
  });

  it("get_notices: 범위 밖 limit·알 수 없는 category는 isError", async () => {
    expect((await call("get_notices", { limit: 0 })).isError).toBe(true);
    expect((await call("get_notices", { limit: 101 })).isError).toBe(true);
    expect((await call("get_notices", { category: "etc" })).isError).toBe(true);
    expect(service.getNotices).not.toHaveBeenCalled();
  });

  it("get_notice: id를 전달한다", async () => {
    await call("get_notice", { id: "eclass:1:2:3" });
    expect(service.getNotice).toHaveBeenLastCalledWith("eclass:1:2:3");
  });

  it("get_grades: semester를 전달하고 형식이 틀리면 isError", async () => {
    await call("get_grades", { semester: "2026-1" });
    expect(service.getGrades).toHaveBeenLastCalledWith({ semester: "2026-1" });
    expect((await call("get_grades", { semester: "2026-3" })).isError).toBe(true);
    expect(service.getGrades).toHaveBeenCalledTimes(1);
  });
});

describe("refresh_snapshots", () => {
  it("범주별 결과와 fetchedAt을 반환한다", async () => {
    const out = structured(await call("refresh_snapshots"));
    expect(out["results"]).toHaveLength(2);
    expect(typeof out["fetchedAt"]).toBe("string");
  });
});

describe("오류", () => {
  it("AuthRejectedError → isError + 설정 안내", async () => {
    service.getGrades.mockRejectedValueOnce(new AuthRejectedError());
    const res = await call("get_grades");
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("SHINGU_ID");
    expect(text).toContain("config.json");
  });

  it("예기치 않은 오류도 isError로 감싸고 stderr에 기록, 메시지는 redact", async () => {
    service.getTimetable.mockRejectedValueOnce(new NetworkError("connect failed password=hunter2 jsessionid=abc"));
    const res = await call("get_timetable");
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("abc");
    expect(process.stderr.write).toHaveBeenCalled();
  });
});
