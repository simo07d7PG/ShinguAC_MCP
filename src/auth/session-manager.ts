import { loadConfig as defaultLoadConfig, type Config } from "../config/config.js";
import type { HttpClient, HttpResponse } from "../http/http-client.js";
import { AuthRejectedError, SessionExpiredError } from "./errors.js";
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

  async request(fn: (client: HttpClient) => Promise<HttpResponse>): Promise<HttpResponse> {
    await this.ensureLoggedIn();
    const gen = this.generation;
    const first = await fn(this.client);
    if (!isSessionExpired(first)) return first;

    // 동시 호출이 함께 만료를 만난 경우 한 번만 무효화한다.
    if (this.generation === gen) this.invalidate();
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
