import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { NoticeDetailSchema } from "../schema/index.js";
import type { GetService } from "./index.js";
import { flatten, run, SOURCE_NOTE, withMeta } from "./result.js";

export function registerGetNotice(server: McpServer, getService: GetService): void {
  server.registerTool(
    "get_notice",
    {
      title: "공지 본문",
      description: "get_notices가 반환한 id로 공지 한 건의 본문과 첨부파일 목록을 반환한다. " + SOURCE_NOTE,
      inputSchema: {
        id: z.string().min(1).describe("get_notices 결과의 id 값 그대로."),
      },
      outputSchema: withMeta(NoticeDetailSchema),
    },
    ({ id }) => run(async () => flatten(await getService().getNotice(id))),
  );
}
