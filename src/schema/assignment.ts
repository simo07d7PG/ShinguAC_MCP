import { z } from "zod";

export const AssignmentSchema = z.object({
  lectureSeq: z.string(),
  reportSeq: z.string(),
  courseName: z.string(),
  professorName: z.string().optional(),
  title: z.string(),
  startAt: z.string().nullable(),
  dueAt: z.string().nullable(),
  extendedDueAt: z.string().nullable(),
  submitStatus: z.enum(["submitted", "not_submitted", "not_open", "unknown"]),
  scored: z.boolean().optional(),
  submittedCount: z.number().optional(),
  totalCount: z.number().optional(),
  detailUrl: z.string(),
});
export type Assignment = z.infer<typeof AssignmentSchema>;

/** 과제 상세(본문·첨부 포함). `get_assignment` 응답. */
export const AssignmentDetailSchema = z.object({
  lectureSeq: z.string(),
  reportSeq: z.string(),
  courseName: z.string().optional(),
  title: z.string(),
  startAt: z.string().nullable(),
  dueAt: z.string().nullable(),
  extendedDueAt: z.string().nullable(),
  penaltyNote: z.string().optional(),
  submittedCount: z.number().optional(),
  totalCount: z.number().optional(),
  body: z.string(),
  attachments: z.array(z.object({ name: z.string(), url: z.string() })),
  submitStatus: z.enum(["submitted", "not_submitted", "not_open"]),
  scored: z.boolean(),
  detailUrl: z.string(),
});
export type AssignmentDetail = z.infer<typeof AssignmentDetailSchema>;
