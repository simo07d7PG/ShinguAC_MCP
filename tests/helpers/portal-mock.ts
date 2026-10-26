import { readFileSync } from "node:fs";
import { vi } from "vitest";
import { HttpClient } from "../../src/http/http-client.js";
import { RequestQueue } from "../../src/queue/request-queue.js";

const fixture = (name: string): string => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: URLSearchParams;
}

export interface PortalMockOptions {
  /** 4단계 자격증명 제출 결과: 성공(302 userDiv) 또는 거부(200 로그인 페이지) */
  rejectCredentials?: boolean;
  userGb?: string;
}

const html = (text: string): Response =>
  new Response(text, { status: 200, headers: { "content-type": "text/html;charset=UTF-8" } });
const redirect = (location: string): Response => new Response(null, { status: 302, headers: { location } });

/** 실제 포털 체인을 흉내 내는 모의 fetch. 세션 유효 여부를 상태로 가진다. */
export function createPortalMock(options: PortalMockOptions = {}) {
  let sessionValid = false;
  const requests: RecordedRequest[] = [];

  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    requests.push({
      method,
      url: url.href,
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: new URLSearchParams(typeof init?.body === "string" ? init.body : ""),
    });
    const key = `${method} ${url.host}${url.pathname}`;
    switch (key) {
      case "GET student.shingu.ac.kr/dashboard/dashboard":
        return sessionValid ? html(fixture("dashboard.html")) : redirect("/notlogin/t");
      case "GET student.shingu.ac.kr/notlogin/t":
        return html(fixture("login/notlogin.html"));
      case "POST login.shingu.ac.kr/index":
        return html(fixture("login/sso-login-form.html"));
      case "POST login.shingu.ac.kr/login":
        return options.rejectCredentials ? html(fixture("login/sso-login-form.html")) : redirect("/login/userDiv");
      case "GET login.shingu.ac.kr/login/userDiv":
        return html(fixture("login/sso-userdiv.html").replace('var userGb = "2"', `var userGb = "${options.userGb ?? "2"}"`));
      case "POST student.shingu.ac.kr/ssoLogin":
        sessionValid = true;
        return redirect("/dashboard/dashboard");
      default:
        throw new Error(`unexpected request: ${key}`);
    }
  });

  const client = new HttpClient({
    fetch: fetchMock as unknown as typeof fetch,
    queue: new RequestQueue({ minGapMs: 0 }),
  });

  return {
    client,
    requests,
    fetchMock,
    expireSession: (): void => {
      sessionValid = false;
    },
    get loginCount(): number {
      return requests.filter((r) => r.url === "https://login.shingu.ac.kr/login").length;
    },
  };
}

export const dashboardGet = (client: HttpClient) => client.get("https://student.shingu.ac.kr/dashboard/dashboard");
