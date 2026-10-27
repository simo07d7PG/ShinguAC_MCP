import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CategoryService } from "../service/category-service.js";
import { registerGetAssignment } from "./get-assignment.js";
import { registerGetAssignments } from "./get-assignments.js";
import { registerGetCourses } from "./get-courses.js";
import { registerGetGrades } from "./get-grades.js";
import { registerGetNotice } from "./get-notice.js";
import { registerGetNotices } from "./get-notices.js";
import { registerGetTimetable } from "./get-timetable.js";
import { registerRefreshSnapshots } from "./refresh-snapshots.js";
import { registerSubmitAssignment } from "./submit-assignment.js";

export type ToolService = Pick<
  CategoryService,
  | "getAssignments"
  | "getAssignment"
  | "getTimetable"
  | "getCourses"
  | "getNotices"
  | "getNotice"
  | "getGrades"
  | "refreshAll"
  | "submitAssignment"
>;

/** 도구 호출 시점에 서비스를 얻는다. 설정이 없으면 ConfigError를 던진다. */
export type GetService = () => ToolService;

export function registerAllTools(server: McpServer, getService: GetService): void {
  registerGetAssignments(server, getService);
  registerGetAssignment(server, getService);
  registerGetTimetable(server, getService);
  registerGetCourses(server, getService);
  registerGetNotices(server, getService);
  registerGetNotice(server, getService);
  registerGetGrades(server, getService);
  registerRefreshSnapshots(server, getService);
  registerSubmitAssignment(server, getService);
}
