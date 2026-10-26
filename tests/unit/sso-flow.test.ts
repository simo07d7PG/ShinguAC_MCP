import { describe, expect, it } from "vitest";
import { AuthRejectedError, AuthUnsupportedError } from "../../src/auth/errors.js";
import { extractForm, extractJsVar } from "../../src/auth/forms.js";
import { isSessionExpired, login } from "../../src/auth/sso-flow.js";
import { registerSecret } from "../../src/log/redact.js";
import { createPortalMock } from "../helpers/portal-mock.js";

const SENTINEL_PW = "S3ntinel-PW-do-not-leak";
registerSecret(SENTINEL_PW);

describe("forms", () => {
  it("주석 처리된 테스트 SSO 폼을 무시하고 ssoRedFrm을 추출한다", async () => {
    const { readFileSync } = await import("node:fs");
    const html = readFileSync(new URL("../fixtures/login/notlogin.html", import.meta.url), "utf8");
    const form = extractForm(html, "ssoRedFrm");
    expect(form?.action).toBe("https://login.shingu.ac.kr/index");
    expect(form?.method).toBe("POST");
    expect(Object.keys(form?.fields ?? {})).toEqual(["loginType", "param1", "param2", "param3"]);
  });

  it("없는 폼은 null, JS 변수는 문자열 값을 반환한다", () => {
    expect(extractForm("<form name='a'></form>", "b")).toBeNull();
    expect(extractJsVar('<script>var userGb = "2";</script>', "userGb")).toBe("2");
    expect(extractJsVar("<script></script>", "userGb")).toBeNull();
  });
});

describe("login", () => {
  it("정상 체인 7단계를 순서대로 수행하고 비밀번호는 password 필드에만 담는다", async () => {
    const mock = createPortalMock();
    await login(mock.client, "2000000000", SENTINEL_PW);

    expect(mock.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      "GET https://student.shingu.ac.kr/dashboard/dashboard",
      "GET https://student.shingu.ac.kr/notlogin/t",
      "POST https://login.shingu.ac.kr/index",
      "POST https://login.shingu.ac.kr/login",
      "GET https://login.shingu.ac.kr/login/userDiv",
      "POST https://student.shingu.ac.kr/ssoLogin",
      "GET https://student.shingu.ac.kr/dashboard/dashboard",
    ]);

    const [, , index, submit, , sso] = mock.requests;
    expect([...index!.body.keys()]).toEqual(["loginType", "param1", "param2", "param3"]);
    expect(Object.fromEntries(submit!.body)).toEqual({
      userId: "2000000000",
      password: SENTINEL_PW,
      isCapslock: "",
    });
    expect(submit!.headers["Origin"]).toBe("https://login.shingu.ac.kr");
    expect(submit!.headers["Referer"]).toContain("login.shingu.ac.kr");
    expect(Object.fromEntries(sso!.body)).toEqual({
      ReturnUrl: "",
      userId: "",
      password: "",
      _method: "",
      loginType: "",
      param1: "",
      param2: "",
      param3: "",
    });
    expect(sso!.headers["Referer"]).toBe("https://login.shingu.ac.kr/login/userDiv");

    const withSentinel = mock.requests.filter((r) => [...r.body.values()].includes(SENTINEL_PW));
    expect(withSentinel).toHaveLength(1);
  });

  it("자격증명 거부(302 아님)는 AuthRejectedError이며 메시지에 비밀번호가 없다", async () => {
    const mock = createPortalMock({ rejectCredentials: true });
    const err = await login(mock.client, "2000000000", SENTINEL_PW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthRejectedError);
    expect((err as Error).message).not.toContain(SENTINEL_PW);
    expect(String(err)).not.toContain(SENTINEL_PW);
  });

  it("userGb가 2가 아니면 AuthUnsupportedError", async () => {
    const mock = createPortalMock({ userGb: "1" });
    const err = await login(mock.client, "2000000000", SENTINEL_PW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthUnsupportedError);
    expect(String(err)).not.toContain(SENTINEL_PW);
    expect(mock.requests.some((r) => r.url.endsWith("/ssoLogin"))).toBe(false);
  });
});

describe("isSessionExpired", () => {
  const base = { status: 200, headers: new Headers(), text: "", redirectChain: [] };
  it("finalUrl, redirectChain, ssoRedFrm 중 하나라도 해당하면 true", () => {
    expect(isSessionExpired({ ...base, finalUrl: "https://student.shingu.ac.kr/notlogin/t" })).toBe(true);
    expect(
      isSessionExpired({
        ...base,
        finalUrl: "https://student.shingu.ac.kr/x",
        redirectChain: [{ url: "https://student.shingu.ac.kr/notlogin/t", status: 200 }],
      }),
    ).toBe(true);
    expect(isSessionExpired({ ...base, finalUrl: "https://student.shingu.ac.kr/x", text: '<form id="ssoRedFrm">' })).toBe(true);
    expect(isSessionExpired({ ...base, finalUrl: "https://student.shingu.ac.kr/x", text: '<!-- <form id="ssoRedFrm"> -->' })).toBe(false);
  });
});
