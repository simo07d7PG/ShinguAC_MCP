import * as cheerio from "cheerio";
import { NoticeDetailSchema, NoticeSummarySchema, type NoticeDetail, type NoticeSummary } from "../schema/notice.js";
import { parseKst } from "../util/time.js";
import { ParseError, htmlToText, load, stripComments, text } from "./common.js";

const CMS_ORIGIN = "https://www.shingu.ac.kr";
const CMS_BOARDS = {
  univ: { menuId: 1400, boardSeq: 4 },
  scholarship: { menuId: 1410, boardSeq: 5 },
} as const;
type CmsCategory = keyof typeof CMS_BOARDS;

const DASHBOARD_TABS: ReadonlyArray<{ selector: string; category: CmsCategory }> = [
  { selector: "#noti-3", category: "univ" },
  { selector: "#noti-5", category: "scholarship" },
];

/** CMS `BoardViewData.do` JSON 응답 중 사용하는 필드 (본문·제목은 정적 HTML이 아니라 이 ajax로 채워진다). */
export interface CmsViewData {
  SUBJECT?: string | null;
  CONTENTS?: string | null;
}

export interface ParsedNoticeId {
  category: "univ" | "scholarship" | "eclass";
  bbsSeq?: string;
  lectureSeq?: string;
  boardId?: string;
  wrId?: string;
}

