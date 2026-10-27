import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { PortalCookieJar } from "./cookie-jar.js";
import { decodeBody } from "./decode.js";
import { HostNotAllowedError, HttpStatusError, NetworkError } from "./errors.js";
import { requestQueue, type EnqueueOptions, type RequestQueue } from "../queue/request-queue.js";

/** cec.shingu.ac.kr: E클래스 첨부 다운로드(`eClassDown.jsp`). */
export const DEFAULT_ALLOWED_HOSTS = ["student.shingu.ac.kr", "login.shingu.ac.kr", "www.shingu.ac.kr", "cec.shingu.ac.kr"];
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const MAX_REDIRECTS = 10;
/** 첨부 다운로드 한 건의 제한 시간. 실측 56MB가 21초(docs/portal-pages.md §3.4). */
export const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

export interface HttpClientOptions {
  fetch?: typeof fetch;
  jar?: PortalCookieJar;
  queue?: RequestQueue;
  allowedHosts?: string[];
  logger?: { debug(...args: unknown[]): void };
}

export interface RequestOptions extends EnqueueOptions {
  headers?: Record<string, string>;
}

type Body = string | FormData | undefined;

export interface DownloadResult {
  size: number;
  sha256: string;
  headers: Headers;
}

export interface RedirectHop {
  url: string;
  status: number;
  location?: string;
}

export interface HttpResponse {
  status: number;
  finalUrl: string;
  headers: Headers;
  text: string;
  redirectChain: RedirectHop[];
}

interface RawResponse {
  status: number;
  headers: Headers;
  body: ArrayBuffer;
}

export class HttpClient {
  private readonly fetchFn: typeof fetch;
  private readonly jar: PortalCookieJar;
  private readonly queue: RequestQueue;
  private readonly allowedHosts: Set<string>;
  private readonly logger?: { debug(...args: unknown[]): void };

  constructor(options: HttpClientOptions = {}) {
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.jar = options.jar ?? new PortalCookieJar();
    this.queue = options.queue ?? requestQueue;
    this.allowedHosts = new Set(options.allowedHosts ?? DEFAULT_ALLOWED_HOSTS);
    this.logger = options.logger;
  }

  get(url: string, options: RequestOptions = {}): Promise<HttpResponse> {
    return this.request("GET", url, undefined, options.headers ?? {}, options);
  }

  /** 같은 이름의 필드가 여러 개일 수 있으면 `[name, value][]`로 넘긴다(폼 순서 유지). */
  postForm(
    url: string,
    fields: Record<string, string> | Array<[string, string]>,
    options: RequestOptions = {},
  ): Promise<HttpResponse> {
    return this.request(
      "POST",
      url,
      new URLSearchParams(fields).toString(),
      { "Content-Type": "application/x-www-form-urlencoded", ...options.headers },
      options,
    );
  }

  /** multipart/form-data. Content-Type(boundary)은 fetch가 정한다. */
  postMultipart(url: string, form: FormData, options: RequestOptions = {}): Promise<HttpResponse> {
    return this.request("POST", url, form, options.headers ?? {}, options);
  }

