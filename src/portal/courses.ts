import type { SessionManager } from "../auth/session-manager.js";
import { ParseError } from "../parsers/common.js";
import { mergeCourseContacts, parseCurrentCourses } from "../parsers/courses.js";
import type { Course } from "../schema/index.js";
import { enterLecture, fetchEclassHome, fetchProfessorIntro, fetchSyllabus } from "./eclass.js";
import type { AcademicTerm } from "./semester.js";
import { PORTAL_ORIGIN } from "./urls.js";

/** 현재 학기 수강 과목(SSJ018P) — 1요청. */
export async function fetchCurrentCourses(session: SessionManager): Promise<Course[]> {
  const res = await session.request((c) => c.get(`${PORTAL_ORIGIN}/SSJ/SSJ018P/SSJ018P`));
  return parseCurrentCourses(res.text);
}

/**
 * 수강 과목 + E클래스 lectureSeq: 1(SSJ018P) + 1(E클래스 홈) [+ 매칭 과목당 3(진입·교수소개·수업계획서) — includeContacts].
 * 강의 진입을 하므로 호출하는 쪽이 eclassLock 안에서 부른다.
 * 연락처 화면 파싱 실패(ParseError)는 그 과목만 연락처 없이 두고 onContactError로 알린다.
 */
export async function fetchCoursesWithLectures(
  session: SessionManager,
  term: AcademicTerm,
  opts: { includeContacts: boolean; onContactError: (course: Course, err: ParseError) => void },
): Promise<Course[]> {
  const courses = await fetchCurrentCourses(session);
  const lectures = await fetchEclassHome(session, term);
  const out: Course[] = [];
  for (const course of courses) {
    const lecture =
      lectures.find((l) => l.courseName === course.courseName && l.section === course.section) ??
      lectures.find((l) => l.courseName === course.courseName);
    if (!lecture) {
      out.push(course);
      continue;
    }
    let merged: Course = { ...course, lectureSeq: lecture.lectureSeq };
    if (opts.includeContacts) {
      await enterLecture(session, lecture.lectureSeq);
      try {
        const intro = await fetchProfessorIntro(session);
        const syllabus = await fetchSyllabus(session);
        merged = mergeCourseContacts(merged, intro, syllabus);
      } catch (err) {
        // 연락처는 선택 필드라 한 과목 화면의 파싱 실패로 전체를 실패시키지 않는다.
        if (!(err instanceof ParseError)) throw err;
        opts.onContactError(course, err);
      }
    }
    out.push(merged);
  }
  return out;
}
