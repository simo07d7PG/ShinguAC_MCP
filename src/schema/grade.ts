import { z } from "zod";

export const SemesterGradeSchema = z.object({
  year: z.number().int(),
  semester: z.string(),
  gradeLevel: z.number().optional(),
  appliedCredits: z.number(),
  earnedCredits: z.number(),
  gpa: z.number(),
  avgScore: z.number(),
  academicWarning: z.boolean(),
});
export type SemesterGrade = z.infer<typeof SemesterGradeSchema>;

export const CreditSummarySchema = z.object({
  year: z.number().int().optional(),
  semester: z.string().optional(),
  total: z.boolean().optional(),
  byType: z.record(z.string(), z.number()),
  earnedCredits: z.number(),
  appliedCredits: z.number(),
  gpa: z.number().optional(),
  avgScore: z.number().optional(),
});
export type CreditSummary = z.infer<typeof CreditSummarySchema>;

export const CurrentCourseGradeSchema = z.object({
  year: z.number().int(),
  semester: z.string(),
  courseName: z.string(),
  courseCode: z.string().optional(),
  completionType: z.string().optional(),
  credits: z.number().optional(),
  professorName: z.string().optional(),
  score: z.string().nullable(),
  grade: z.string().nullable(),
  status: z.string(),
});
export type CurrentCourseGrade = z.infer<typeof CurrentCourseGradeSchema>;

export const GradesSchema = z.object({
  semesters: z.array(SemesterGradeSchema),
  credits: z.array(CreditSummarySchema),
  current: z.array(CurrentCourseGradeSchema),
});
export type Grades = z.infer<typeof GradesSchema>;
