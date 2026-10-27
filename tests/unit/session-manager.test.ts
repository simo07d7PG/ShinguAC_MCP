import { describe, expect, it } from "vitest";
import {
  AuthRejectedError,
  AuthUnsupportedError,
  SessionExpiredError,
  WriteSessionLostError,
} from "../../src/auth/errors.js";
import { SessionManager } from "../../src/auth/session-manager.js";
import { HttpClient } from "../../src/http/http-client.js";
import { enterLecture } from "../../src/portal/eclass.js";
import { RequestQueue } from "../../src/queue/request-queue.js";
import { Secret } from "../../src/config/secret.js";
import { ConfigError, type Config } from "../../src/config/config.js";
import { registerSecret } from "../../src/log/redact.js";
import { createPortalMock, dashboardGet } from "../helpers/portal-mock.js";

const SENTINEL_PW = "S3ntinel-PW-do-not-leak";
registerSecret(SENTINEL_PW);

const config = (): Config => ({
  id: "2000000000",
  password: new Secret(SENTINEL_PW),
  homeDir: "/h",
});

function setup(options: Parameters<typeof createPortalMock>[0] = {}) {
  const mock = createPortalMock(options);
  const manager = new SessionManager({ client: mock.client, loadConfig: config });
  return { mock, manager };
}

describe("SessionManager", () => {
  it("첫 요청에서 로그인하고 두 번째 요청은 로그인 없이 재사용한다", async () => {
    const { mock, manager } = setup();
    const r1 = await manager.request(dashboardGet);
    expect(r1.status).toBe(200);
    expect(mock.loginCount).toBe(1);
    const before = mock.requests.length;
    await manager.request(dashboardGet);
    expect(mock.requests.length).toBe(before + 1);
    expect(mock.loginCount).toBe(1);
  });

  it("세션이 한 번 만료되면 재로그인 후 성공한다", async () => {
    const { mock, manager } = setup();
    await manager.request(dashboardGet);
    mock.expireSession();
    const res = await manager.request(dashboardGet);
    expect(res.status).toBe(200);
    expect(mock.loginCount).toBe(2);
  });

  it("재로그인 후에도 만료면 SessionExpiredError", async () => {
    const { manager } = setup();
    const err = await manager
      .request(async (client) => client.get("https://student.shingu.ac.kr/notlogin/t"))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionExpiredError);
    expect(String(err)).not.toContain(SENTINEL_PW);
  });

  it("자격증명 거부 시 AuthRejectedError, 이후 호출은 로그인 fetch 없이 같은 에러", async () => {
    const { mock, manager } = setup({ rejectCredentials: true });
    const e1 = await manager.request(dashboardGet).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(AuthRejectedError);
    const count = mock.fetchMock.mock.calls.length;
    const e2 = await manager.request(dashboardGet).catch((e: unknown) => e);
    expect(e2).toBe(e1);
    expect(mock.fetchMock.mock.calls.length).toBe(count);
    for (const e of [e1, e2]) {
      expect((e as Error).message).not.toContain(SENTINEL_PW);
      expect(String(e)).not.toContain(SENTINEL_PW);
    }
  });

  it("userGb가 학생이 아니면 AuthUnsupportedError", async () => {
    const { manager } = setup({ userGb: "1" });
    const err = await manager.request(dashboardGet).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthUnsupportedError);
    expect(String(err)).not.toContain(SENTINEL_PW);
  });

  it("동시 3호출은 로그인을 한 번만 수행한다", async () => {
    const { mock, manager } = setup();
    const results = await Promise.all([
      manager.request(dashboardGet),
      manager.request(dashboardGet),
      manager.request(dashboardGet),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(mock.loginCount).toBe(1);
  });

  it("설정 로드 실패는 ConfigError로 그대로 전파된다", async () => {
    const mock = createPortalMock();
    const manager = new SessionManager({
      client: mock.client,
      loadConfig: () => {
        throw new ConfigError("자격증명을 찾을 수 없습니다.");
      },
    });
    await expect(manager.request(dashboardGet)).rejects.toBeInstanceOf(ConfigError);
    expect(mock.fetchMock).not.toHaveBeenCalled();
  });

  it("invalidate() 후 다음 요청은 다시 로그인한다", async () => {
    const { mock, manager } = setup();
    await manager.request(dashboardGet);
    manager.invalidate();
    mock.expireSession();
    await manager.request(dashboardGet);
    expect(mock.loginCount).toBe(2);
  });
});

const CLAS = "https://student.shingu.ac.kr/eclass/clas";

/**
 * portal-mock에 E클래스 강의실을 얹는다. 포털처럼 "현재 강의"를 세션에 두고, 새 로그인(ssoLogin)이면 비운다.
 * `log`에는 로그인 완료와 강의실 요청이 순서대로 남는다.
 */
