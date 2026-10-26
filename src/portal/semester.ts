import { kstDateString } from "../util/time.js";

export interface AcademicTerm {
  year: number;
  semester: "1" | "2";
}

/** KST 기준 현재 학년도/학기. 3~8월 → 1학기, 9~12월 → 2학기, 1·2월 → 전년도 2학기. */
export function currentAcademicTerm(now: Date = new Date()): AcademicTerm {
  const [y, m] = kstDateString(now).split("-").map(Number) as [number, number];
  if (m >= 3 && m <= 8) return { year: y, semester: "1" };
  return { year: m <= 2 ? y - 1 : y, semester: "2" };
}

/** `YYYY-H` (예 `2026-1`) 학기 인자를 파싱한다. 형식이 다르면 Error. */
export function parseSemesterArg(arg: string): AcademicTerm {
  const m = /^(\d{4})-([12])$/.exec(arg.trim());
  if (!m) throw new Error(`학기 형식이 올바르지 않습니다(예: 2026-1): ${arg}`);
  return { year: Number(m[1]), semester: m[2] as "1" | "2" };
}
