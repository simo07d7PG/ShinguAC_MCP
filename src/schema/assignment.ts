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

/** `submit_assignment` 응답. confirm_token 없이 호출하면 `submitted: false`인 미리보기다. */
export const SubmitResultSchema = z.object({
  submitted: z.boolean(),
  /** 신규 제출(register) 또는 다시 제출(resubmit). */
  mode: z.enum(["register", "resubmit"]),
  lectureSeq: z.string(),
  reportSeq: z.string(),
  courseName: z.string().optional(),
  assignmentTitle: z.string(),
  dueAt: z.string().nullable(),
  extendedDueAt: z.string().nullable(),
  /** 지금이 연장 기간이면 true(감점 안내 확인 필요). */
  inExtension: z.boolean(),
  penaltyNote: z.string().optional(),
  title: z.string(),
  contentLength: z.number(),
  /** 새로 올릴 첨부. */
  file: z.object({ name: z.string(), path: z.string(), size: z.number() }).optional(),
  /** 다시 제출 시 기존 첨부를 그대로 두는지. */
  keepsExistingAttachment: z.boolean(),
  /** 지금 제출돼 있는 첨부 파일 이름(다시 제출일 때). */
  existingAttachments: z.array(z.string()),
  /** 미리보기에서만: 승인 후 제출할 때 그대로 넘기는 토큰(10분 유효, 입력·포털 상태에 묶임). */
  confirmToken: z.string().optional(),
  /** 제출 후 포털을 다시 읽어 반영을 확인했는지(미리보기면 false). */
  verified: z.boolean(),
  warnings: z.array(z.string()),
  message: z.string(),
});
export type SubmitResult = z.infer<typeof SubmitResultSchema>;
