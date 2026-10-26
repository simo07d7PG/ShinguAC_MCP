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
