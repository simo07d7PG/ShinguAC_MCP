import type { SessionManager } from "../auth/session-manager.js";
import { ParseError } from "../parsers/common.js";
import {
  parseFileInfo,
  parseMasterKey,
  parseSubmitControls,
  parseSubmitForm,
  parseUploadResult,
  type AttachConfig,
  type FileDetail,
  type SubmitForm,
} from "../parsers/submit.js";
import { PORTAL_ORIGIN } from "./urls.js";

const HOMEWORK = `${PORTAL_ORIGIN}/eclass/clas/room/homework`;
/** 포털 화면의 jQuery ajax와 같은 헤더. */
const JSON_HEADERS = { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" };
/** 업로드는 파일 크기에 따라 오래 걸릴 수 있어 기본 15초 대신 쓴다. */
const UPLOAD_TIMEOUT_MS = 120_000;

export type SubmitKind = "register" | "edit";

/** 상세 화면 원문 — 1요청. `enterLecture` 뒤에 호출한다. */
export async function fetchHomeworkDetailHtml(session: SessionManager, reportSeq: string): Promise<string> {
  const q = new URLSearchParams({ reportSeq });
  return (await session.request((c) => c.get(`${HOMEWORK}/homeworkDetail?${q}`))).text;
}

/** 제출 폼 — 1요청. 신규는 `registerModal`, 다시 제출은 `editModal`(기존 제목·본문·첨부 키 포함). */
export async function fetchSubmitForm(
  session: SessionManager,
  kind: SubmitKind,
  reportSeq: string,
  reportNm: string,
): Promise<SubmitForm> {
  const q = new URLSearchParams({ reportSeq, reportNm });
  const res = await session.request((c) =>
    c.get(`${HOMEWORK}/${kind}Modal?${q}`, { headers: { Accept: "text/html;", "X-Requested-With": "XMLHttpRequest" } }),
  );
  return parseSubmitForm(res.text, kind === "register" ? "registerForm" : "updateForm");
}

/**
 * 상세 화면 HTML에서 과제명을 읽어 `editModal`을 연다 — 1요청. 폼이나 과제명을 읽지 못하면(ParseError) undefined.
 * 제출 판정(`judgeSubmission`)에 쓰며, 첨부 목록은 따로 읽지 않는다.
 */
export async function fetchSubmissionForm(
  session: SessionManager,
  detailHtml: string,
  reportSeq: string,
): Promise<SubmitForm | undefined> {
  try {
    const { reportNm } = parseSubmitControls(detailHtml);
    return await fetchSubmitForm(session, "edit", reportSeq, reportNm);
  } catch (err) {
    if (err instanceof ParseError) return undefined;
    throw err;
  }
}

/** 새 첨부 묶음 키 발급 — 1요청. 포털 화면도 제출 폼을 열 때마다 하나 발급받는다. */
export async function fetchFileMasterKey(session: SessionManager): Promise<string> {
  const res = await session.request((c) => c.get(`${PORTAL_ORIGIN}/file/masterKey`, { headers: JSON_HEADERS }));
  return parseMasterKey(res.text);
}

/** 기존 첨부 목록 — 1요청. */
export async function fetchFileInfo(session: SessionManager, fileMasterKey: string): Promise<FileDetail[]> {
  const q = new URLSearchParams({ fileMasterKey });
  const res = await session.request((c) => c.get(`${PORTAL_ORIGIN}/file/info?${q}`, { headers: JSON_HEADERS }));
  return parseFileInfo(res.text);
}

export interface UploadFile {
  name: string;
  type: string;
  data: Uint8Array<ArrayBuffer>;
}

/**
 * 첨부 업로드 — 1요청, 재시도 없음. 폼 데이터는 포털 위젯의 data 속성 전체(`role` 제외),
 * 파일 필드 이름은 위젯 템플릿(`/cmm/file/view`)의 `cmmFileUpload`.
 */
export async function uploadAttachment(
  session: SessionManager,
  attach: AttachConfig,
  fileMasterKey: string,
  file: UploadFile,
): Promise<FileDetail> {
  const res = await session.request((c) => {
    // 세션 만료로 재호출될 수 있으므로 FormData는 호출마다 새로 만든다.
    const form = new FormData();
    form.append("fileKey", attach.fileKey);
    form.append("fileMasterKey", fileMasterKey);
    form.append("fileSection", attach.fileSection);
    form.append("fileAccessType", attach.fileAccessType);
    form.append("prefix", attach.prefix);
    form.append("maxFileCount", attach.maxFileCount);
    form.append("cmmFileUpload", new Blob([file.data], { type: file.type }), file.name);
    return c.postMultipart(`${PORTAL_ORIGIN}/file/upload`, form, {
      headers: JSON_HEADERS,
      retries: 0,
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });
  });
  return parseUploadResult(res.text);
}

/**
 * 제출 POST — 1요청. 큐 재시도도, 세션 만료 시 재전송도 하지 않는다(중복 제출 방지).
 * 응답 원문을 돌려준다(실패 사유 추출용).
 */
export async function postReportSubmit(
  session: SessionManager,
  kind: SubmitKind,
  fields: Array<[string, string]>,
): Promise<string> {
  const action = kind === "register" ? "insertReportSubmit" : "updateReportSubmit";
  const res = await session.request((c) => c.postForm(`${HOMEWORK}/${action}`, fields, { retries: 0 }), {
    resend: false,
  });
  return res.text;
}
