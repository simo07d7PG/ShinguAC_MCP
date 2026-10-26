import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeBody } from "../../src/http/decode.js";
import { HostNotAllowedError } from "../../src/http/errors.js";
import { HttpClient } from "../../src/http/http-client.js";
import { RequestQueue } from "../../src/queue/request-queue.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function redirect(location: string, setCookies: string[] = []): Response {
  const headers = new Headers({ location });
  for (const c of setCookies) headers.append("set-cookie", c);
  return new Response(null, { status: 302, headers });
}

function makeClient(responses: Response[]) {
  const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return next;
  });
  const client = new HttpClient({ fetch: fetchMock as unknown as typeof fetch, queue: new RequestQueue() });
  return { client, fetchMock };
}

describe("HttpClient", () => {
  it("리다이렉트 체인에서 Domain=shingu.ac.kr 쿠키가 다른 서브도메인 hop에 실린다", async () => {
    const { client, fetchMock } = makeClient([
      redirect("https://student.shingu.ac.kr/next", [
        "SSO=abc; Domain=shingu.ac.kr; Path=/; Secure",
        "HOSTONLY=1; Path=/",
      ]),
      new Response("done", { status: 200 }),
    ]);
    const p = client.get("https://login.shingu.ac.kr/start");
    await vi.advanceTimersByTimeAsync(5_000);
    const res = await p;

    expect(res.status).toBe(200);
    expect(res.finalUrl).toBe("https://student.shingu.ac.kr/next");
    expect(res.redirectChain).toHaveLength(2);
    const secondHeaders = fetchMock.mock.calls[1]![1]!.headers as Record<string, string>;
    expect(secondHeaders.Cookie).toContain("SSO=abc");
    expect(secondHeaders.Cookie).not.toContain("HOSTONLY");
    expect(fetchMock.mock.calls[1]![1]!.redirect).toBe("manual");
  });

  it("allowlist 밖 Location은 HostNotAllowedError", async () => {
    const { client, fetchMock } = makeClient([redirect("https://evil.example.com/x")]);
    const p = client.get("https://login.shingu.ac.kr/start").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await p).toBeInstanceOf(HostNotAllowedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("allowlist 밖 시작 URL은 요청 없이 거부", async () => {
    const { client, fetchMock } = makeClient([]);
    await expect(client.get("https://evil.example.com/")).rejects.toBeInstanceOf(HostNotAllowedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("302 뒤 POST는 GET으로 전환된다", async () => {
    const { client, fetchMock } = makeClient([
      redirect("https://student.shingu.ac.kr/after"),
      new Response("ok", { status: 200 }),
    ]);
    const p = client.postForm("https://login.shingu.ac.kr/login", { a: "1" });
    await vi.advanceTimersByTimeAsync(5_000);
    await p;
    expect(fetchMock.mock.calls[0]![1]!.method).toBe("POST");
    expect(fetchMock.mock.calls[0]![1]!.body).toBe("a=1");
    expect(fetchMock.mock.calls[1]![1]!.method).toBe("GET");
    expect(fetchMock.mock.calls[1]![1]!.body).toBeUndefined();
  });
});

describe("decodeBody", () => {
  const hangul = new Uint8Array([0xc7, 0xd1, 0xb1, 0xdb]); // EUC-KR "한글"

  it("Content-Type charset=euc-kr", () => {
    expect(decodeBody(hangul.buffer as ArrayBuffer, "text/html; charset=EUC-KR")).toBe("한글");
  });

  it("meta charset 스니핑", () => {
    const head = new TextEncoder().encode('<html><head><meta charset="euc-kr"></head>');
    const buf = new Uint8Array([...head, ...hangul]);
    expect(decodeBody(buf.buffer as ArrayBuffer, "text/html")).toContain("한글");
  });

  it("기본은 utf-8", () => {
    const buf = new TextEncoder().encode("안녕");
    expect(decodeBody(buf.buffer as ArrayBuffer, null)).toBe("안녕");
  });
});
