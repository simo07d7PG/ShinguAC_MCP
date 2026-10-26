import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CATEGORIES } from "../schema/index.js";
import { nowKst } from "../util/time.js";
import type { GetService } from "./index.js";
import { run, SOURCE_NOTE } from "./result.js";

export function registerRefreshSnapshots(server: McpServer, getService: GetService): void {
  server.registerTool(
    "refresh_snapshots",
    {
      title: "스냅샷 갱신",
      description:
        "과제·시간표·수강과목·공지·성적을 순차로 다시 수집해 로컬 스냅샷을 갱신하고 범주별 성공 여부를 반환한다. " +
        "포털 요청이 많으므로 사용자가 갱신을 요청할 때만 사용. " +
        SOURCE_NOTE,
      inputSchema: {},
      outputSchema: z.object({
        results: z.array(
          z.object({
            category: z.enum(CATEGORIES),
            ok: z.boolean(),
            fetchedAt: z.string().optional(),
            error: z.string().optional(),
          }),
        ),
        fetchedAt: z.string(),
      }),
    },
    () => run(async () => ({ results: await getService().refreshAll(), fetchedAt: nowKst() })),
  );
}
