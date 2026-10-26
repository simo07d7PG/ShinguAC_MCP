import { describe, expect, it } from "vitest";
import { currentAcademicTerm, parseSemesterArg } from "../../src/portal/semester.js";

describe("currentAcademicTerm (KST)", () => {
  it("1·2월은 전년도 2학기", () => {
    expect(currentAcademicTerm(new Date("2026-02-15T03:00:00+09:00"))).toEqual({ year: 2025, semester: "2" });
    expect(currentAcademicTerm(new Date("2026-01-01T00:00:00+09:00"))).toEqual({ year: 2025, semester: "2" });
  });

  it("3~8월은 1학기, 9~12월은 2학기", () => {
    expect(currentAcademicTerm(new Date("2026-03-01T00:00:00+09:00"))).toEqual({ year: 2026, semester: "1" });
    expect(currentAcademicTerm(new Date("2026-08-31T23:59:00+09:00"))).toEqual({ year: 2026, semester: "1" });
    expect(currentAcademicTerm(new Date("2026-09-01T00:00:00+09:00"))).toEqual({ year: 2026, semester: "2" });
    expect(currentAcademicTerm(new Date("2026-12-31T23:59:00+09:00"))).toEqual({ year: 2026, semester: "2" });
  });

  it("UTC가 아니라 KST 날짜로 판정한다", () => {
    // UTC 2026-08-31 15:00 = KST 2026-09-01 00:00
    expect(currentAcademicTerm(new Date("2026-08-31T15:00:00Z"))).toEqual({ year: 2026, semester: "2" });
    // UTC 2026-02-28 15:00 = KST 2026-03-01 00:00
    expect(currentAcademicTerm(new Date("2026-02-28T15:00:00Z"))).toEqual({ year: 2026, semester: "1" });
  });
});

describe("parseSemesterArg", () => {
  it("YYYY-H 형식을 파싱한다", () => {
    expect(parseSemesterArg("2026-1")).toEqual({ year: 2026, semester: "1" });
    expect(parseSemesterArg(" 2025-2 ")).toEqual({ year: 2025, semester: "2" });
  });

  it("형식이 다르면 에러", () => {
    for (const bad of ["2026", "2026-3", "26-1", "2026/1", ""]) {
      expect(() => parseSemesterArg(bad)).toThrow(/학기 형식/);
    }
  });
});
