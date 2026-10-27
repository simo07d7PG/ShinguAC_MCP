import { loadConfig as defaultLoadConfig, type Config } from "../config/config.js";
import type { HttpClient, HttpResponse } from "../http/http-client.js";
import { AuthRejectedError, SessionExpiredError, WriteSessionLostError } from "./errors.js";
import { PORTAL_ORIGIN } from "../portal/urls.js";
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

  /** `enterLecture` 성공 시 호출. 이 세션은 이미 그 강의에 들어가 있으므로 재진입이 필요 없다. */
  setCurrentLecture(lectureSeq: string): void {
    this.currentLecture = lectureSeq;
    this.needsLectureRestore = false;
  }

  /**
   * 로그인 보장 후 요청. 세션 만료 응답이면 재로그인해 한 번 더 보낸다.
   * `resend: false`(제출 같은 비멱등 쓰기)면 다시 보내지 않고 `WriteSessionLostError`를 던진다.
   * 로그인 직후에는 보내기 전에 마지막 강의에 다시 진입한다(`skipLectureRestore`면 건너뜀 — 진입 요청 자체).
   */
  async request(
    fn: (client: HttpClient) => Promise<HttpResponse>,
    options: { resend?: boolean; skipLectureRestore?: boolean } = {},
  ): Promise<HttpResponse> {
    await this.prepare(options.skipLectureRestore === true);
    const gen = this.generation;
    const first = await fn(this.client);
    if (!isSessionExpired(first)) return first;

    // 동시 호출이 함께 만료를 만난 경우 한 번만 무효화한다.
    if (this.generation === gen) this.invalidate();
    if (options.resend === false) throw new WriteSessionLostError();
    await this.prepare(options.skipLectureRestore === true);
    const second = await fn(this.client);
    if (isSessionExpired(second)) throw new SessionExpiredError();
    return second;
  }

  private async prepare(skipLectureRestore: boolean): Promise<void> {
    await this.ensureLoggedIn();
    if (!skipLectureRestore) {
      await this.restoreLecture();
    } else if (this.restoreInflight) {
      // 진행 중인 재진입이 새 진입보다 늦게 도착해 현재 강의를 덮어쓰지 않게 기다린다.
      await this.restoreInflight.promise.catch(() => undefined);
    }
  }

  /** 로그인 직후 마지막 강의에 다시 진입한다. 같은 로그인 세대의 동시 호출은 한 번의 요청을 공유한다. */
  private restoreLecture(): Promise<void> {
    const lectureSeq = this.currentLecture;
    if (!this.needsLectureRestore || lectureSeq === null) return Promise.resolve();
    const gen = this.generation;
    if (this.restoreInflight?.gen === gen) return this.restoreInflight.promise;
    // request()를 거치지 않는다(재귀·만료 재시도 없음, 1회).
    const promise = this.client
      .postForm(`${PORTAL_ORIGIN}/eclass/clas/home`, { lectureSeq, redirect: "" })
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
