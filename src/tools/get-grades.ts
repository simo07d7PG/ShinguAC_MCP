import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GradesSchema } from "../schema/index.js";
import type { GetService } from "./index.js";
import { flatten, run, SOURCE_NOTE, STORED_NOTE, withMeta } from "./result.js";

export function registerGetGrades(server: McpServer, getService: GetService): void {
  server.registerTool(
    "get_grades",
    {
      title: "성적",
      description:
        "학기별 성적(평점·이수학점·학사경고), 이수구분별 학점 합계, 이번 학기 과목별 성적을 반환한다. " +
        STORED_NOTE +
        SOURCE_NOTE,
      inputSchema: {
        semester: z
          .string()
          .regex(/^\d{4}-[12]$/)
          .optional()
          .describe("이 학기만 반환. 형식 YYYY-H (예: 2026-1). 생략 시 전체. 전체 이수학점 합계는 항상 포함."),
      },
      outputSchema: withMeta(GradesSchema),
    },
    ({ semester }) => run(async () => flatten(await getService().getGrades({ semester }))),
  );
}
