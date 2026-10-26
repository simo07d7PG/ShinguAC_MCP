import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { NoticeSummarySchema } from "../schema/index.js";
import type { GetService } from "./index.js";
import { flatten, run, SOURCE_NOTE, withMeta } from "./result.js";

export function registerGetNotices(server: McpServer, getService: GetService): void {
  server.registerTool(
    "get_notices",
    {
      title: "공지 목록",
      description:
        "학교 공지(univ)·장학 공지(scholarship)와 선택적으로 E클래스 수업공지(eclass) 목록을 최신순으로 반환한다. " +
        "본문은 get_notice(id)로 조회한다. " +
        SOURCE_NOTE,
      inputSchema: {
        category: z
          .enum(["univ", "scholarship", "eclass"])
          .optional()
          .describe("이 분류만 반환. eclass를 지정하면 include_eclass가 자동으로 켜진다."),
        limit: z.number().int().min(1).max(100).default(20).describe("최대 개수(1~100, 기본 20)."),
        include_eclass: z
          .boolean()
          .default(false)
          .describe("E클래스 수업공지 포함 여부. 켜면 과목당 포털 요청이 2회 늘어난다."),
      },
      outputSchema: withMeta(z.array(NoticeSummarySchema)),
    },
    ({ category, limit, include_eclass }) =>
      run(async () =>
        flatten(
          await getService().getNotices({ category, limit, includeEclass: include_eclass || category === "eclass" }),
        ),
      ),
  );
}
