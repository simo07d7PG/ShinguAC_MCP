import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildGrades,
  isOutOfPeriod,
  parseAvailableSemesters,
  parseCreditSummary,
  parseCurrentCourseGrades,
  parseSemesterGrades,
} from "../../../src/parsers/grades.js";
import { ParseError } from "../../../src/parsers/common.js";

const fx = (name: string) => readFileSync(new URL(`../../fixtures/grades/${name}`, import.meta.url), "utf8");

describe("parseCurrentCourseGrades (SSJ018P)", () => {
  const rows = parseCurrentCourseGrades(fx("SSJ018P-current.html"));

  it("7과목을 파싱한다", () => {
    expect(rows).toHaveLength(7);
    expect(rows.map((r) => r.courseName)).toEqual([
      "생활영어(II)",
      "UI화면설계",
      "셀프디자인(자기개발성공전략)",
      "게임디자인기초",
      "게임그래픽응용",
      "게임엔진응용",
      "게임프로젝트응용",
    ]);
  });

  it("이수구분·학점·교수명·과목코드", () => {
    expect(rows[0]).toEqual({
      year: 2026,
      semester: "2",
      courseName: "생활영어(II)",
      courseCode: "00263",
      completionType: "교선",
      credits: 2,
      professorName: "정교수",
      score: null,
      grade: null,
      status: "성적미완료",
    });
    expect(rows[1]).toMatchObject({ courseCode: "16010", completionType: "전선", credits: 3, professorName: "이교수" });
    expect(rows[6]).toMatchObject({ courseCode: "36121", professorName: "김교수" });
  });
});

describe("parseSemesterGrades / parseAvailableSemesters (SSJ019P)", () => {
  it("확정 학기 1건", () => {
    expect(parseSemesterGrades(fx("SSJ019P-confirmed.html"))).toEqual([
      {
        year: 2026,
        semester: "1",
        gradeLevel: 1,
        appliedCredits: 22,
        earnedCredits: 22,
        gpa: 3.5,
        avgScore: 90,
        academicWarning: false,
      },
    ]);
  });

  it("학기 탭 목록", () => {
    expect(parseAvailableSemesters(fx("SSJ019P-confirmed.html"))).toEqual([{ year: 2026, semester: "1" }]);
  });
});

describe("parseCreditSummary (SSG005P)", () => {
  const rows = parseCreditSummary(fx("SSG005P-credits.html"));

  it("학기 2행 + 전체 1행", () => {
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ year: 2026, semester: "1", earnedCredits: 22, appliedCredits: 22, gpa: 3.5, avgScore: 90 });
    expect(rows[0]!.byType).toEqual({ 교필: 0, 교선: 4, 전필: 0, 전선: 18, 교직: 0, 인접: 0, 교양: 0, 전공: 0 });
    expect(rows[1]).toMatchObject({ year: 2026, semester: "2", earnedCredits: 19, gpa: 0, avgScore: 0 });
    expect(rows[1]!.byType["전선"]).toBe(15);
  });

  it("전체 행은 total이고 byType 합이 취득학점과 같다", () => {
    const total = rows[2]!;
    expect(total.total).toBe(true);
    expect(total.year).toBeUndefined();
    expect(total.semester).toBeUndefined();
    expect(total.byType).toMatchObject({ 교선: 8, 전선: 33 });
    expect(Object.values(total.byType).reduce((a, b) => a + b, 0)).toBe(41);
    expect(total.earnedCredits).toBe(41);
  });
});

describe("출력기간 외 페이지 (SSJ038P)", () => {
  it("isOutOfPeriod 감지", () => {
    expect(isOutOfPeriod(fx("SSJ038P-out-of-period.html"))).toBe(true);
    expect(isOutOfPeriod(fx("SSJ019P-confirmed.html"))).toBe(false);
  });
});

describe("파서 실패", () => {
  it("표가 없으면 ParseError", () => {
    expect(() => parseSemesterGrades("<html></html>")).toThrow(ParseError);
    expect(() => parseCreditSummary("<html></html>")).toThrow(ParseError);
    expect(() => parseCurrentCourseGrades("<html></html>")).toThrow(ParseError);
  });
});

describe("buildGrades", () => {
  it("세 결과를 Grades로 합친다", () => {
    const g = buildGrades({
      current: parseCurrentCourseGrades(fx("SSJ018P-current.html")),
      semesters: parseSemesterGrades(fx("SSJ019P-confirmed.html")),
      credits: parseCreditSummary(fx("SSG005P-credits.html")),
    });
    expect(g.current).toHaveLength(7);
    expect(g.semesters).toHaveLength(1);
    expect(g.credits).toHaveLength(3);
  });
});
