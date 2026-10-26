import type { SessionManager } from "../auth/session-manager.js";
import type { HttpClient } from "../http/http-client.js";
import { ParseError, load } from "../parsers/common.js";
import { parseCmsNoticeDetail, parseDashboardNotices, type CmsViewData } from "../parsers/notices.js";
import type { NoticeDetail, NoticeSummary } from "../schema/index.js";
import { parseKst } from "../util/time.js";
import { CMS_ORIGIN, PORTAL_ORIGIN } from "./urls.js";

const BOARD_VIEW_DATA = `${CMS_ORIGIN}/ajaxf/FR_BBS_SVC/BoardViewData.do`;

/** 대시보드의 대학/장학 공지 — 1요청. */
export async function fetchDashboardNotices(session: SessionManager): Promise<NoticeSummary[]> {
  const res = await session.request((c) => c.get(`${PORTAL_ORIGIN}/dashboard/dashboard`));
  return parseDashboardNotices(res.text);
}

/**
 * 공개 CMS 공지 본문 — 로그인 불필요, 2요청.
 * ① 페이지 GET(세션 쿠키·`#sendForm` hidden 값) ② 같은 jar로 `BoardViewData.do` POST(제목·본문 JSON).
 */
export async function fetchCmsNoticeDetail(client: HttpClient, summary: NoticeSummary): Promise<NoticeDetail> {
  const pageUrl = summary.url.replace(/^http:\/\//i, "https://");
  const page = await client.get(pageUrl);

  const $ = load(page.text);
  const fields: Record<string, string> = {};
  $("#sendForm input[name]").each((_, el) => {
    fields[$(el).attr("name")!] = $(el).attr("value") ?? "";
  });
  if (!fields["BBS_SEQ"]) throw new ParseError("cms-board-view", "#sendForm input[name=BBS_SEQ]");
  fields["CONTENTS_NO"] = "1";

  const res = await client.postForm(BOARD_VIEW_DATA, fields, {
    headers: { "X-Requested-With": "XMLHttpRequest", Referer: pageUrl },
  });
  let json: { data?: unknown };
  try {
    json = JSON.parse(res.text) as { data?: unknown };
  } catch {
    throw new ParseError("cms-board-view-data", "JSON", "응답이 JSON이 아님");
  }
  const data = json.data && typeof json.data === "object" ? (json.data as CmsViewData & { WRITE_DT?: string }) : undefined;
  const postedAt = summary.postedAt ?? parseKst(data?.WRITE_DT ?? null);
  return parseCmsNoticeDetail(page.text, { ...summary, url: pageUrl, postedAt }, data);
}