  /**
   * GET 응답 본문을 `dest`에 스트리밍으로 저장한다(임시 파일 → rename). 큐를 거치며 리다이렉트도 허용 호스트만 따른다.
   * Content-Length와 받은 크기가 다르면 실패로 본다. 기본 제한 시간은 DOWNLOAD_TIMEOUT_MS.
   */
  async download(startUrl: string, dest: string, options: RequestOptions = {}): Promise<DownloadResult> {
    const queueOptions: EnqueueOptions = { ...options, timeoutMs: options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS };
    const tmp = `${dest}.part`;
    let url = this.assertAllowed(startUrl);
    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const out = await this.queue.enqueue(async (signal) => {
          const cookie = await this.jar.headerFor(url);
          const reqHeaders: Record<string, string> = {
            "User-Agent": USER_AGENT,
            ...options.headers,
            ...(cookie ? { Cookie: cookie } : {}),
          };
          try {
            const res = await this.fetchFn(url, { method: "GET", headers: reqHeaders, redirect: "manual", signal });
            await this.jar.storeFromResponse(url, res.headers.getSetCookie());
            const location = res.headers.get("location");
            if (res.status >= 300 && res.status < 400 && location) {
              await res.body?.cancel();
              return { location };
            }
            if (res.status >= 400) {
              await res.body?.cancel();
              throw new HttpStatusError(res.status, url);
            }
            const hash = createHash("sha256");
            let size = 0;
            const meter = new Transform({
              transform(chunk: Buffer, _enc, cb) {
                hash.update(chunk);
                size += chunk.length;
                cb(null, chunk);
              },
            });
            const body = res.body ? Readable.fromWeb(res.body as WebReadableStream) : Readable.from([]);
            await pipeline(body, meter, createWriteStream(tmp));
            const expected = res.headers.get("content-length");
            if (expected !== null && Number(expected) !== size) {
              throw new NetworkError(`다운로드 크기 불일치(${size}/${expected}바이트): ${url}`);
            }
            return { result: { size, sha256: hash.digest("hex"), headers: res.headers } };
          } catch (err) {
            if (err instanceof HttpStatusError || err instanceof NetworkError) throw err;
            throw new NetworkError(`다운로드 실패: ${url}`, { cause: err });
          }
        }, queueOptions);
        if (out.result) {
          await rename(tmp, dest);
          return out.result;
        }
        url = this.assertAllowed(new URL(out.location!, url).href);
        this.logger?.debug("redirect", url);
      }
      throw new NetworkError(`리다이렉트가 ${MAX_REDIRECTS}회를 초과했습니다: ${startUrl}`);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  private assertAllowed(url: string): string {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new HostNotAllowedError(url);
    }
    if (parsed.protocol !== "https:" || !this.allowedHosts.has(parsed.hostname)) {
      throw new HostNotAllowedError(url);
    }
    return parsed.href;
  }

  private async request(
    method: "GET" | "POST",
    startUrl: string,
    body: Body,
    headers: Record<string, string>,
    queueOptions: EnqueueOptions,
  ): Promise<HttpResponse> {
    const redirectChain: RedirectHop[] = [];
    let url = this.assertAllowed(startUrl);
    let curMethod = method;
    let curBody = body;
    let curHeaders = headers;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const raw = await this.sendOnce(curMethod, url, curBody, curHeaders, queueOptions);
      const location = raw.headers.get("location") ?? undefined;
      const isRedirect = raw.status >= 300 && raw.status < 400 && location !== undefined;
      redirectChain.push({ url, status: raw.status, ...(location !== undefined ? { location } : {}) });

      if (!isRedirect) {
        return {
          status: raw.status,
          finalUrl: url,
          headers: raw.headers,
          text: decodeBody(raw.body, raw.headers.get("content-type")),
          redirectChain,
        };
      }

      const next = this.assertAllowed(new URL(location, url).href);
      this.logger?.debug("redirect", raw.status, next);
      if (raw.status !== 307 && raw.status !== 308) {
        curMethod = "GET";
        curBody = undefined;
        curHeaders = Object.fromEntries(
          Object.entries(curHeaders).filter(([k]) => k.toLowerCase() !== "content-type"),
        );
      }
      url = next;
    }
    throw new NetworkError(`리다이렉트가 ${MAX_REDIRECTS}회를 초과했습니다: ${startUrl}`);
  }

  private sendOnce(
    method: string,
    url: string,
    body: Body,
    headers: Record<string, string>,
    queueOptions: EnqueueOptions,
  ): Promise<RawResponse> {
    return this.queue.enqueue(async (signal) => {
      const cookie = await this.jar.headerFor(url);
      const reqHeaders: Record<string, string> = {
        "User-Agent": USER_AGENT,
        ...headers,
        ...(cookie ? { Cookie: cookie } : {}),
      };
      let res: Response;
      let buf: ArrayBuffer;
      try {
        res = await this.fetchFn(url, { method, headers: reqHeaders, body, redirect: "manual", signal });
        await this.jar.storeFromResponse(url, res.headers.getSetCookie());
        buf = await res.arrayBuffer();
      } catch (err) {
        throw new NetworkError(`요청 실패: ${url}`, { cause: err });
      }
      if (res.status >= 400) throw new HttpStatusError(res.status, url);
      return { status: res.status, headers: res.headers, body: buf };
    }, queueOptions);
  }
}
