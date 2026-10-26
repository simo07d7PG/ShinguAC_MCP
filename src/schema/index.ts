import { z } from "zod";
import { AssignmentSchema } from "./assignment.js";
import { CourseSchema } from "./course.js";
import { GradesSchema } from "./grade.js";
import { NoticeSummarySchema } from "./notice.js";
import { TimetableEntrySchema } from "./timetable.js";

export * from "./assignment.js";
export * from "./course.js";
export * from "./grade.js";
export * from "./meta.js";
export * from "./notice.js";
export * from "./timetable.js";

export const CATEGORIES = ["assignments", "timetable", "courses", "notices", "grades"] as const;
export type Category = (typeof CATEGORIES)[number];

/** 범주별 스냅샷 데이터 스키마. */
export const categorySchemas = {
  assignments: z.array(AssignmentSchema),
  timetable: z.array(TimetableEntrySchema),
  courses: z.array(CourseSchema),
  notices: z.array(NoticeSummarySchema),
  grades: GradesSchema,
} as const satisfies Record<Category, z.ZodType>;

export type CategoryData = { [K in Category]: z.infer<(typeof categorySchemas)[K]> };
