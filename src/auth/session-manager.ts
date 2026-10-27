import { loadConfig as defaultLoadConfig, type Config } from "../config/config.js";
import type { HttpClient, HttpResponse } from "../http/http-client.js";
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
   */
  async request(
    fn: (client: HttpClient) => Promise<HttpResponse>,
    options: { resend?: boolean } = {},
  ): Promise<HttpResponse> {
    await this.ensureLoggedIn();
    const gen = this.generation;
    const first = await fn(this.client);
    if (!isSessionExpired(first)) return first;

    // 동시 호출이 함께 만료를 만난 경우 한 번만 무효화한다.
    if (this.generation === gen) this.invalidate();
    if (options.resend === false) throw new WriteSessionLostError();
    await this.ensureLoggedIn();
    const second = await fn(this.client);
    if (isSessionExpired(second)) throw new SessionExpiredError();
    return second;
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
  }
}
