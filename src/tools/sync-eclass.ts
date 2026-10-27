import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SyncSummarySchema } from "../schema/index.js";
import type { GetService } from "./index.js";
import { run, SOURCE_NOTE } from "./result.js";

export function registerSyncEclass(server: McpServer, getService: GetService): void {
  server.registerTool(
    "sync_eclass",
    {
      title: "E클래스 아카이브 동기화",
      description:
        "이번 학기 E클래스 강의 중 과제나 게시글이 있는 강의의 과제방·수업공지·자료실을 읽어 로컬 SQLite(~/.shingu-mcp/eclass.db)에 저장하고, " +
        "첨부파일(과제·내 제출·게시글)을 ~/.shingu-mcp/files/ 에 내려받는다. 포털에는 쓰지 않는다. " +
        "기본은 증분: 이미 저장한 게시글과 마감이 지난 과제는 다시 읽지 않는다. 첫 실행은 과목·첨부 수에 따라 수 분 걸릴 수 있다. " +
        "결과는 과목별 신규·갱신 건수와 파일 다운로드 수. " +
        SOURCE_NOTE,
      inputSchema: {
        download_files: z
          .boolean()
          .optional()
          .describe("false면 첨부는 이름·링크만 저장하고 파일은 다음 동기화에서 받는다. 기본 true."),
        full: z.boolean().optional().describe("true면 저장된 게시글·지난 과제까지 모두 다시 읽는다(수정 반영용). 기본 false."),
      },
      outputSchema: SyncSummarySchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ download_files, full }) =>
      run(async () => ({ ...(await getService().syncArchive({ downloadFiles: download_files, full })) })),
  );
}
