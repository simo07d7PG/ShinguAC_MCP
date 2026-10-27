import type { SubmitStatus } from "./assignments.js";
import { ParseError, load, stripComments } from "./common.js";

/** 과제 상세 화면에서 제출에 필요한 값. */
export interface SubmitControls {
  /** `registerModal`/`editModal` 요청에 함께 보내는 과제명(`boardFrm` hidden). */
  reportNm: string;
  /** "다시제출" 버튼 정보. 미제출·기간 아님이면 null. */
  resubmit: { inExtension: boolean; allowed: boolean } | null;
}

/**
 * 상세 화면의 제출 관련 값을 읽는다. 포털 JS 규칙:
 * `data-wr-id="Y"`면 연장 기간, `data-wr-re="N"`이고 점수가 0보다 크면 다시 제출 불가.
 */
export function parseSubmitControls(html: string): SubmitControls {
  const $ = load(stripComments(html));
  const reportNm = $("form[name=boardFrm] input[name=reportNm]").first().attr("value");
  if (reportNm === undefined) throw new ParseError("homework-detail", "form[name=boardFrm] input[name=reportNm]");
  const btn = $("button[data-role=resubmitBtn]").first();
  if (btn.length === 0) return { reportNm, resubmit: null };
  const score = Number((btn.attr("data-score") ?? "").trim());
  const blocked = (btn.attr("data-wr-re") ?? "").trim() === "N" && score > 0;
  return { reportNm, resubmit: { inExtension: (btn.attr("data-wr-id") ?? "").trim() === "Y", allowed: !blocked } };
}

/** 첨부 위젯(`div[data-role=fileUploader]`) 설정. 업로드 폼 데이터와 숨은 필드 이름을 정한다. */
export interface AttachConfig {
  fileKey: string;
  /** 기존 첨부 묶음 키. 신규 제출이면 빈 문자열. */
  fileMasterKey: string;
  fileSection: string;
  fileAccessType: string;
  prefix: string;
  maxFileCount: string;
}

export interface SubmitForm {
  reportSeq: string;
  studentNo: string;
  /** 기존 제출 제목(다시 제출 폼에만 값이 있다). */
  title: string;
  /** 기존 제출 본문 HTML(다시 제출 폼에만 값이 있다). */
  contentHtml: string;
  attach: AttachConfig;
}

/** `registerModal`(신규) 또는 `editModal`(다시 제출) 응답에서 폼 값을 읽는다. */
export function parseSubmitForm(html: string, formName: "registerForm" | "updateForm"): SubmitForm {
  const screen = formName === "registerForm" ? "homework-register-modal" : "homework-edit-modal";
  const $ = load(stripComments(html));
  const form = $(`form[name=${formName}]`).first();
  if (form.length === 0) throw new ParseError(screen, `form[name=${formName}]`);
  const val = (name: string): string => (form.find(`input[name=${name}]`).first().attr("value") ?? "").trim();
  const reportSeq = val("reportSeq");
  const studentNo = val("studentNo");
  if (!reportSeq || !studentNo) throw new ParseError(screen, "input[name=reportSeq|studentNo]");
  const up = form.find("div[data-role=fileUploader]").first();
  if (up.length === 0) throw new ParseError(screen, "div[data-role=fileUploader]");
  const attr = (name: string): string => (up.attr(`data-${name}`) ?? "").trim();
  return {
    reportSeq,
    studentNo,
    title: form.find("input[name=reportTitle]").first().attr("value") ?? "",
    contentHtml: form.find("textarea[name=reportContent]").first().text(),
    attach: {
      fileKey: attr("file-key"),
      fileMasterKey: attr("file-master-key"),
      fileSection: attr("file-section"),
      fileAccessType: attr("file-access-type"),
      prefix: attr("prefix"),
      maxFileCount: attr("max-file-count"),
    },
  };
}

/**
 * 내 제출이 있는지 판정한다. 상세가 `submitted`면 그대로 true.
 * 마감이 지나 버튼이 사라진 과제는 `editModal`에 제목·본문·첨부 키 중 하나라도 남아 있으면 제출한 것으로 본다.
 */
