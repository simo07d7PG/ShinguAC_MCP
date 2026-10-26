import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  mergeCourseContacts,
  parseCurrentCourses,
  parseProfessorIntro,
  parseSyllabus,
} from "../../../src/parsers/courses.js";
import { CourseSchema } from "../../../src/schema/course.js";

const read = (p: string) => readFileSync(`tests/fixtures/${p}`, "utf8");

describe("parseCurrentCourses", () => {
  const courses = parseCurrentCourses(read("grades/SSJ018P-current.html"));

  it("과목 7건을 파싱하고 스키마를 통과한다", () => {
    expect(courses).toHaveLength(7);
    for (const c of courses) expect(() => CourseSchema.parse(c)).not.toThrow();
  });

  it("과목정보와 이수구분/학점/교수를 읽는다", () => {
    expect(courses[0]).toEqual({
      courseName: "생활영어(II)",
      courseCode: "00263",
      section: "102",
      year: 2026,
      semester: "2",
      completionType: "교선",
      credits: 2,
      professor: { name: "정교수" },
    });
    expect(courses.map((c) => [c.courseName, c.completionType, c.credits, c.professor.name])).toEqual([
      ["생활영어(II)", "교선", 2, "정교수"],
      ["UI화면설계", "전선", 3, "이교수"],
      ["셀프디자인(자기개발성공전략)", "교선", 2, "조교수"],
      ["게임디자인기초", "전선", 3, "박교수"],
      ["게임그래픽응용", "전선", 3, "최교수"],
      ["게임엔진응용", "전선", 3, "강교수"],
      ["게임프로젝트응용", "전선", 3, "김교수"],
    ]);
  });
});

describe("parseProfessorIntro", () => {
  it("이름·소속·이메일·전화를 읽는다", () => {
    expect(parseProfessorIntro(read("eclass/intro-view.html"))).toEqual({
      name: "이교수",
      department: "게임콘텐츠과",
      email: "user@example.com",
      phone: "010-0000-0000",
    });
  });
});

describe("parseSyllabus", () => {
  const syllabus = parseSyllabus(read("eclass/plan-view.html"));

  it("연구실과 평가방법을 읽는다", () => {
    expect(syllabus.office).toBe("남관204호");
    expect(syllabus.evaluation).toContain("출석 : 20%");
  });

  it("주차별 계획은 주차당 한 건(15주)이다", () => {
    expect(syllabus.weekly).toHaveLength(15);
    expect(syllabus.weekly[0]).toEqual({ week: 1, date: "09/01", content: "UI화면 설계 프로토타이핑의 개념" });
    expect(syllabus.weekly[14]?.week).toBe(15);
    expect(syllabus.weekly[14]?.date).toBe("12/08");
  });
});

describe("mergeCourseContacts", () => {
  it("교수 연락처를 채우고 원본을 변경하지 않는다", () => {
    const course = parseCurrentCourses(read("grades/SSJ018P-current.html"))[1]!;
    const merged = mergeCourseContacts(
      course,
      parseProfessorIntro(read("eclass/intro-view.html")),
      parseSyllabus(read("eclass/plan-view.html")),
    );
    expect(merged.professor).toEqual({
      name: "이교수",
      department: "게임콘텐츠과",
      email: "user@example.com",
      phone: "010-0000-0000",
      office: "남관204호",
    });
    expect(course.professor).toEqual({ name: "이교수" });
    expect(() => CourseSchema.parse(merged)).not.toThrow();
  });

  it("연락처가 없으면 그대로 반환한다", () => {
    const course = parseCurrentCourses(read("grades/SSJ018P-current.html"))[0]!;
    expect(mergeCourseContacts(course)).toEqual(course);
  });
});
