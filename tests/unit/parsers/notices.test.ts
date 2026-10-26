import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildCmsUrl,
  parseCmsNoticeDetail,
  parseDashboardNotices,
  parseEclassBoardList,
  parseNoticeId,
} from "../../../src/parsers/notices.js";
import { NoticeDetailSchema, NoticeSummarySchema } from "../../../src/schema/notice.js";

const fx = (p: string): string => readFileSync(new URL(`../../fixtures/${p}`, import.meta.url), "utf8");

describe("parseDashboardNotices", () => {
  const all = parseDashboardNotices(fx("dashboard.html"));
  const univ = all.filter((n) => n.category === "univ");
  const sch = all.filter((n) => n.category === "scholarship");

  it("대학 8건·장학 8건", () => {
    expect(univ).toHaveLength(8);
    expect(sch).toHaveLength(8);
  });

  it("대학공지 첫 항목", () => {
    expect(univ[0]).toEqual({
      id: "univ:17703",
      category: "univ",
      title: expect.stringMatching(/^\[대구한의대학교\] K-MOOC/),
      postedAt: "2026-10-26T00:00:00+09:00",
      url: "https://www.shingu.ac.kr/cms/FR_BBS_CON/BoardView.do?MENU_ID=1400&SITE_NO=2&BOARD_SEQ=4&BBS_SEQ=17703",
    });
    expect(univ[1]?.title).toBe("2026학년도 미래창의경진대회 수상자 안내");
    expect(univ[7]?.id).toBe("univ:17696");
  });

  it("장학공지 첫 항목", () => {
    expect(sch[0]).toMatchObject({
      id: "scholarship:16270",
      title: "[거창군]2026년 2학기 거창군 장학생 선발 공고 안내",
      postedAt: "2026-10-23T00:00:00+09:00",
      url: "https://www.shingu.ac.kr/cms/FR_BBS_CON/BoardView.do?MENU_ID=1410&SITE_NO=2&BOARD_SEQ=5&BBS_SEQ=16270",
    });
    expect(sch[7]?.id).toBe("scholarship:16263");
  });

  it("스키마 통과, url은 https", () => {
    for (const n of all) {
      expect(NoticeSummarySchema.safeParse(n).success).toBe(true);
      expect(n.url.startsWith("https://")).toBe(true);
    }
  });
});

describe("parseEclassBoardList", () => {
  const opts = { lectureSeq: "123", boardId: "1", courseName: "UI화면설계" };

  it("빈 상태 픽스처 -> []", () => {
    expect(parseEclassBoardList(fx("eclass/board-list-notice.html"), opts)).toEqual([]);
  });

  it("행이 있으면 id/url/날짜를 만든다", () => {
    const html = `<table class="table table-list"><tbody>
      <tr data-wr-id="00000000000000000007"><td>7</td><td> 시험 안내 </td><td></td><td>2026-10-20 09:30</td><td>김교수</td><td>3</td></tr>
    </tbody></table>`;
    const [n] = parseEclassBoardList(html, opts);
    expect(n).toEqual({
      id: "eclass:123:1:00000000000000000007",
      category: "eclass",
      title: "시험 안내",
      postedAt: "2026-10-20T09:30:00+09:00",
      url: "/eclass/clas/board/detail?boardId=1&wrId=00000000000000000007",
      courseName: "UI화면설계",
    });
  });
});

describe("parseCmsNoticeDetail", () => {
  const summary = parseDashboardNotices(fx("dashboard.html"))[0]!;
  const html = fx("cms/BoardView.html");

  it("정적 HTML: 첨부 1건, 절대 URL, 본문은 비어 있음", () => {
    const d = parseCmsNoticeDetail(html, summary);
    expect(NoticeDetailSchema.safeParse(d).success).toBe(true);
    expect(d.title).toBe(summary.title);
    expect(d.body).toBe("");
    expect(d.attachments).toEqual([
      {
        name: "[대구한의대학교] 청년 경제 토크콘서트 홍보 포스터.png",
        url: "https://www.shingu.ac.kr/ajaxfile/FR_SVC/FileDown.do?GBN=X01&BOARD_SEQ=4&SITE_NO=2&BBS_SEQ=17703&FILE_SEQ=1",
      },
    ]);
  });

  it("BoardViewData JSON: 제목·본문(줄바꿈 보존, script 제거)", () => {
    const d = parseCmsNoticeDetail(html, summary, {
      SUBJECT: " 새 제목 ",
      CONTENTS: "<p>첫 줄<br>둘째 줄</p><script>alert(1)</script><p>셋째</p>",
    });
    expect(d.title).toBe("새 제목");
    expect(d.body).toBe("첫 줄\n둘째 줄\n셋째");
    const plain = parseCmsNoticeDetail(html, summary, { CONTENTS: "a\nb" });
    expect(plain.body).toBe("a\nb");
  });
});

describe("parseNoticeId / buildCmsUrl", () => {
  it("왕복", () => {
    expect(parseNoticeId("univ:17703")).toEqual({ category: "univ", bbsSeq: "17703" });
    expect(parseNoticeId("scholarship:16270")).toEqual({ category: "scholarship", bbsSeq: "16270" });
    expect(parseNoticeId("eclass:55:1:0000000000000000001")).toEqual({
      category: "eclass",
      lectureSeq: "55",
      boardId: "1",
      wrId: "0000000000000000001",
    });
    expect(() => parseNoticeId("bogus:1")).toThrow();
    expect(() => parseNoticeId("eclass:1:2")).toThrow();
  });

  it("buildCmsUrl은 대시보드 url과 일치", () => {
    const all = parseDashboardNotices(fx("dashboard.html"));
    for (const n of all) {
      const p = parseNoticeId(n.id);
      expect(buildCmsUrl(p.category as "univ" | "scholarship", p.bbsSeq!)).toBe(n.url);
    }
  });
});
