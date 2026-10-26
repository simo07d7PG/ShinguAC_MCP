import { describe, expect, it } from "vitest";
import { ParseError, load, stripComments, tableRows, text } from "../../src/parsers/common.js";

describe("parsers/common", () => {
  it("text normalizes whitespace and nbsp", () => {
    const $ = load("<p id='a'>  과목  이름 \n 끝 </p>");
    expect(text($("#a"))).toBe("과목 이름 끝");
  });

  it("tableRows skips th rows", () => {
    const $ = load(
      "<table id='t'><tr><th>과목</th><th>점수</th></tr><tr><td>UI&nbsp;화면</td><td> 90 </td></tr><tr><td>웹</td><td>80</td></tr></table>",
    );
    expect(tableRows($, "#t")).toEqual([
      ["UI 화면", "90"],
      ["웹", "80"],
    ]);
  });

  it("stripComments removes commented-out forms", () => {
    const html = "<div>a</div><!-- <form id='test'></form> --><div>b</div>";
    const $ = load(stripComments(html));
    expect($("form").length).toBe(0);
    expect($("div").length).toBe(2);
  });

  it("ParseError carries screen and selector", () => {
    const e = new ParseError("과제목록", "table.list", "구조 변경?");
    expect(e).toBeInstanceOf(Error);
    expect(e.screen).toBe("과제목록");
    expect(e.selector).toBe("table.list");
    expect(e.message).toContain("table.list");
  });
});
