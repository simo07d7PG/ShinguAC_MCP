import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AssignmentSchema } from "../../../src/schema/assignment.js";
import { ParseError } from "../../../src/parsers/common.js";
import { parseEclassHome } from "../../../src/parsers/eclass.js";
import {
  buildAssignments,
  parseHomeworkDetail,
  parseHomeworkList,
  type HomeworkDetail,
} from "../../../src/parsers/assignments.js";

const fx = (name: string): string => readFileSync(`tests/fixtures/eclass/${name}`, "utf8");

describe("parseEclassHome", () => {
  const lectures = parseEclassHome(fx("home-2026-2.html"));

  it("4과목과 lectureSeq를 읽는다", () => {
    expect(lectures.map((l) => l.lectureSeq)).toEqual(["27931", "28153", "27488", "27962"]);
    expect(lectures.map((l) => l.courseName)).toEqual([
      "게임프로젝트응용",
      "게임그래픽응용",
      "생활영어(II)",
      "UI화면설계",
    ]);
    expect(lectures.every((l) => l.section === "102")).toBe(true);
    expect(lectures[3]?.professorName).toBe("이교수");
  });

  it("최근 게시물을 읽고 '등록된 내용이 없습니다'는 제외한다", () => {
    expect(lectures[0]?.recentPosts).toEqual([]);
    expect(lectures[1]?.recentPosts).toHaveLength(2);
    const ui = lectures[3]?.recentPosts ?? [];
    expect(ui).toHaveLength(5);
    expect(ui.map((p) => p.board)).toEqual(["자료실", "과제방", "과제방", "자료실", "과제방"]);
    expect(ui[0]).toEqual({
      board: "자료실",
      title: "「2026년 전문대학 혁신지원사업 만족도조사」",
      date: "2026-10-26T00:00:00+09:00",
      href: "/eclass/clas/board/detail?boardId=3&wrId=00000000000000000026",
    });
    expect(ui[1]?.board).toBe("과제방");
    expect(ui[1]?.href).toBe("/eclass/clas/room/homework/homeworkDetail?reportSeq=34771");
  });

  it("빈 홈은 []", () => {
    expect(parseEclassHome(fx("home-empty.html"))).toEqual([]);
  });
});

describe("parseHomeworkList", () => {
  const rows = parseHomeworkList(fx("homework-list.html"));

  it("30건, 첫 행과 마지막 행", () => {
    expect(rows).toHaveLength(30);
    expect(rows[0]).toMatchObject({
      reportSeq: "34771",
      startAt: "2026-10-20T00:00:00+09:00",
      dueAt: "2026-10-27T00:00:00+09:00",
      extendedDueAt: "2026-10-27T00:00:00+09:00",
      submittedCount: 3,
      totalCount: 28,
    });
    expect(rows[0]?.title).toMatch(/^10\/21\(수\) ~ 10\/23\(금\) 사이에 우리과 엑스포/);
    expect(rows[29]).toMatchObject({
      reportSeq: "33791",
      title: "2주차 하단 메뉴바를 figma로 Autolayout 기능 적용해서 제작해오기",
      startAt: "2026-09-01T00:00:00+09:00",
      dueAt: "2026-09-22T00:00:00+09:00",
      extendedDueAt: "2026-09-29T00:00:00+09:00",
      submittedCount: 0,
      totalCount: 28,
    });
  });

  it("표가 없으면 ParseError", () => {
    expect(() => parseHomeworkList("<html><body></body></html>")).toThrow(ParseError);
  });

  it("데이터 없음 행이면 []", () => {
    const html =
      '<table class="table table-list table-center"><tbody><tr><td colspan="4">데이터가 없습니다.</td></tr></tbody></table>';
    expect(parseHomeworkList(html)).toEqual([]);
  });
});

describe("parseHomeworkDetail", () => {
  it("미제출", () => {
    const d = parseHomeworkDetail(fx("homework-detail-not-submitted.html"));
    expect(d.submitStatus).toBe("not_submitted");
    expect(d.scored).toBe(false);
    expect(d.reportSeq).toBe("34771");
    expect(d.startAt).toBe("2026-10-20T00:00:00+09:00");
    expect(d.dueAt).toBe("2026-10-27T00:00:00+09:00");
    expect(d.extendedDueAt).toBe("2026-10-27T00:00:00+09:00");
    expect(d.penaltyNote).toBe("감점 있음 : 1점");
    expect([d.submittedCount, d.totalCount]).toEqual([3, 28]);
    expect(d.attachments).toHaveLength(1);
    expect(d.attachments[0]?.url).toContain("eClassDown.jsp");
  });

  it("제출함 (미채점)", () => {
    const d = parseHomeworkDetail(fx("homework-detail-submitted.html"));
    expect(d.submitStatus).toBe("submitted");
    expect(d.scored).toBe(false);
    expect(d.title).toBe("8주차 수업 중 실습 ] figma 3D logo 제작");
    expect(d.body).toBe("8주차 수업 중 실습 ] figma 3D logo 제작");
    expect([d.submittedCount, d.totalCount]).toEqual([23, 28]);
    expect(d.attachments[0]?.name).toBe("Figma_3D logo-자신의 앱의 figma 3D logo 제작.pptx");
  });

  it("채점된 제출은 scored=true", () => {
    const html = fx("homework-detail-submitted.html").replace('data-score=""', 'data-score="9"');
    expect(parseHomeworkDetail(html).scored).toBe(true);
  });

  it("제출 기간 아님", () => {
    const d = parseHomeworkDetail(fx("homework-detail-not-open.html"));
    expect(d.submitStatus).toBe("not_open");
    expect(d.title).toBe("9주차 수업 중] 동료평가지 제출");
    expect(d.startAt).toBe("2026-10-27T00:00:00+09:00");
    expect(d.dueAt).toBe("2026-10-27T18:00:00+09:00");
    expect(d.extendedDueAt).toBe("2026-10-28T00:00:00+09:00");
    expect([d.submittedCount, d.totalCount]).toEqual([0, 28]);
    expect(d.body).toBe("");
  });

  it("표가 없으면 ParseError", () => {
    expect(() => parseHomeworkDetail("<html></html>")).toThrow(ParseError);
  });
});

describe("buildAssignments", () => {
  const lecture = parseEclassHome(fx("home-2026-2.html"))[3]!;
  const rows = parseHomeworkList(fx("homework-list.html"));

  it("상세 없으면 unknown, 스키마 통과", () => {
    const list = buildAssignments(lecture, rows);
    expect(list).toHaveLength(30);
    for (const a of list) {
      expect(AssignmentSchema.safeParse(a).success).toBe(true);
      expect(a.submitStatus).toBe("unknown");
    }
    expect(list[0]).toMatchObject({
      lectureSeq: "27962",
      reportSeq: "34771",
      courseName: "UI화면설계",
      professorName: "이교수",
      submittedCount: 3,
      totalCount: 28,
      detailUrl: "/eclass/clas/room/homework/homeworkDetail?reportSeq=34771",
    });
  });

  it("상세가 있으면 상태 반영", () => {
    const details = new Map<string, HomeworkDetail>([
      ["34771", parseHomeworkDetail(fx("homework-detail-not-submitted.html"))],
      ["34757", parseHomeworkDetail(fx("homework-detail-submitted.html"))],
    ]);
    const list = buildAssignments(lecture, rows, details);
    expect(list[0]?.submitStatus).toBe("not_submitted");
    expect(list[1]?.reportSeq).toBe("34757");
    expect(list[1]?.submitStatus).toBe("submitted");
    expect(list[2]?.submitStatus).toBe("unknown");
  });
});
