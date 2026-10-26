import type { SessionManager } from "../auth/session-manager.js";
import { buildGrades, parseCreditSummary, parseCurrentCourseGrades, parseSemesterGrades } from "../parsers/grades.js";
import type { Grades } from "../schema/index.js";
import { PORTAL_ORIGIN } from "./urls.js";

/** 성적: SSJ018P(현재 학기) + SSJ019P(확정 학기 요약) + SSG005P(이수학점) — 3요청. */
export async function fetchGrades(session: SessionManager): Promise<Grades> {
  const get = (path: string) => session.request((c) => c.get(`${PORTAL_ORIGIN}${path}`));
  const current = await get("/SSJ/SSJ018P/SSJ018P");
  const confirmed = await get("/SSJ/SSJ019P/SSJ019P");
  const credits = await get("/SSG/SSG005P/SSG005P");
  return buildGrades({
    current: parseCurrentCourseGrades(current.text),
    semesters: parseSemesterGrades(confirmed.text),
    credits: parseCreditSummary(credits.text),
  });
}
