import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ParseError } from "../../../src/parsers/common.js";
import {
  attachFields,
  extractAlert,
  judgeSubmission,
  parseFileInfo,
  parseMasterKey,
  parseSubmitControls,
  parseSubmitForm,
  parseUploadResult,
  plainOf,
  textToHtml,
} from "../../../src/parsers/submit.js";

const fixture = (name: string): string =>
  readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), "utf8");

describe("parseSubmitControls", () => {
  it("미제출 상세: reportNm만 있고 다시제출 버튼 없음", () => {
    const c = parseSubmitControls(fixture("eclass/homework-detail-not-submitted.html"));
    expect(c.reportNm.length).toBeGreaterThan(0);
    expect(c.resubmit).toBeNull();
  });

  it("제출함 상세: 다시 제출 가능, 연장 기간 아님(data-wr-id=N)", () => {
    const c = parseSubmitControls(fixture("eclass/homework-detail-submitted.html"));
    expect(c.resubmit).toEqual({ inExtension: false, allowed: true });
  });

  it("평가 완료(data-wr-re=N, 점수>0)면 다시 제출 불가, data-wr-id=Y면 연장 기간", () => {
    const html = fixture("eclass/homework-detail-submitted.html").replace(
      'data-wr-id="N" data-wr-re="Y" data-score=""',
      'data-wr-id="Y" data-wr-re="N" data-score="10"',
    );
    expect(parseSubmitControls(html).resubmit).toEqual({ inExtension: true, allowed: false });
  });

  it("boardFrm이 없으면 ParseError", () => {
    expect(() => parseSubmitControls("<html></html>")).toThrow(ParseError);
  });
});

describe("parseSubmitForm", () => {
  it("신규 제출 폼: 학번·빈 제목·첨부 위젯 설정", () => {
    const f = parseSubmitForm(fixture("eclass/homework-register-modal.html"), "registerForm");
    expect(f).toEqual({
      reportSeq: "34708",
      studentNo: "2000000000",
      title: "",
      contentHtml: "",
      attach: {
        fileKey: "",
        fileMasterKey: "",
        fileSection: "submitAttach",
        fileAccessType: "PUBLIC",
        prefix: "submitAttach",
        maxFileCount: "1",
      },
    });
  });

  it("다시 제출 폼: 기존 제목·본문·첨부 묶음 키", () => {
    const f = parseSubmitForm(fixture("eclass/homework-edit-modal.html"), "updateForm");
    expect(f.reportSeq).toBe("34757");
    expect(f.title).toBe("2000000000 홍길동_8주차");
    expect(f.contentHtml).toBe("<p>기존 제출 본문</p>");
    expect(f.attach.fileMasterKey).toBe("20260101000000-00000000000000000000000000000000");
  });

  it("폼 이름이 다르면 ParseError", () => {
    expect(() => parseSubmitForm(fixture("eclass/homework-register-modal.html"), "updateForm")).toThrow(ParseError);
  });
});

describe("첨부 JSON", () => {
  it("masterKey / info / upload 결과", () => {
    expect(parseMasterKey('{"fileMasterKey":"MK1"}')).toBe("MK1");
    expect(() => parseMasterKey("{}")).toThrow(ParseError);
    expect(parseFileInfo('{"fileMasterKey":"MK1"}')).toEqual([]);
    expect(parseFileInfo('{"fileDetails":[{"fileKey":"F1"}]}')).toEqual([{ fileKey: "F1" }]);
    expect(parseUploadResult('{"result":true,"fileDetails":[{"fileKey":"F2"}]}')).toEqual({ fileKey: "F2" });
    expect(() => parseUploadResult('{"result":false,"message":"용량 초과"}')).toThrow(/용량 초과/);
    expect(() => parseUploadResult("<html>")).toThrow(ParseError);
  });

  it("attachFields: 포털 위젯처럼 prefix + 대문자 키, 값이 있는 것만", () => {
    const attach = parseSubmitForm(fixture("eclass/homework-register-modal.html"), "registerForm").attach;
    const fields = attachFields(attach, "MK", [
      { fileKey: "F1", fileSection: "submitAttach", fileAccessType: "PUBLIC", oriFileNm: "a.pdf", saveFileNm: null },
    ]);
    expect(fields).toEqual([
      ["submitAttachFileMasterKey", "MK"],
      ["submitAttachFileKey", "F1"],
      ["submitAttachFileSection", "submitAttach"],
      ["submitAttachFileAccessType", "PUBLIC"],
    ]);
  });
});

describe("본문 변환·비교", () => {
  it("textToHtml: 줄마다 <p>, 빈 줄은 &nbsp;, 특수문자 이스케이프", () => {
    expect(textToHtml("a < b & c\n\n끝")).toBe("<p>a &lt; b &amp; c</p>\n<p>&nbsp;</p>\n<p>끝</p>");
  });

  it("plainOf: 태그·엔티티·공백 차이는 같은 값", () => {
    expect(plainOf(textToHtml("a & b\n줄2"))).toBe(plainOf('<p style="x">a &amp; b</p><p>줄2</p>'));
  });

  it("extractAlert: alert 문구 추출", () => {
    expect(extractAlert("<script>alert('제출 기간이 아닙니다.');location.href='/x'</script>")).toBe(
      "제출 기간이 아닙니다.",
    );
    expect(extractAlert("<html></html>")).toBeUndefined();
  });
});

describe("judgeSubmission", () => {
  const empty = () => {
    const f = parseSubmitForm(fixture("eclass/homework-edit-modal.html"), "updateForm");
    return { ...f, title: "", contentHtml: "", attach: { ...f.attach, fileMasterKey: "" } };
  };
  it("상세가 submitted면 폼이 비어 있어도 true", () => {
    expect(judgeSubmission(empty(), "submitted")).toBe(true);
  });
  it("not_open + 폼이 모두 비면 false (공백·빈 단락만 있는 본문 포함)", () => {
    expect(judgeSubmission(empty(), "not_open")).toBe(false);
    expect(judgeSubmission({ ...empty(), title: "  ", contentHtml: "<p>&nbsp;</p>" }, "not_open")).toBe(false);
  });
  it("not_open + 제목 / 본문 / 첨부 키 중 하나만 있어도 true", () => {
    expect(judgeSubmission({ ...empty(), title: "제목" }, "not_open")).toBe(true);
    expect(judgeSubmission({ ...empty(), contentHtml: "<p>내용</p>" }, "not_open")).toBe(true);
    const e = empty();
    expect(judgeSubmission({ ...e, attach: { ...e.attach, fileMasterKey: "K" } }, "not_open")).toBe(true);
  });
});