function setupEclass() {
  const mock = createPortalMock();
  const log: string[] = [];
  let valid = false;
  let lecture: string | null = null;
  let restoreExpires = false;
  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.pathname.startsWith("/eclass/")) {
      const body = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
      log.push(`${method} ${url.pathname}${body.get("lectureSeq") ? ` ${body.get("lectureSeq")}` : ""}`);
      if (!valid || (restoreExpires && url.pathname === "/eclass/clas/home")) {
        return new Response(null, { status: 302, headers: { location: "/notlogin/t" } });
      }
      if (url.pathname === "/eclass/clas/home") lecture = body.get("lectureSeq");
      return new Response(`lecture=${lecture ?? "none"}`, { status: 200, headers: { "content-type": "text/html" } });
    }
    const res = await mock.fetchMock(input, init);
    if (url.pathname === "/ssoLogin") {
      valid = true;
      lecture = null;
      log.push("login");
    }
    return res;
  };
  const client = new HttpClient({ fetch: fetchFn as typeof fetch, queue: new RequestQueue({ minGapMs: 0 }) });
  const manager = new SessionManager({ client, loadConfig: config });
  return {
    mock,
    log,
    manager,
    expire: (): void => {
      valid = false;
      mock.expireSession();
    },
    expireRestore: (): void => {
      restoreExpires = true;
    },
  };
}

const homeworkGet = (client: HttpClient) => client.get(`${CLAS}/room/homework/homeworkList`);

describe("SessionManager 강의 재진입", () => {
  it("만료 → 재로그인 → 강의 재진입 → 원 요청 재전송 순서", async () => {
    const { log, manager, expire } = setupEclass();
    await enterLecture(manager, "L1");
    expire();
    log.length = 0;
    const res = await manager.request(homeworkGet);
    expect(res.text).toBe("lecture=L1");
    expect(log).toEqual([
      "GET /eclass/clas/room/homework/homeworkList",
      "login",
      "POST /eclass/clas/home L1",
      "GET /eclass/clas/room/homework/homeworkList",
    ]);
  });

  it("다른 요청이 세션을 무효화한 뒤 들어온 강의실 요청도 먼저 재진입한다", async () => {
    const { log, manager, expire } = setupEclass();
    await enterLecture(manager, "L1");
    expire();
    manager.invalidate();
    log.length = 0;
    const res = await manager.request(homeworkGet);
    expect(res.text).toBe("lecture=L1");
    expect(log).toEqual(["login", "POST /eclass/clas/home L1", "GET /eclass/clas/room/homework/homeworkList"]);
  });

  it("재로그인 뒤 동시 호출은 재진입을 한 번만 보낸다", async () => {
    const { log, manager, expire } = setupEclass();
    await enterLecture(manager, "L1");
    expire();
    manager.invalidate();
    log.length = 0;
    const results = await Promise.all([manager.request(homeworkGet), manager.request(homeworkGet), manager.request(homeworkGet)]);
    expect(results.map((r) => r.text)).toEqual(["lecture=L1", "lecture=L1", "lecture=L1"]);
    expect(log.filter((l) => l.startsWith("POST /eclass/clas/home"))).toEqual(["POST /eclass/clas/home L1"]);
    expect(log.filter((l) => l === "login")).toHaveLength(1);
  });

  it("강의에 진입한 적이 없으면 재진입하지 않는다", async () => {
    const { log, manager, expire } = setupEclass();
    await manager.request(dashboardGet);
    expire();
    const res = await manager.request(homeworkGet);
    expect(res.text).toBe("lecture=none");
    expect(log.some((l) => l.startsWith("POST /eclass/clas/home"))).toBe(false);
  });

  it("enterLecture 자신의 요청은 재진입을 일으키지 않는다", async () => {
    const { log, manager, expire } = setupEclass();
    await enterLecture(manager, "L1");
    expire();
    log.length = 0;
    await enterLecture(manager, "L2");
    expect(log).toEqual(["POST /eclass/clas/home L2", "login", "POST /eclass/clas/home L2"]);
    log.length = 0;
    const res = await manager.request(homeworkGet);
    expect(res.text).toBe("lecture=L2");
    expect(log).toEqual(["GET /eclass/clas/room/homework/homeworkList"]);
  });

  it("재진입 응답도 만료면 SessionExpiredError", async () => {
    const { manager, expire, expireRestore } = setupEclass();
    await enterLecture(manager, "L1");
    expire();
    expireRestore();
    const err = await manager.request(homeworkGet).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionExpiredError);
  });

  it("resend:false 쓰기는 만료 시 재전송 없이 WriteSessionLostError", async () => {
    const { log, manager, expire } = setupEclass();
    await enterLecture(manager, "L1");
    expire();
    log.length = 0;
    const write = (client: HttpClient) => client.postForm(`${CLAS}/room/homework/submit`, { a: "1" });
    const err = await manager.request(write, { resend: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WriteSessionLostError);
    expect(log).toEqual(["POST /eclass/clas/room/homework/submit"]);
  });
});
