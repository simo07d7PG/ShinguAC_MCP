import { CourseSchema, type Course } from "../schema/course.js";
import { ParseError, load, text } from "./common.js";

const SCREEN = "SSJ018P";

export interface ProfessorIntro {
  name?: string;
  department?: string;
  email?: string;
  phone?: string;
}

export interface WeeklyPlan {
  week: number;
  date: string;
  content: string;
  assignment?: string;
}

export interface Syllabus {
  office?: string;
  evaluation?: string;
  weekly: WeeklyPlan[];
}

const orUndef = (s: string | undefined): string | undefined => (s && s.length > 0 ? s : undefined);

/** 성적조회(SSJ018P) 현재 학기 수강 과목 표를 Course[]로 변환한다. */
export function parseCurrentCourses(html: string): Course[] {
  const $ = load(html);
  const table = $("table")
    .filter((_, t) => $(t).find("th").text().includes("과목정보"))
    .first();
  if (table.length === 0) throw new ParseError(SCREEN, "table(th=과목정보)");
  const courses: Course[] = [];
  table.find("tr").each((_, tr) => {
    const tds = $(tr).children("td");
    if (tds.length < 2) return;
    const ys = /(\d{4})\s*\/\s*(\S+)/.exec(text(tds.eq(0)));
    if (!ys) return;
    const [info = "", detail = ""] = (tds.eq(1).html() ?? "")
      .split(/<br\s*\/?>/i)
      .map((frag) => text($(`<div>${frag}</div>`)));
    const [courseName = "", courseCode, section] = info.split("/").map((s) => s.trim());
    const [completionType, credits, professor = ""] = detail.split("/").map((s) => s.trim());
    courses.push(
      CourseSchema.parse({
        courseName,
        courseCode: orUndef(courseCode),
        section: orUndef(section),
        year: Number(ys[1]),
        semester: ys[2],
        completionType: orUndef(completionType),
        credits: credits && Number.isFinite(Number(credits)) ? Number(credits) : undefined,
        professor: { name: professor },
      }),
    );
  });
  return courses;
}

/** E클래스 교수소개 화면의 `ul.my-profile-list`에서 소속/이메일/전화를 읽는다. */
export function parseProfessorIntro(html: string): ProfessorIntro {
  const $ = load(html);
  const out: ProfessorIntro = {};
  const name = orUndef(text($(".my-profile").closest(".panel").children(".panel-heading").first()));
  if (name) out.name = name;
  $(".my-profile-list li").each((_, li) => {
    const label = text($(li).children("strong").first());
    const value = orUndef(text($(li).clone().children("strong").remove().end()));
    if (!value) return;
    if (label === "소속") out.department = value;
    else if (label === "이메일") out.email = value;
    else if (label === "전화번호") out.phone = value;
  });
  return out;
}

/** E클래스 수업계획서에서 연구실·평가방법·주차별 계획을 읽는다. 주차 행은 구분(대면/실시간)별로 중복되므로 주차당 첫 행만 쓴다. */
export function parseSyllabus(html: string): Syllabus {
  const $ = load(html);
  const out: Syllabus = { weekly: [] };
  $("table.table-rwd-info tr").each((_, tr) => {
    const label = text($(tr).children("th").first());
    const td = $(tr).children("td").first();
    if (label === "연구실") {
      const office = orUndef(text(td));
      if (office) out.office = office;
    } else if (label === "평가방법") {
      const evaluation = orUndef(td.text().trim());
      if (evaluation) out.evaluation = evaluation;
    }
  });
  const plan = $("table")
    .filter((_, t) => $(t).find("th").text().includes("수업내용"))
    .first();
  const seen = new Set<number>();
  plan.find("tr").each((_, tr) => {
    const tds = $(tr).children("td");
    if (tds.length < 5) return;
    const week = Number(text(tds.eq(1)));
    if (!Number.isInteger(week) || seen.has(week)) return;
    seen.add(week);
    const assignment = orUndef(text(tds.eq(4)));
    out.weekly.push({
      week,
      date: text(tds.eq(2)),
      content: text(tds.eq(3)),
      ...(assignment ? { assignment } : {}),
    });
  });
  return out;
}

/** 교수소개/수업계획서에서 얻은 연락처를 과목의 professor에 채운다 (값이 있는 필드만). */
export function mergeCourseContacts(course: Course, intro?: ProfessorIntro, syllabus?: Syllabus): Course {
  const professor = { ...course.professor };
  if (intro?.department) professor.department = intro.department;
  if (intro?.email) professor.email = intro.email;
  if (intro?.phone) professor.phone = intro.phone;
  if (syllabus?.office) professor.office = syllabus.office;
  return { ...course, professor };
}
