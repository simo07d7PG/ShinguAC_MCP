import { z } from "zod";

/** 저장본 하나의 갱신 결과: 건수 + new/updated/same, 또는 실패. */
const refresh = (shape: z.ZodRawShape) =>
  z.union([
    z.object({ ...shape, status: z.enum(["new", "updated", "same"]) }),
    z.object({ status: z.literal("failed"), error: z.string() }),
  ]);

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
  /** 이번 학기 시간표 갱신 결과. */
  timetable: refresh({ entries: z.number().int() }).optional(),
  /** 이번 학기 수강 과목(교수 연락처 포함) 갱신 결과. */
  enrolledCourses: refresh({ entries: z.number().int() }).optional(),
  /** 성적 갱신 결과(semesters: 학기별 성적 행 수). */
  grades: refresh({ semesters: z.number().int() }).optional(),
  /** 도중에 취소됐으면 true. 그때까지 저장한 것은 남는다. */
  cancelled: z.boolean().optional(),
});
