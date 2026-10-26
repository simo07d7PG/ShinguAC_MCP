import type { Category, CategoryData } from "../schema/index.js";

const DAYS = ["", "월", "화", "수", "목", "금", "토", "일"];

const cell = (v: unknown): string =>
  v === undefined || v === null || v === "" ? "-" : String(v).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

function table(headers: string[], rows: unknown[][]): string {
  if (rows.length === 0) return "(데이터 없음)";
  const lines = [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`];
  for (const r of rows) lines.push(`| ${r.map(cell).join(" | ")} |`);
  return lines.join("\n");
}

const STATUS_LABEL: Record<string, string> = {
  submitted: "제출",
  not_submitted: "미제출",
  not_open: "미오픈",
  unknown: "알 수 없음",
};

type Rendered = { title: string; body: string };

const renderers: { [K in Category]: (data: CategoryData[K]) => Rendered } = {
  assignments: (data) => ({
    title: "과제",
    body: table(
      ["과목", "제목", "시작", "마감", "연장 마감", "제출 상태"],
      data.map((a) => [a.courseName, a.title, a.startAt, a.dueAt, a.extendedDueAt, STATUS_LABEL[a.submitStatus]]),
    ),
  }),
  timetable: (data) => ({
    title: "시간표",
    body: table(
      ["요일", "교시", "시작", "종료", "과목", "교수", "강의실"],
      data.map((t) => [
        DAYS[t.day],
        t.period,
        t.startTime,
        t.endTime,
        t.courseName,
        t.professorName,
        [t.building, t.room].filter(Boolean).join(" ") || t.roomAlias,
      ]),
    ),
  }),
  courses: (data) => ({
    title: "수강 과목",
    body: table(
      ["학기", "과목", "코드", "분반", "이수구분", "학점", "교수", "연구실", "연락처", "이메일"],
      data.map((c) => [
        `${c.year}-${c.semester}`,
        c.courseName,
        c.courseCode,
        c.section,
        c.completionType,
        c.credits,
        c.professor.name,
        c.professor.office,
        c.professor.phone,
        c.professor.email,
      ]),
    ),
  }),
  notices: (data) => ({
    title: "공지사항",
    body: table(
      ["분류", "게시일", "제목", "과목", "ID"],
      data.map((n) => [n.category, n.postedAt, n.title, n.courseName, n.id]),
    ),
  }),
  grades: (data) => ({
    title: "성적",
    body: [
      "## 학기별 성적",
      table(
        ["학기", "학년", "신청학점", "취득학점", "평점평균", "평균점수", "학사경고"],
        data.semesters.map((s) => [
          `${s.year}-${s.semester}`,
          s.gradeLevel,
          s.appliedCredits,
          s.earnedCredits,
          s.gpa,
          s.avgScore,
          s.academicWarning ? "예" : "아니오",
        ]),
      ),
      "## 이수 학점",
      table(
        ["구분", "신청", "취득", "평점", "평균점수", "유형별"],
        data.credits.map((c) => [
          c.total ? "전체" : `${c.year ?? ""}-${c.semester ?? ""}`,
          c.appliedCredits,
          c.earnedCredits,
          c.gpa,
          c.avgScore,
          Object.entries(c.byType)
            .map(([k, v]) => `${k} ${v}`)
            .join(", "),
        ]),
      ),
      "## 현재 학기 수강 과목",
      table(
        ["학기", "과목", "이수구분", "학점", "교수", "점수", "등급", "상태"],
        data.current.map((g) => [
          `${g.year}-${g.semester}`,
          g.courseName,
          g.completionType,
          g.credits,
          g.professorName,
          g.score,
          g.grade,
          g.status,
        ]),
      ),
    ].join("\n\n"),
  }),
};

export function renderMarkdown<K extends Category>(category: K, data: CategoryData[K], fetchedAt: string): string {
  const { title, body } = (renderers[category] as (d: CategoryData[K]) => Rendered)(data);
  return `# ${title}\n\n- 가져온 시각: ${fetchedAt}\n\n${body}\n`;
}
