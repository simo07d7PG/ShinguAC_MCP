import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseTimetable, parseTimetablePage } from "../../../src/parsers/timetable.js";
import { TimetableEntrySchema } from "../../../src/schema/timetable.js";

const html = readFileSync("tests/fixtures/timetable/SSE013R.html", "utf8");

describe("parseTimetable", () => {
  const entries = parseTimetable(html);

  it("7개 과목이 등장한다", () => {
    expect(new Set(entries.map((e) => e.courseName))).toEqual(
      new Set([
        "게임프로젝트응용",
        "게임그래픽응용",
        "UI화면설계",
        "생활영어(II)",
        "게임엔진응용",
        "셀프디자인(자기개발성공전략)",
        "게임디자인기초",
      ]),
    );
  });

  it("교시 시간·요일·강의실이 매핑된다", () => {
    expect(entries.find((e) => e.day === 1 && e.period === 2)).toEqual({
      day: 1,
      period: 2,
      startTime: "09:55",
      endTime: "10:45",
      courseName: "게임프로젝트응용",
      professorName: "김교수",
      building: "산학협력관",
      room: "103호",
      roomAlias: "아트&테크놀러지 실습실",
    });
    const tue11 = entries.find((e) => e.day === 2 && e.period === 11);
    expect(tue11?.courseName).toBe("게임디자인기초");
    expect(tue11?.startTime).toBe("18:10");
    expect(tue11?.endTime).toBe("19:00");
    expect(entries.some((e) => e.day === 5 || e.day === 6)).toBe(false);
  });

  it("수요일은 6~7교시 생활영어, 8~9교시 셀프디자인이고 1·5교시는 비어 있다", () => {
    const wed = entries.filter((e) => e.day === 3).map((e) => `${e.period}:${e.courseName}`);
    expect(wed).toEqual([
      "6:생활영어(II)",
      "7:생활영어(II)",
      "8:셀프디자인(자기개발성공전략)",
      "9:셀프디자인(자기개발성공전략)",
    ]);
    expect(entries.some((e) => e.period === 1 || e.period === 5)).toBe(false);
  });

  it("스키마를 통과한다", () => {
    for (const e of entries) expect(() => TimetableEntrySchema.parse(e)).not.toThrow();
  });

  it("한 셀에 연속된 2개 과목을 4줄 단위로 분할한다", () => {
    const cell = (lines: string[]) => `<td>${lines.join("<br>")}</td>`;
    const empty = "<td><br><br><br></td>";
    const two = ["A과목", "가교수", "남관 101호", "별칭1", "B과목", "나교수", "남관 102호", "별칭2"];
    const synthetic = `<table class="table-list table-center"><tr><th>시간</th></tr>
      <tr><td>6<br>13:35~14:25</td>${empty}${empty}${cell(two)}${empty}${empty}${empty}</tr></table>`;
    expect(parseTimetable(synthetic).map((e) => [e.day, e.period, e.courseName, e.room])).toEqual([
      [3, 6, "A과목", "101호"],
      [3, 6, "B과목", "102호"],
    ]);
  });
});

describe("parseTimetablePage", () => {
  it("학년도와 학기 코드를 반환한다", () => {
    const page = parseTimetablePage(html);
    expect(page.year).toBe(2026);
    expect(page.semester).toBe("2");
    expect(page.entries.length).toBeGreaterThan(0);
  });
});
