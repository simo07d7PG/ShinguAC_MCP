import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CourseSchema } from "../schema/index.js";
import type { GetService } from "./index.js";
import { flatten, run, SOURCE_NOTE, withMeta } from "./result.js";

export function registerGetCourses(server: McpServer, getService: GetService): void {
  server.registerTool(
    "get_courses",
    {
      title: "수강 과목",
      description:
        "이번 학기 수강 과목과 담당 교수 이름을 반환한다. " +
        "교수 연락처(이메일·전화·연구실)가 필요하면 include_contacts: true — 과목당 약 7초 추가. " +
        SOURCE_NOTE,
      inputSchema: {
        include_contacts: z
          .boolean()
          .default(false)
          .describe("교수 연락처(E클래스 교수소개·수업계획서)까지 수집할지. 기본 false. true면 과목당 약 7초 추가."),
      },
      outputSchema: withMeta(z.array(CourseSchema)),
    },
    ({ include_contacts }) =>
      run(async () => flatten(await getService().getCourses({ includeContacts: include_contacts }))),
  );
}
