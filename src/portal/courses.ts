import type { SessionManager } from "../auth/session-manager.js";
import { parseCurrentCourses } from "../parsers/courses.js";
import type { Course } from "../schema/index.js";
import { PORTAL_ORIGIN } from "./urls.js";

/** 현재 학기 수강 과목(SSJ018P) — 1요청. */
export async function fetchCurrentCourses(session: SessionManager): Promise<Course[]> {
  const res = await session.request((c) => c.get(`${PORTAL_ORIGIN}/SSJ/SSJ018P/SSJ018P`));
  return parseCurrentCourses(res.text);
}
