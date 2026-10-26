import type { SessionManager } from "../auth/session-manager.js";
import { parseTimetablePage } from "../parsers/timetable.js";
import type { TimetableEntry } from "../schema/index.js";
import { PORTAL_ORIGIN } from "./urls.js";
import type { AcademicTerm } from "./semester.js";

/** 개인 시간표(SSE013R) — 1요청. */
export async function fetchTimetable(
  session: SessionManager,
  term: AcademicTerm,
): Promise<{ year: number; semester: string; entries: TimetableEntry[] }> {
  const q = new URLSearchParams({ Yy: String(term.year), Haggi: term.semester });
  const res = await session.request((c) => c.get(`${PORTAL_ORIGIN}/SSE/SSE013R/SSE013R?${q}`));
  return parseTimetablePage(res.text);
}
