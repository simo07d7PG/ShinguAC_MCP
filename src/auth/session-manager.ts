import { loadConfig as defaultLoadConfig, type Config } from "../config/config.js";
import type { HttpClient, HttpResponse } from "../http/http-client.js";
import { postLectureEntry } from "../portal/eclass.js";
import { AuthRejectedError, SessionExpiredError, WriteSessionLostError } from "./errors.js";
import { isSessionExpired, login as defaultLogin } from "./sso-flow.js";

export interface SessionManagerOptions {
  client: HttpClient;
  loadConfig?: () => Config;
  login?: (client: HttpClient, id: string, password: string) => Promise<void>;
}

export class SessionManager {
  private readonly client: HttpClient;
  private readonly loadConfig: () => Config;
  private readonly loginFn: (client: HttpClient, id: string, password: string) => Promise<void>;
  private loggedIn = false;
  private generation = 0;
  private inflight: Promise<void> | null = null;
  private rejected: AuthRejectedError | null = null;
  /** 마지막으로 진입한 강의. 재로그인한 새 세션에는 "현재 강의"가 없어 다시 진입해야 한다. */
  private currentLecture: string | null = null;
  private needsLectureRestore = false;
  private restoreInflight: { gen: number; promise: Promise<void> } | null = null;

  constructor(options: SessionManagerOptions) {
    this.client = options.client;
    this.loadConfig = options.loadConfig ?? defaultLoadConfig;
    this.loginFn = options.login ?? defaultLogin;
  }

  invalidate(): void {
    this.loggedIn = false;
    this.generation++;
  }

  /**
   * 로그인 보장 후 요청. 세션 만료 응답이면 재로그인해 한 번 더 보낸다.
   * `resend: false`(제출 같은 비멱등 쓰기)면 다시 보내지 않고 `WriteSessionLostError`를 던진다.
   * `lectureScoped`(`/eclass/clas/...` 요청)면 로그인 직후 보내기 전에 마지막 강의에 다시 진입한다.
   * 그 밖의 요청(성적·시간표·공지·파일 등)은 재진입하지 않으므로 재진입 실패가 번지지 않는다.
   * `enterLecture`는 강의 진입 요청 자체 — 보내기 전에 현재 강의를 그 강의로 바꿔 두어,
   * 진입이 큐에 있는 동안 들어온 강의실 요청이 이전 강의로 재진입하지 않게 한다.
   */
  async request(
    fn: (client: HttpClient) => Promise<HttpResponse>,
    options: { resend?: boolean; lectureScoped?: boolean; enterLecture?: string } = {},
  ): Promise<HttpResponse> {
    const entry = options.enterLecture;
    if (entry === undefined) return this.send(fn, options.resend !== false, options.lectureScoped === true);
    try {
      return await this.send(fn, true, false, entry);
    } catch (err) {
      // 진입 여부를 알 수 없으므로 다음 강의실 요청이 다시 진입하게 한다.
      this.needsLectureRestore = true;
      throw err;
    }
  }

  private async send(
    fn: (client: HttpClient) => Promise<HttpResponse>,
    resend: boolean,
    lectureScoped: boolean,
    entry?: string,
  ): Promise<HttpResponse> {
    await this.prepare(lectureScoped, entry);
    const gen = this.generation;
    const first = await fn(this.client);
    if (!isSessionExpired(first)) return first;

    // 동시 호출이 함께 만료를 만난 경우 한 번만 무효화한다.
    if (this.generation === gen) this.invalidate();
    if (!resend) throw new WriteSessionLostError();
    await this.prepare(lectureScoped, entry);
    const second = await fn(this.client);
    if (isSessionExpired(second)) throw new SessionExpiredError();
    return second;
  }

  private async prepare(lectureScoped: boolean, entry: string | undefined): Promise<void> {
    await this.ensureLoggedIn();
    if (entry !== undefined) {
      // 진행 중인 재진입이 새 진입보다 늦게 도착해 현재 강의를 덮어쓰지 않게 기다린다.
      if (this.restoreInflight) await this.restoreInflight.promise.catch(() => undefined);
      this.currentLecture = entry;
      this.needsLectureRestore = false;
    } else if (lectureScoped) {
      await this.restoreLecture();
    }
  }

  /** 로그인 직후 마지막 강의에 다시 진입한다. 같은 로그인 세대의 동시 호출은 한 번의 요청을 공유한다. */
  private restoreLecture(): Promise<void> {
    const lectureSeq = this.currentLecture;
    if (!this.needsLectureRestore || lectureSeq === null) return Promise.resolve();
    const gen = this.generation;
    if (this.restoreInflight?.gen === gen) return this.restoreInflight.promise;
    // request()를 거치지 않는다(재귀·만료 재시도 없음, 1회).
    const promise = postLectureEntry(this.client, lectureSeq)
      .then((res) => {
        if (isSessionExpired(res)) {
          if (this.generation === gen) this.invalidate();
          throw new SessionExpiredError();
        }
        if (this.generation === gen && this.currentLecture === lectureSeq) this.needsLectureRestore = false;
      })
      .finally(() => {
        if (this.restoreInflight?.promise === promise) this.restoreInflight = null;
      });
    this.restoreInflight = { gen, promise };
    return promise;
  }

  private ensureLoggedIn(): Promise<void> {
    if (this.rejected) return Promise.reject(this.rejected);
    if (this.loggedIn) return Promise.resolve();
    this.inflight ??= this.doLogin().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doLogin(): Promise<void> {
    const config = this.loadConfig();
    try {
      await this.loginFn(this.client, config.id, config.password.reveal());
    } catch (err) {
      if (err instanceof AuthRejectedError) this.rejected = err;
      throw err;
    }
    this.loggedIn = true;
    this.needsLectureRestore = true;
  }
}
