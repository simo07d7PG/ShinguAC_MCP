import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../src/log/logger.js";
import { redact, registerSecret } from "../../src/log/redact.js";

const PW = "SENTINEL-PW-9f3a";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("redact", () => {
  it("전달된 비밀 원문을 마스킹한다", () => {
    expect(redact(`pw is ${PW}!`, [PW])).toBe("pw is ***!");
  });

  it("password= 파라미터를 마스킹한다", () => {
    expect(redact("userId=2024&password=abc123&x=1")).toBe("userId=2024&password=***&x=1");
  });

  it("Cookie / Set-Cookie 값을 마스킹한다", () => {
    expect(redact("Cookie: JSESSIONID=abc; foo=bar")).toBe("Cookie: ***");
    expect(redact("Set-Cookie: sid=zzz; Path=/")).toBe("Set-Cookie: ***");
  });

  it("첨부 키(file_key·fileKey·fileMasterKey)를 마스킹한다", () => {
    const out = redact(
      "다운로드 실패: https://cec.shingu.ac.kr/01shingu/eClassDown.jsp?file_key=20261020-abc /file/download?fileKey=k1&x=1 fileMasterKey=m2",
    );
    expect(out).not.toMatch(/20261020-abc|k1|m2/);
    expect(out).toContain("file_key=***");
    expect(out).toContain("&x=1");
  });

  it("jsessionid / access_token / refresh_token을 마스킹한다", () => {
    expect(redact("/a;jsessionid=ABC123?x=1")).not.toContain("ABC123");
    const out = redact("access_token=AAA&refresh_token=BBB");
    expect(out).not.toContain("AAA");
    expect(out).not.toContain("BBB");
  });

  it("registerSecret으로 등록한 값은 전역 마스킹된다", () => {
    registerSecret("GLOBAL-SECRET-1");
    expect(redact("x GLOBAL-SECRET-1 y")).toBe("x *** y");
  });
});

describe("logger", () => {
  it("stderr로만 출력하고 비밀을 마스킹한다", () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    registerSecret(PW);
    logger.info(`login ${PW}`, { password: PW, note: `x ${PW}` });
    expect(out).not.toHaveBeenCalled();
    const written = err.mock.calls.map((c) => String(c[0])).join("");
    expect(written).toContain("login");
    expect(written).not.toContain(PW);
  });

  it("SHINGU_MCP_LOG 레벨 미만은 출력하지 않는다", () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    vi.stubEnv("SHINGU_MCP_LOG", "error");
    logger.info("hidden");
    logger.warn("hidden");
    expect(err).not.toHaveBeenCalled();
    logger.error("shown");
    expect(err).toHaveBeenCalledTimes(1);
  });

  it("기본 레벨은 info (debug 숨김)", () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    vi.stubEnv("SHINGU_MCP_LOG", "");
    logger.debug("d");
    expect(err).not.toHaveBeenCalled();
    logger.info("i");
    expect(err).toHaveBeenCalledTimes(1);
  });
});
