import { z } from "zod";

export const NoticeSummarySchema = z.object({
  id: z.string(),
  category: z.enum(["univ", "scholarship", "eclass"]),
  title: z.string(),
  postedAt: z.string().nullable(),
  url: z.string(),
  courseName: z.string().optional(),
});
export type NoticeSummary = z.infer<typeof NoticeSummarySchema>;

export const NoticeDetailSchema = NoticeSummarySchema.extend({
  body: z.string(),
  attachments: z.array(z.object({ name: z.string(), url: z.string() })),
});
export type NoticeDetail = z.infer<typeof NoticeDetailSchema>;
