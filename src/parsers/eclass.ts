import { load, stripComments, text } from "./common.js";
import { parseKst } from "../util/time.js";

export interface EclassPost {
  board: string;
  title: string;
  date: string | null;
  href: string;
}

export interface EclassLecture {
  lectureSeq: string;
  courseName: string;
  section?: string;
  professorName: string;
  recentPosts: EclassPost[];
}

/** E클래스 홈(`/eclass/home`)에서 과목 블록을 파싱한다. 빈 상태("E클래스 정보가 없습니다.")는 `[]`. */
export function parseEclassHome(html: string): EclassLecture[] {
  const $ = load(stripComments(html));
  const lectures: EclassLecture[] = [];
  $("div.list-group.eclass").each((_, block) => {
    const head = $(block).find("a.active[data-role=enter][data-lecture-seq]").first();
    const lectureSeq = head.attr("data-lecture-seq")?.trim();
    if (!lectureSeq) return;
    const heading = text(head.find("h4.list-group-item-heading"));
    const m = /^(.*?)\s*\(([^()]*)\)$/.exec(heading);
    const courseName = m ? (m[1] ?? "").trim() : heading;
    const section = m ? (m[2] ?? "").trim() || undefined : undefined;

    const recentPosts: EclassPost[] = [];
    $(block)
      .find("a[data-role=enter]")
      .not(".active")
      .not(".list-none")
      .each((__, a) => {
        const $a = $(a);
        const board = text($a.find(".badge"));
        const date = parseKst(text($a.find(".date")));
        const title = text($a.clone().find(".badge, .date").remove().end());
        recentPosts.push({ board, title, date, href: ($a.attr("href") ?? "").trim() });
      });

    const lecture: EclassLecture = {
      lectureSeq,
      courseName,
      professorName: text(head.find(".list-group-item-text")),
      recentPosts,
    };
    if (section) lecture.section = section;
    lectures.push(lecture);
  });
  return lectures;
}