const toHttps = (url: string): string => url.replace(/^http:\/\//i, "https://");

export function buildCmsUrl(category: CmsCategory, bbsSeq: string): string {
  const { menuId, boardSeq } = CMS_BOARDS[category];
  return `${CMS_ORIGIN}/cms/FR_BBS_CON/BoardView.do?MENU_ID=${menuId}&SITE_NO=2&BOARD_SEQ=${boardSeq}&BBS_SEQ=${bbsSeq}`;
}

export function parseNoticeId(id: string): ParsedNoticeId {
  const parts = id.split(":");
  const [category, a, b, c] = parts;
  if ((category === "univ" || category === "scholarship") && parts.length === 2 && a) {
    return { category, bbsSeq: a };
  }
  if (category === "eclass" && parts.length === 4 && a && b && c) {
    return { category, lectureSeq: a, boardId: b, wrId: c };
  }
  throw new Error(`알 수 없는 공지 id 형식: ${id}`);
}

export function parseDashboardNotices(html: string): NoticeSummary[] {
  const $ = load(stripComments(html));
  const out: NoticeSummary[] = [];
  for (const { selector, category } of DASHBOARD_TABS) {
    const pane = $(selector);
    if (pane.length === 0) throw new ParseError("dashboard", selector, "공지 탭");
    pane.find("li a[data-role=noticePopup]").each((_, a) => {
      const $a = $(a);
      const href = $a.attr("href") ?? "";
      const bbsSeq = /[?&]BBS_SEQ=(\d+)/.exec(href)?.[1];
      if (!bbsSeq) return;
      const date = text($a.children("span").first());
      const title = text($a.clone().children("span").remove().end());
      out.push(
        NoticeSummarySchema.parse({
          id: `${category}:${bbsSeq}`,
          category,
          title,
          postedAt: parseKst(date),
          url: toHttps(href),
        }),
      );
    });
  }
  return out;
}

export function parseEclassBoardList(
  html: string,
  opts: { lectureSeq: string; boardId: string; courseName: string },
): NoticeSummary[] {
  const $ = load(stripComments(html));
  const out: NoticeSummary[] = [];
  $("table.table-list tbody tr").each((_, tr) => {
    const $tr = $(tr);
    const wrId = $tr.attr("data-wr-id") ?? /[?&]wrId=(\w+)/.exec($tr.find("a[href*='wrId=']").attr("href") ?? "")?.[1];
    if (!wrId) return; // "데이터가 없습니다." 행 등
    const tds = $tr.children("td");
    // 제목 셀의 "공지" 라벨(span.label)은 제외한다.
    const title = text(tds.eq(1).clone().find("span.label").remove().end());
    // 등록일시 셀은 data-origin-format="YYYYMMDDHHmmss" 14자리 원문
    const dateCell = tds.filter("[data-role=date]").first();
    const date = dateCell.length
      ? parseCompactKst(text(dateCell))
      : (tds.toArray().map((td) => parseKst(text($(td)))).find((d) => d !== null) ?? null);
    out.push(
      NoticeSummarySchema.parse({
        id: `eclass:${opts.lectureSeq}:${opts.boardId}:${wrId}`,
        category: "eclass",
        title,
        postedAt: date,
        url: `/eclass/clas/board/detail?boardId=${opts.boardId}&wrId=${wrId}`,
        courseName: opts.courseName,
      }),
    );
  });
  return out;
}

/** 게시판 목록 하단의 `Total N` / `p / P Page`. 표시가 없으면 한 페이지로 본다. */
export function parseBoardPaging(html: string): { total: number; page: number; pages: number } {
  const t = load(stripComments(html)).text();
  const total = Number(/Total\s*(\d+)/.exec(t)?.[1] ?? 0);
  const m = /(\d+)\s*\/\s*(\d+)\s*Page/.exec(t);
  return { total, page: m ? Number(m[1]) : 1, pages: m ? Math.max(1, Number(m[2])) : 1 };
}

/** `YYYYMMDDHHmmss`(또는 `YYYYMMDDHHmm`, `YYYYMMDD`) 원문을 KST ISO로. */
function parseCompactKst(raw: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?$/.exec(raw.trim());
  if (!m) return parseKst(raw);
  const [, y, mo, d, h = "00", mi = "00", s = "00"] = m;
  return parseKst(`${y}-${mo}-${d} ${h}:${mi}:${s}`);
}

/** E클래스 게시판 글 한 건(수업공지·자료실 공통). */
export interface EclassBoardPost {
  title: string;
  postedAt: string | null;
  author?: string;
  bodyHtml: string;
  body: string;
  attachments: { name: string; url: string }[];
}

/**
 * E클래스 게시판(수업공지·자료실) 본문 화면. `form#detailFrm` 뒤 패널들 중
 * 첫 패널: 제목 `.panel-body h5`(라벨 제외)·`.panel-footer`(등록일시·작성자),
 * 첨부가 있으면 첨부 패널(`a[href*=eClassDown]`)이 끼고, 본문은 `div[style*="min-height"]`.
 */
export function parseEclassBoardPost(html: string): EclassBoardPost {
  const $ = load(stripComments(html));
  const panels = $("form#detailFrm").nextAll(".panel");
  const titleEl = panels.first().find(".panel-body h5").first();
  if (titleEl.length === 0) throw new ParseError("eclass-board-detail", "form#detailFrm ~ .panel .panel-body h5", "제목");
  const title = text(titleEl.clone().find("span.label").remove().end());
  const footer = panels.first().find(".panel-footer").first();
  const dateRaw = text(footer.find("[data-role=date]").first());
  const author = /작성자\s*[|｜]\s*(.+?)\s*(?:조회수|$)/.exec(text(footer))?.[1];
  const bodyEl = panels.find("div[style*='min-height']").first();
  const bodyHtml = (bodyEl.html() ?? "").trim();
  const body = bodyEl.length ? htmlToText($, bodyEl.clone()) : "";
  const attachments: { name: string; url: string }[] = [];
  panels.find("a[href*='eClassDown'], a[href*='Down.jsp'], a[href*='fileDown']").each((_, a) => {
    const name = text($(a));
    const href = $(a).attr("href");
    if (name && href) attachments.push({ name, url: new URL(href, "https://student.shingu.ac.kr").toString() });
  });
  return {
    title,
    postedAt: dateRaw ? parseCompactKst(dateRaw) : null,
    ...(author ? { author } : {}),
    bodyHtml,
    body,
    attachments,
  };
}

/** 공지 본문 응답(get_notice)용: 목록 요약에 본문·첨부를 합친다. */
export function parseEclassBoardDetail(html: string, summary: NoticeSummary): NoticeDetail {
  const post = parseEclassBoardPost(html);
  return NoticeDetailSchema.parse({
    ...summary,
    title: post.title || summary.title,
    postedAt: post.postedAt ?? summary.postedAt,
    body: post.body,
    attachments: post.attachments,
  });
}

/**
 * CMS BoardView 화면에서 공지 상세를 만든다.
 * 첨부는 정적 HTML(`div.fileArea a[data-fileseq]`)에서, 제목·본문은 `BoardViewData.do` JSON(`data`)에서 얻는다.
 * `data`가 없으면 제목은 summary, 본문은 정적 `div.view_txt`(보통 비어 있음)로 대체한다.
 */
export function parseCmsNoticeDetail(html: string, summary: NoticeSummary, data?: CmsViewData): NoticeDetail {
  const $ = load(stripComments(html));
  const attachments: { name: string; url: string }[] = [];
  $("#contents div.fileArea a").each((_, a) => {
    const $a = $(a);
    const name = text($a);
    if (!name) return;
    const d = $a.data() as Record<string, unknown>;
    const href = $a.attr("href") ?? "";
    let url: string;
    if (d["fileseq"] !== undefined) {
      url = `${CMS_ORIGIN}/ajaxfile/FR_SVC/FileDown.do?GBN=X01&BOARD_SEQ=${d["boardseq"]}&SITE_NO=${d["siteno"]}&BBS_SEQ=${d["bbsseq"]}&FILE_SEQ=${d["fileseq"]}`;
    } else if (href && !href.startsWith("#")) {
      url = new URL(href, CMS_ORIGIN).toString();
    } else {
      return;
    }
    attachments.push({ name, url });
  });

  let body: string;
  if (data?.CONTENTS != null) {
    const c = data.CONTENTS;
    const frag = cheerio.load(/<[a-z][\s\S]*>/i.test(c) ? c : c.replace(/\n/g, "<br/>"), null, false);
    body = htmlToText(frag, frag.root());
  } else {
    body = htmlToText($, $("#contents div.view_txt").first());
  }

  return NoticeDetailSchema.parse({
    ...summary,
    title: data?.SUBJECT ? data.SUBJECT.trim() : summary.title,
    body,
    attachments,
  });
}
