import { describe, expect, it } from "vitest";
import { AssignmentSchema, MetaSchema, categorySchemas } from "../../src/schema/index.js";

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
  it("Meta rejects bad source", () => {
    expect(MetaSchema.safeParse({ fetchedAt: "x", stale: false, source: "cache" }).success).toBe(false);
  });
  it("categorySchemas.grades accepts empty", () => {
    expect(categorySchemas.grades.safeParse({ semesters: [], credits: [], current: [] }).success).toBe(true);
  });
});
