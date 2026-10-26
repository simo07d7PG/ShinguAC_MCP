import type { Cheerio } from "cheerio";
import type { AnyNode } from "domhandler";
import { AssignmentSchema, type Assignment } from "../schema/assignment.js";
import { parseKst } from "../util/time.js";
import { ParseError, load, stripComments, text } from "./common.js";
import type { EclassLecture } from "./eclass.js";

export interface HomeworkRow {
  reportSeq: string;
  title: string;
  startAt: string | null;
  dueAt: string | null;
  extendedDueAt: string | null;
  submittedCount: number | null;
  totalCount: number | null;
}

export type SubmitStatus = "submitted" | "not_submitted" | "not_open";

export interface HomeworkDetail {
  reportSeq?: string;
  title: string;
  startAt: string | null;
  dueAt: string | null;
  extendedDueAt: string | null;
  penaltyNote?: string;
  submittedCount: number | null;
  totalCount: number | null;
  body: string;
  attachments: { name: string; url: string }[];
  submitStatus: SubmitStatus;
  scored: boolean;
}

/** `N명 / M명` (nbsp 포함 가능) -> [N, M]. */
function counts(s: string): [number | null, number | null] {
  const m = /(\d+)\s*명\s*\/\s*(\d+)\s*명/.exec(s);
  return m ? [Number(m[1]), Number(m[2])] : [null, null];
}

/** 과제방 목록(`homeworkList`)을 파싱한다. 표가 없으면 ParseError, 데이터 없음 행이면 `[]`. */
export function parseHomeworkList(html: string): HomeworkRow[] {
  const $ = load(stripComments(html));
  const table = $("table.table-list.table-center").first();
  if (table.length === 0) throw new ParseError("homework-list", "table.table-list.table-center");
  const rows: HomeworkRow[] = [];
  table.find("tr[data-wr-id]").each((_, tr) => {
    const $tr = $(tr);
    const tds = $tr.children("td");
    const spans = (i: number): (string | null)[] =>
      tds
        .eq(i)
        .find("span[data-role=date]")
        .toArray()
        .map((s) => parseKst(text($(s))));
    const [startAt = null, dueAt = null] = spans(1);
    const [extendedDueAt = null] = spans(2);
    const [submittedCount, totalCount] = counts(text(tds.eq(3)));
    rows.push({
      reportSeq: ($tr.attr("data-wr-id") ?? "").trim(),
      title: text(tds.eq(0)),
      startAt,
      dueAt,
      extendedDueAt,
      submittedCount,
      totalCount,
    });
  });
  if (rows.length === 0 && !/데이터가 없습니다/.test(table.text())) {
    throw new ParseError("homework-list", "tr[data-wr-id]", "행도 '데이터가 없습니다' 안내도 없음");
  }
  return rows;
}

/** 과제 상세(`homeworkDetail`)를 파싱한다. 제출 상태는 하단 버튼으로 판정한다. */
export function parseHomeworkDetail(html: string): HomeworkDetail {
  const $ = load(stripComments(html));
  const table = $("table.table-rwd-info").first();
  if (table.length === 0) throw new ParseError("homework-detail", "table.table-rwd-info");

  const cell = (label: string): Cheerio<AnyNode> => {
    const th = table.find("th").filter((_, el) => text($(el)) === label).first();
    return th.closest("tr").children("td").first();
  };
  const title = text(cell("과제명"));
  if (!title) throw new ParseError("homework-detail", "th=과제명 + td");

  const due = cell("제출기한")
    .find("span[data-role=date]")
    .toArray()
    .map((s) => parseKst(text($(s))));
  const ext = cell("연장기한")
    .find("span[data-role=date]")
    .toArray()
    .map((s) => parseKst(text($(s))));
  const [submittedCount, totalCount] = counts(text(cell("제출현황")));
  const penalty = text(cell("연장감점여부"));

  const attachments: { name: string; url: string }[] = [];
  cell("첨부파일")
    .find("a[href]")
    .each((_, a) => {
      const url = ($(a).attr("href") ?? "").trim();
      const name = text($(a).find("span")) || text($(a));
      if (url) attachments.push({ name, url });
    });

  const resubmit = $("button[data-role=resubmitBtn]").first();
  let submitStatus: SubmitStatus = "not_open";
  let scored = false;
  if ($('button[data-target="#registerModal"]').length > 0) {
    submitStatus = "not_submitted";
  } else if (resubmit.length > 0) {
    submitStatus = "submitted";
    scored = (resubmit.attr("data-score") ?? "").trim() !== "";
  }

  const reportSeq = ($("input[name=reportSeq]").first().attr("value") ?? "").trim();
  const detail: HomeworkDetail = {
    title,
    startAt: due[0] ?? null,
    dueAt: due[1] ?? null,
    extendedDueAt: ext[0] ?? null,
    submittedCount,
    totalCount,
    body: text(cell("과제내용")),
    attachments,
    submitStatus,
    scored,
  };
  if (reportSeq) detail.reportSeq = reportSeq;
  if (penalty) detail.penaltyNote = penalty;
  return detail;
}

/** 목록 행 + (선택) 상세를 합쳐 스키마를 통과하는 Assignment 목록을 만든다. */
export function buildAssignments(
  lecture: EclassLecture,
  rows: HomeworkRow[],
  details?: Map<string, HomeworkDetail>,
): Assignment[] {
  return rows.map((row) => {
    const detail = details?.get(row.reportSeq);
    const a: Assignment = {
      lectureSeq: lecture.lectureSeq,
      reportSeq: row.reportSeq,
      courseName: lecture.courseName,
      professorName: lecture.professorName || undefined,
      title: row.title,
      startAt: row.startAt,
      dueAt: row.dueAt,
      extendedDueAt: row.extendedDueAt,
      submitStatus: detail ? detail.submitStatus : "unknown",
      submittedCount: row.submittedCount ?? undefined,
      totalCount: row.totalCount ?? undefined,
      detailUrl: `/eclass/clas/room/homework/homeworkDetail?reportSeq=${row.reportSeq}`,
    };
    if (detail) a.scored = detail.scored;
    return AssignmentSchema.parse(a);
  });
}
