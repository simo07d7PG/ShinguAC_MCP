import { describe, expect, it } from "vitest";
import { AuthRejectedError, AuthUnsupportedError, SessionExpiredError } from "../../src/auth/errors.js";
import { SessionManager } from "../../src/auth/session-manager.js";
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
