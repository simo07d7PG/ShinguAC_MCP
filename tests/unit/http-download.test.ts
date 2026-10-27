import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AbortError, HostNotAllowedError, HttpStatusError, NetworkError } from "../../src/http/errors.js";
import { HttpClient } from "../../src/http/http-client.js";
import { downloadRequestQueue, RequestQueue, requestQueue } from "../../src/queue/request-queue.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dl-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const client = (fetchFn: (url: string) => Response): HttpClient =>
  new HttpClient({
    fetch: (async (input: string | URL | Request) => fetchFn(String(input))) as typeof fetch,
    queue: new RequestQueue({ minGapMs: 0, maxRetries: 0 }),
  });

const bytes = Buffer.from("PK\u0003\u0004 hello 한글");
const partFiles = (): string[] => readdirSync(dir).filter((f) => f.endsWith(".part"));

describe("HttpClient.download", () => {
  it("리다이렉트를 따라가 본문을 파일로 저장하고 크기·sha256을 돌려준다", async () => {
    const seen: string[] = [];
    const c = client((url) => {
      seen.push(url);
      if (url.includes("/file/download")) {
        return new Response(null, { status: 302, headers: { location: "https://cec.shingu.ac.kr/01shingu/eClassDown.jsp?file_key=k" } });
      }
      return new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } });
    });
    const dest = join(dir, "a.bin");
    const r = await c.download("https://student.shingu.ac.kr/file/download?fileKey=k", dest);
    expect(seen).toHaveLength(2);
    expect(r.size).toBe(bytes.length);
    expect(r.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(readFileSync(dest)).toEqual(bytes);
    expect(partFiles()).toEqual([]);
  });

  it("Content-Disposition 없는 HTML(만료 키·로그인 화면)은 파일로 저장하지 않는다", async () => {
    const c = client(() => new Response("<script>alert('x')</script>", { status: 200, headers: { "content-type": "text/html;charset=UTF-8" } }));
    const dest = join(dir, "h.bin");
    await expect(c.download("https://cec.shingu.ac.kr/x", dest)).rejects.toThrow(/HTML/);
    expect(existsSync(dest)).toBe(false);
  });

  it("압축 응답(content-encoding)이면 Content-Length 비교를 건너뛴다", async () => {
    const c = client(() => new Response(bytes, { status: 200, headers: { "content-length": "5", "content-encoding": "gzip" } }));
    const r = await c.download("https://cec.shingu.ac.kr/x", join(dir, "g.bin"));
    expect(r.size).toBe(bytes.length);
  });

  it("Content-Length와 받은 크기가 다르면 실패하고 파일을 남기지 않는다", async () => {
    const c = client(() => new Response(bytes, { status: 200, headers: { "content-length": "999" } }));
    const dest = join(dir, "b.bin");
    await expect(c.download("https://cec.shingu.ac.kr/x", dest)).rejects.toBeInstanceOf(NetworkError);
    expect(existsSync(dest)).toBe(false);
    expect(partFiles()).toEqual([]);
  });

  it("4xx는 HttpStatusError, 허용 밖 호스트(리다이렉트 포함)는 거부", async () => {
    const notFound = client(() => new Response("no", { status: 404 }));
    await expect(notFound.download("https://cec.shingu.ac.kr/x", join(dir, "c.bin"))).rejects.toBeInstanceOf(HttpStatusError);
    const evil = client(() => new Response(null, { status: 302, headers: { location: "https://evil.example/x" } }));
    await expect(evil.download("https://cec.shingu.ac.kr/x", join(dir, "d.bin"))).rejects.toBeInstanceOf(HostNotAllowedError);
    await expect(evil.download("http://cec.shingu.ac.kr/x", join(dir, "e.bin"))).rejects.toBeInstanceOf(HostNotAllowedError);
  });

  it("받는 중 취소: 스트림을 끊고 임시 파일을 지운 뒤 AbortError(재시도 없음)", async () => {
    const ac = new AbortController();
    let calls = 0;
    const c = new HttpClient({
      fetch: (async () => {
        calls++;
        // 첫 조각만 보내고 끝나지 않는 본문
        const body = new ReadableStream<Uint8Array>({
          start(ctrl) {
            ctrl.enqueue(new Uint8Array(bytes));
            setTimeout(() => ac.abort(), 20);
          },
        });
        return new Response(body, { status: 200 });
      }) as typeof fetch,
      queue: new RequestQueue({ minGapMs: 0, maxRetries: 2 }),
    });
    const dest = join(dir, "s.bin");
    await expect(c.download("https://cec.shingu.ac.kr/x", dest, { signal: ac.signal })).rejects.toBeInstanceOf(AbortError);
    // 스트림이 닫히고 정리가 끝날 시간을 준다
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(1);
    expect(existsSync(dest)).toBe(false);
    expect(partFiles()).toEqual([]);
  });

  it("다운로드 큐: 기본은 조회 큐와 별도, queue만 주면 그것을, downloadQueue를 주면 그것을 쓴다", async () => {
    const fetchFn = (async () => new Response(bytes, { status: 200 })) as typeof fetch;
    const lookup = vi.spyOn(requestQueue, "enqueue");
    const dl = vi.spyOn(downloadRequestQueue, "enqueue");
    await new HttpClient({ fetch: fetchFn }).download("https://cec.shingu.ac.kr/x", join(dir, "1.bin"));
    expect(dl).toHaveBeenCalledTimes(1);
    expect(lookup).not.toHaveBeenCalled();

    const injected = new RequestQueue({ minGapMs: 0 });
    const injectedSpy = vi.spyOn(injected, "enqueue");
    await new HttpClient({ fetch: fetchFn, queue: injected }).download("https://cec.shingu.ac.kr/x", join(dir, "2.bin"));
    expect(injectedSpy).toHaveBeenCalledTimes(1);

    const own = new RequestQueue({ minGapMs: 0 });
    const ownSpy = vi.spyOn(own, "enqueue");
    await new HttpClient({ fetch: fetchFn, queue: injected, downloadQueue: own }).download("https://cec.shingu.ac.kr/x", join(dir, "3.bin"));
    expect(ownSpy).toHaveBeenCalledTimes(1);
    expect(injectedSpy).toHaveBeenCalledTimes(1);
    expect(dl).toHaveBeenCalledTimes(1);
  });

  it("다운로드가 오래 걸려도 조회 요청은 별도 큐에서 진행된다", async () => {
    let release!: () => void;
    const c = new HttpClient({
      fetch: (async (input: string | URL | Request) => {
        if (String(input).includes("eClassDown")) {
          await new Promise<void>((r) => (release = r));
          return new Response(bytes, { status: 200 });
        }
        return new Response("ok", { status: 200 });
      }) as typeof fetch,
      queue: new RequestQueue({ minGapMs: 0 }),
      downloadQueue: new RequestQueue({ minGapMs: 0 }),
    });
    const dl = c.download("https://cec.shingu.ac.kr/01shingu/eClassDown.jsp", join(dir, "slow.bin"));
    await new Promise((r) => setTimeout(r, 10));
    expect((await c.get("https://student.shingu.ac.kr/x")).text).toBe("ok");
    release();
    expect((await dl).size).toBe(bytes.length);
  });
});
