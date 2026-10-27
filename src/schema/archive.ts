import { z } from "zod";

const Counts = z.object({ total: z.number().int(), new: z.number().int(), updated: z.number().int() });

export const SyncSummarySchema = z.object({
  term: z.string(),
  syncedAt: z.string(),
  courses: z.array(
    z.object({
      lectureSeq: z.string(),
      courseName: z.string(),
      assignments: Counts,
      submissions: z.object({ new: z.number().int(), updated: z.number().int() }),
      notices: Counts,
      materials: Counts,
      error: z.string().optional(),
    }),
  ),
  skippedEmptyCourses: z.number().int(),
  files: z.object({
    downloaded: z.number().int(),
    reused: z.number().int(),
    failed: z.number().int(),
    pending: z.number().int(),
  }),
  warnings: z.array(z.string()),
  dbPath: z.string(),
  filesDir: z.string(),
});
