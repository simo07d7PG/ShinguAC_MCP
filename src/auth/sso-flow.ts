import type { HttpClient, HttpResponse } from "../http/http-client.js";
import { AuthRejectedError, AuthUnsupportedError, LoginFailedError } from "./errors.js";
import { extractForm, extractJsVar, stripHtmlComments, type ExtractedForm } from "./forms.js";

const PORTAL = "https://student.shingu.ac.kr";
const LOGIN_HOST = "https://login.shingu.ac.kr";
export const DASHBOARD_URL = `${PORTAL}/dashboard/dashboard`;
const LOGIN_POST_URL = `${LOGIN_HOST}/login`;
const USER_DIV_URL = `${LOGIN_HOST}/login/userDiv`;
const SSO_LOGIN_URL = `${PORTAL}/ssoLogin`;
const SSO_RED_FORM = "ssoRedFrm";
const LOGIN_FORM = "loginFrm";
const STUDENT_USER_GB = "2";
const NOT_LOGIN = "/notlogin/";
const SSO_PARAMS = ["loginType", "param1", "param2", "param3"] as const;

export function isSessionExpired(res: HttpResponse): boolean {
  return (
    res.finalUrl.includes(NOT_LOGIN) ||
    res.redirectChain.some((hop) => hop.url.includes(NOT_LOGIN)) ||
    stripHtmlComments(res.text).includes(`id="${SSO_RED_FORM}"`)
  );
}

function requireForm(html: string, name: string, step: string): ExtractedForm {
  const form = extractForm(html, name);
  if (!form) throw new LoginFailedError(`${step}: ${name} 폼을 찾을 수 없습니다.`);
  return form;
}

function requireVar(html: string, name: string): string {
  const v = extractJsVar(html, name);
  if (v === null) throw new LoginFailedError(`userDiv: ${name} 변수를 찾을 수 없습니다.`);
  return v;
}

function isUserDiv(url: string): boolean {
  try {
    const u = new URL(url);
    return u.origin === LOGIN_HOST && u.pathname === "/login/userDiv";
  } catch {
    return false;
  }
}

/** 포털 SSO 7단계 로그인. 이미 로그인된 상태(대시보드 직행)면 즉시 반환한다. */
export async function login(client: HttpClient, id: string, password: string): Promise<void> {
  // 1~2: 대시보드 요청 -> /notlogin/t 의 ssoRedFrm
  const first = await client.get(DASHBOARD_URL);
  if (!isSessionExpired(first)) return;
  const red = requireForm(first.text, SSO_RED_FORM, "notlogin");

  // 3: 로그인 페이지
  const loginPage = await client.postForm(new URL(red.action, first.finalUrl).href, red.fields);
  const loginForm = requireForm(loginPage.text, LOGIN_FORM, "로그인 페이지");

  // 4: 자격증명 제출 (성공 시 302 -> /login/userDiv)
  const { idSaveCheck: _omit, ...baseFields } = loginForm.fields;
  const submitted = await client.postForm(
    LOGIN_POST_URL,
    { ...baseFields, userId: id, password, isCapslock: "" },
    { headers: { Referer: loginPage.finalUrl, Origin: LOGIN_HOST } },
  );
  if (!isUserDiv(submitted.finalUrl)) throw new AuthRejectedError();

  // 5: userDiv 인라인 JS 변수
  const html = submitted.text;
  if (requireVar(html, "userGb") !== STUDENT_USER_GB) throw new AuthUnsupportedError();
  const returnUrl = requireVar(html, "returnUrl");
  const sso = Object.fromEntries(SSO_PARAMS.map((k) => [k, requireVar(html, k)]));

  // 6~7: 포털 ssoLogin -> 대시보드
  const done = await client.postForm(
    SSO_LOGIN_URL,
    { ReturnUrl: returnUrl, userId: "", password: "", _method: "", ...sso },
    { headers: { Referer: USER_DIV_URL, Origin: LOGIN_HOST } },
  );
  if (isSessionExpired(done)) throw new LoginFailedError("포털 ssoLogin 이후에도 로그인 상태가 아닙니다.");
}