export function judgeSubmission(form: SubmitForm, detailStatus: SubmitStatus): boolean {
  if (detailStatus === "submitted") return true;
  return form.title.trim() !== "" || plainOf(form.contentHtml) !== "" || form.attach.fileMasterKey !== "";
}

export type FileDetail = Record<string, unknown>;

function parseJson(text: string, screen: string): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new ParseError(screen, "JSON 본문", "JSON이 아님");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new ParseError(screen, "JSON 객체");
  return v as Record<string, unknown>;
}

/** `GET /file/masterKey` → `{ fileMasterKey }`. */
export function parseMasterKey(text: string): string {
  const key = parseJson(text, "file-master-key")["fileMasterKey"];
  if (typeof key !== "string" || !key.trim()) throw new ParseError("file-master-key", "fileMasterKey");
  return key.trim();
}

/** `GET /file/info` → 기존 첨부 목록. 첨부가 없으면 `[]`. */
export function parseFileInfo(text: string): FileDetail[] {
  const details = parseJson(text, "file-info")["fileDetails"];
  if (details === undefined || details === null) return [];
  if (!Array.isArray(details)) throw new ParseError("file-info", "fileDetails[]");
  return details.filter((d): d is FileDetail => !!d && typeof d === "object");
}

/** `POST /file/upload` → `{ result, message, fileDetails: [..] }`. 실패면 포털 메시지를 담아 던진다. */
export function parseUploadResult(text: string): FileDetail {
  const json = parseJson(text, "file-upload");
  const details = json["fileDetails"];
  const first = Array.isArray(details) ? details[0] : undefined;
  if (json["result"] !== true || !first || typeof first !== "object") {
    const msg = typeof json["message"] === "string" && json["message"] ? json["message"] : "응답에 파일 정보 없음";
    throw new Error(`첨부 파일 업로드에 실패했습니다: ${msg}`);
  }
  return first as FileDetail;
}

/** 위젯 data 속성 중 업로드 응답과 이름이 같은 것만 숨은 필드가 된다(`fileMasterKey` 제외). */
const HIDDEN_KEYS = ["fileKey", "fileSection", "fileAccessType", "prefix", "maxFileCount"] as const;

const fieldName = (prefix: string, key: string): string =>
  prefix ? prefix + key.charAt(0).toUpperCase() + key.slice(1) : key;

/**
 * 포털 `poizn.file.js`가 폼에 붙이는 숨은 필드를 그대로 만든다.
 * `<prefix>FileMasterKey` 1개 + 파일마다 `<prefix>FileKey`·`<prefix>FileSection`·… (값이 있는 것만).
 */
export function attachFields(attach: AttachConfig, masterKey: string, files: FileDetail[]): Array<[string, string]> {
  const out: Array<[string, string]> = [[fieldName(attach.prefix, "fileMasterKey"), masterKey]];
  for (const file of files) {
    for (const key of HIDDEN_KEYS) {
      const v = file[key];
      // poizn.file.js와 같은 truthy 판정(`if (value)`): 빈 값·0·false·null은 넣지 않는다.
      if (v) out.push([fieldName(attach.prefix, key), String(v)]);
    }
  }
  return out;
}

/** 제출 응답에서 `alert('…')` 문구를 뽑는다(실패 사유 안내용). */
export function extractAlert(html: string): string | undefined {
  const m = /alert\(\s*(['"])((?:\\.|(?!\1).)*)\1\s*\)/.exec(html);
  return m?.[2]?.replace(/\\(.)/g, "$1").replace(/<br\s*\/?>/gi, " ").trim() || undefined;
}

/** 평문 → TinyMCE가 만드는 것과 같은 `<p>` 단락 HTML. */
export function textToHtml(text: string): string {
  const esc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => `<p>${line.trim() ? esc(line) : "&nbsp;"}</p>`)
    .join("\n");
}

/** 본문 HTML 비교용: 태그·엔티티·공백을 걷어낸 글자만 남긴다. */
export function plainOf(html: string): string {
  return load(`<div>${html}</div>`)("div").first().text().replace(/[\s ]+/g, "");
}
