import { z } from "zod";

export const CourseSchema = z.object({
  courseName: z.string(),
  courseCode: z.string().optional(),
  section: z.string().optional(),
  year: z.number().int(),
  semester: z.string(),
  completionType: z.string().optional(),
  credits: z.number().optional(),
  professor: z.object({
    name: z.string(),
    department: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
    office: z.string().optional(),
  }),
  lectureSeq: z.string().optional(),
});
export type Course = z.infer<typeof CourseSchema>;
