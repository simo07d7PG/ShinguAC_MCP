import type { SessionManager } from "../auth/session-manager.js";
import { parseHomeworkDetail, parseHomeworkList, type HomeworkDetail, type HomeworkRow } from "../parsers/assignments.js";
import { parseProfessorIntro, parseSyllabus, type ProfessorIntro, type Syllabus } from "../parsers/courses.js";
import { parseEclassHome, type EclassLecture } from "../parsers/eclass.js";
import { parseEclassBoardDetail, parseEclassBoardList } from "../parsers/notices.js";
import type { NoticeDetail, NoticeSummary } from "../schema/index.js";
import type { AcademicTerm } from "./semester.js";
import { PORTAL_ORIGIN } from "./urls.js";

const CLAS = `${PORTAL_ORIGIN}/eclass/clas`;

/** E클래스 홈 — 1요청. 학년도/학기를 생략하면 포털이 다음 학년도로 잡으므로 항상 명시한다. */
export async function fetchEclassHome(session: SessionManager, term: AcademicTerm): Promise<EclassLecture[]> {
  const q = new URLSearchParams({ lectureYear: String(term.year), lectureTerm: term.semester });
  const res = await session.request((c) => c.get(`${PORTAL_ORIGIN}/eclass/home?${q}`));
  return parseEclassHome(res.text);
}

/** 강의실 진입 — 1요청. 이후 `/eclass/clas/...` 요청은 이 강의 기준이다. */
export async function enterLecture(session: SessionManager, lectureSeq: string): Promise<void> {
  await session.request((c) => c.postForm(`${CLAS}/home`, { lectureSeq, redirect: "" }));
}

export async function fetchHomeworkList(session: SessionManager): Promise<HomeworkRow[]> {
  const res = await session.request((c) => c.get(`${CLAS}/room/homework/homeworkList`));
  return parseHomeworkList(res.text);
}

export async function fetchHomeworkDetail(session: SessionManager, reportSeq: string): Promise<HomeworkDetail> {
  const q = new URLSearchParams({ reportSeq });
  const res = await session.request((c) => c.get(`${CLAS}/room/homework/homeworkDetail?${q}`));
  return parseHomeworkDetail(res.text);
}

export async function fetchProfessorIntro(session: SessionManager): Promise<ProfessorIntro> {
  const res = await session.request((c) => c.get(`${CLAS}/info/intro/introView`));
  return parseProfessorIntro(res.text);
}

export async function fetchSyllabus(session: SessionManager): Promise<Syllabus> {
  const res = await session.request((c) => c.get(`${CLAS}/info/plan/planView`));
  return parseSyllabus(res.text);
}

export async function fetchEclassBoardList(
  session: SessionManager,
  boardId: string,
  lecture: Pick<EclassLecture, "lectureSeq" | "courseName">,
): Promise<NoticeSummary[]> {
  const q = new URLSearchParams({ boardId });
  const res = await session.request((c) => c.get(`${CLAS}/board/list?${q}`));
  return parseEclassBoardList(res.text, { lectureSeq: lecture.lectureSeq, boardId, courseName: lecture.courseName });
}

/** 게시판 본문 — 1요청. `enterLecture`로 해당 강의에 들어간 뒤 호출한다. */
export async function fetchEclassBoardDetail(
  session: SessionManager,
  boardId: string,
  wrId: string,
  summary: NoticeSummary,
): Promise<NoticeDetail> {
  const q = new URLSearchParams({ boardId, wrId });
  const res = await session.request((c) => c.get(`${CLAS}/board/detail?${q}`));
  return parseEclassBoardDetail(res.text, summary);
}
