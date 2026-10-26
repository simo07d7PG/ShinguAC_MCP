import * as cheerio from "cheerio";
import type { Cheerio } from "cheerio";
import type { AnyNode } from "domhandler";

export type $ = cheerio.CheerioAPI;

export class ParseError extends Error {
  constructor(
    public readonly screen: string,
    public readonly selector: string,
    public readonly hint?: string,
  ) {
    super(`[${screen}] 필수 요소를 찾지 못했습니다: ${selector}${hint ? ` (${hint})` : ""}`);
    this.name = "ParseError";
  }
}

export function load(html: string): $ {
  return cheerio.load(html);
}

/** HTML 주석 제거 (포털 HTML에는 주석 처리된 테스트 폼이 있다). */
export function stripComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, "");
}

/** 공백·`&nbsp;` 정규화. */
export function text($el: Cheerio<AnyNode>): string {
  return $el.text().replace(/[ \s]+/g, " ").trim();
}

/** 표의 데이터 행을 셀 텍스트 배열로 반환한다 (td가 없는 th 행은 제외). */
export function tableRows($: $, tableSel: string): string[][] {
  const rows: string[][] = [];
  $(tableSel)
    .find("tr")
    .each((_, tr) => {
      const cells = $(tr).children("td");
      if (cells.length === 0) return;
      rows.push(cells.toArray().map((td) => text($(td))));
    });
  return rows;
}
