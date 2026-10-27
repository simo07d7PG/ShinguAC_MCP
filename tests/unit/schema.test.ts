import { describe, expect, it } from "vitest";
import { AssignmentSchema, GradesSchema, MetaSchema } from "../../src/schema/index.js";

const valid = {
  lectureSeq: "1",
  reportSeq: "2",
  courseName: "UI화면설계",
  title: "과제1",
  startAt: null,
  dueAt: "2026-10-30T23:59:00+09:00",
  extendedDueAt: null,
  submitStatus: "not_submitted",
  detailUrl: "/eclass/clas/room/homework/homeworkDetail?reportSeq=2",
};

describe("schema", () => {
  it("Assignment parse succeeds", () => {
    expect(AssignmentSchema.parse(valid).submitStatus).toBe("not_submitted");
  });
  it("Assignment rejects bad status", () => {
    expect(AssignmentSchema.safeParse({ ...valid, submitStatus: "late" }).success).toBe(false);
  });
  it("Meta requires fetchedAt", () => {
    expect(MetaSchema.safeParse({}).success).toBe(false);
  });
  it("Grades accepts empty", () => {
    expect(GradesSchema.safeParse({ semesters: [], credits: [], current: [] }).success).toBe(true);
  });
});
