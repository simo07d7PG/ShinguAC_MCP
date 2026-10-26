import { GradesSchema } from "../schema/grade.js";
import type { CreditSummary, CurrentCourseGrade, Grades, SemesterGrade } from "../schema/grade.js";
import { load, ParseError, tableRows, text } from "./common.js";

const CREDIT_TYPES = ["교필", "교선", "전필", "전선", "교직", "인접", "교양", "전공"] as const;
const OUT_OF_PERIOD = "출력기간이 아닙니다";

function num(s: string | undefined): number {
  const n = Number((s ?? "").trim());
  return Number.isFinite(n) ? n : 0;
}

function splitParts(s: string): string[] {
  return s.split("/").map((p) => p.trim());
}

/** 학업성적표(SSJ038P) 출력기간 외 빈 상태 페이지인지 판별한다. */
export function isOutOfPeriod(html: string): boolean {
  return html.includes(OUT_OF_PERIOD);
}

/** SSJ018P 현재 학기 수강 과목 성적. 점수·등급이 없으면 null, status에 원문("성적미완료" 등). */
export function parseCurrentCourseGrades(html: string): CurrentCourseGrade[] {
  const $ = load(html);
  if ($("table.table-list").length === 0) throw new ParseError("SSJ018P", "table.table-list");
  const result: CurrentCourseGrade[] = [];
  $("table.table-list tbody tr").each((_, tr) => {
    const tds = $(tr).children("td").toArray();
    if (tds.length < 4) return;
    const [yearSem, courseInfo, scoreCell, gradeCell] = tds.map((td) => $(td));
    const [yy, haggi] = splitParts(text(yearSem!));
    const lines = (courseInfo!.html() ?? "")
      .split(/<br\s*\/?>/i)
      .map((l) => text($(`<div>${l}</div>`)));
    const [courseName, courseCode] = splitParts(lines[0] ?? "");
    const [completionType, credits, professorName] = splitParts(lines[1] ?? "");
    const status = text(scoreCell!);
    const grade = text(gradeCell!);
    result.push({
      year: num(yy),
      semester: haggi ?? "",
      courseName: courseName ?? "",
      ...(courseCode ? { courseCode } : {}),
      ...(completionType ? { completionType } : {}),
      ...(credits ? { credits: num(credits) } : {}),
      ...(professorName ? { professorName } : {}),
      score: /^\d+(\.\d+)?$/.test(status) ? status : null,
      grade: grade || null,
      status,
    });
  });
  return result;
}

/** SSJ019P 학기 탭(`a[data-role=tabSearch]`)의 사용 가능한 학기 목록. */
export function parseAvailableSemesters(html: string): { year: number; semester: string }[] {
  const $ = load(html);
  return $("a[data-role=tabSearch]")
    .toArray()
    .map((a) => ({ year: num($(a).attr("data-yy")), semester: ($(a).attr("data-haggi") ?? "").trim() }))
    .filter((s) => s.year > 0 && s.semester !== "");
}

/** SSJ019P 확정 학기 요약. */
export function parseSemesterGrades(html: string): SemesterGrade[] {
  const $ = load(html);
  if ($("table.table-list").length === 0) throw new ParseError("SSJ019P", "table.table-list");
  return tableRows($, "table.table-list")
    .filter((c) => c.length >= 8)
    .map((c) => ({
      year: num(c[0]),
      semester: c[1]!,
      ...(c[2] ? { gradeLevel: num(c[2]) } : {}),
      appliedCredits: num(c[3]),
      earnedCredits: num(c[4]),
      gpa: num(c[5]),
      avgScore: num(c[6]),
      academicWarning: c[7] === "Y",
    }));
}

/** SSG005P 이수학점. "전체" 행은 `total: true`(year/semester 없음). */
export function parseCreditSummary(html: string): CreditSummary[] {
  const $ = load(html);
  if ($("table.table-list").length === 0) throw new ParseError("SSG005P", "table.table-list");
  return tableRows($, "table.table-list").flatMap((cells) => {
    const isTotal = cells[0] === "전체";
    // 전체 행은 colspan=2라 년도·학기 셀이 하나로 합쳐져 있다.
    const c = isTotal ? ["", "", ...cells.slice(1)] : cells;
    if (c.length < 15) return [];
    const byType = Object.fromEntries(CREDIT_TYPES.map((t, i) => [t, num(c[3 + i])]));
    return [
      {
        ...(isTotal ? { total: true } : { year: num(c[0]), semester: c[1]! }),
        byType,
        earnedCredits: num(c[11]),
        appliedCredits: num(c[12]),
        gpa: num(c[13]),
        avgScore: num(c[14]),
      },
    ];
  });
}

export function buildGrades(parts: {
  current: CurrentCourseGrade[];
  semesters: SemesterGrade[];
  credits: CreditSummary[];
}): Grades {
  return GradesSchema.parse(parts);
}
