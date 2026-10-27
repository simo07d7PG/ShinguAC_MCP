import { z } from "zod";

/** 첨부 원본 URL(file_key 포함)은 내보내지 않는다. */
const ArchiveAttachmentSchema = z.object({
  name: z.string(),
  localPath: z.string().nullable().describe("로컬 절대 경로. 아직 받지 않았으면 null."),
  downloaded: z.boolean(),
});

const AssignmentItemSchema = z.object({
  lectureSeq: z.string(),
  courseName: z.string(),
  reportSeq: z.string(),
  title: z.string(),
  startAt: z.string().nullable(),
  dueAt: z.string().nullable(),
  extendedDueAt: z.string().nullable(),
  submitStatus: z.string(),
  contentExcerpt: z.string(),
  attachments: z.array(ArchiveAttachmentSchema),
  submission: z
    .object({ title: z.string(), contentExcerpt: z.string(), attachments: z.array(ArchiveAttachmentSchema) })
    .optional(),
});

const PostItemSchema = z.object({
  lectureSeq: z.string(),
  courseName: z.string(),
  board: z.enum(["notice", "material"]),
  wrId: z.string(),
  title: z.string(),
  postedAt: z.string().nullable(),
  author: z.string().nullable(),
  bodyExcerpt: z.string(),
  attachments: z.array(ArchiveAttachmentSchema),
});

export const ArchiveSearchResultSchema = z.object({
  kind: z.enum(["assignments", "posts"]),
  total: z.number().int().describe("limit 적용 전 일치 건수"),
  items: z.array(z.union([AssignmentItemSchema, PostItemSchema])),
  note: z.string().optional(),
});

export type ArchiveSearchResult = z.infer<typeof ArchiveSearchResultSchema>;
