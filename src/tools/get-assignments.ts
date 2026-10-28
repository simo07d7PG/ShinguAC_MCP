import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AssignmentSchema } from "../schema/index.js";
import type { GetService } from "./index.js";
import { flatten, progressSender, run, SOURCE_NOTE, withMeta } from "./result.js";

export function registerGetAssignments(server: McpServer, getService: GetService): void {
  server.registerTool(
    "get_assignments",
    {
      title: "과제 목록",
      description:
        "이번 주 과제/마감 질문에 사용. 이번 학기 E클래스 과제의 과목·제목·마감·제출 상태를 반환하며, " +
        "due_within_days를 주면 지금부터 N일 안에 마감(연장 기한이 있으면 연장 기한 기준)인 과제만 남긴다. " +
        "로컬 아카이브(sync_eclass가 쓰는 ~/.shingu-mcp/eclass.db)에서 답하며 제출 상태는 마지막 동기화 시점(fetchedAt) 기준이다. " +
        "이번 학기 동기화 기록이 없거나 24시간이 지났으면 먼저 E클래스 과제·게시글을 동기화한다(첨부 파일 제외, 처음엔 1분 안팎, 진행률 알림·취소 지원). " +
        SOURCE_NOTE,
      inputSchema: {
        due_within_days: z
          .number()
          .int()
          .min(0)
          .max(365)
          .optional()
          .describe("지금부터 N일 이내 마감(연장 기한 기준)만 반환. 생략 시 전체. 지정 시 마감일 없는 과제는 제외."),
      },
      outputSchema: withMeta(z.array(AssignmentSchema)),
    },
    ({ due_within_days }, extra) =>
      run(async () =>
        flatten(
          await getService().getAssignments({
            dueWithinDays: due_within_days,
            signal: extra.signal,
            onProgress: progressSender(extra),
          }),
        ),
      ),
  );
}
