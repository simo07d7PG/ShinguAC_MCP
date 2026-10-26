import { z } from "zod";

export const TimetableEntrySchema = z.object({
  day: z.number().int().min(1).max(7),
  period: z.number().int(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  courseName: z.string(),
  professorName: z.string(),
  building: z.string().optional(),
  room: z.string().optional(),
  roomAlias: z.string().optional(),
});
export type TimetableEntry = z.infer<typeof TimetableEntrySchema>;
