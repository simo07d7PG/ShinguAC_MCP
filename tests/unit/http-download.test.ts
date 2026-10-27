import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostNotAllowedError, HttpStatusError, NetworkError } from "../../src/http/errors.js";
import { HttpClient } from "../../src/http/http-client.js";
import { RequestQueue } from "../../src/queue/request-queue.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dl-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

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
});
