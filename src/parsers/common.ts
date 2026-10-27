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

const BLOCK_TAGS = "p,div,li,tr,h1,h2,h3,h4,h5,h6,ul,ol,table";

/** HTML 조각을 줄바꿈을 보존한 일반 텍스트로 바꾼다 (script/style 제거). `$root`를 고치므로 필요하면 clone을 넘긴다. */
export function htmlToText($: $, $root: Cheerio<AnyNode>): string {
  $root.find("script,style").remove();
  $root.find("br").replaceWith("\n");
  $root.find(BLOCK_TAGS).each((_, el) => {
    $(el).append("\n");
  });
  return $root
    .text()
    .replace(/ /g, " ")
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** HTML 조각 문자열 → 줄바꿈을 보존한 일반 텍스트. */
export function fragmentToText(html: string): string {
  const $ = cheerio.load(`<div id="__root">${html}</div>`);
  return htmlToText($, $("#__root"));
}
