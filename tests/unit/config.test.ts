import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError, loadConfig } from "../../src/config/config.js";
import { logger } from "../../src/log/logger.js";

const PW = "SENTINEL-PW-9f3a";
let home: string;

function writeConfigFile(content: string): string {
  const dir = join(home, ".shingu-mcp");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "config.json");
  writeFileSync(p, content);
  return p;
}

function catchErr(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "shingu-cfg-"));
  vi.stubEnv("SHINGU_MCP_HOME", home);
  vi.stubEnv("SHINGU_ID", "");
  vi.stubEnv("SHINGU_PW", "");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("env가 둘 다 있으면 env를 우선한다", () => {
    writeConfigFile(JSON.stringify({ id: "file-id", password: "file-pw" }));
    vi.stubEnv("SHINGU_ID", "env-id");
    vi.stubEnv("SHINGU_PW", PW);
    const c = loadConfig();
    expect(c.id).toBe("env-id");
    expect(c.password.reveal()).toBe(PW);
    expect(c.homeDir).toBe(join(home, ".shingu-mcp"));
    expect(c.snapshotsDir).toBe(join(home, ".shingu-mcp", "snapshots"));
  });

  it("env가 없으면 설정 파일로 fallback한다", () => {
    writeConfigFile(JSON.stringify({ id: "file-id", password: PW }));
    const c = loadConfig();
    expect(c.id).toBe("file-id");
    expect(c.password.reveal()).toBe(PW);
  });

  it("둘 다 없으면 env 이름, 파일 경로, JSON 예시를 담은 ConfigError", () => {
    const err = catchErr(() => loadConfig());
    expect(err).toBeInstanceOf(ConfigError);
    const msg = (err as Error).message;
    expect(msg).toContain("SHINGU_ID");
    expect(msg).toContain("SHINGU_PW");
    expect(msg).toContain(join(home, ".shingu-mcp", "config.json"));
    expect(msg).toContain('{"id":"학번","password":"비밀번호"}');
  });

  it("env가 하나만 있으면 파일로 보충하지 않고 ConfigError", () => {
    writeConfigFile(JSON.stringify({ id: "file-id", password: "file-pw" }));
    vi.stubEnv("SHINGU_ID", "env-id");
    expect(catchErr(() => loadConfig())).toBeInstanceOf(ConfigError);
    vi.stubEnv("SHINGU_ID", "");
    vi.stubEnv("SHINGU_PW", PW);
    const err = catchErr(() => loadConfig());
    expect(err).toBeInstanceOf(ConfigError);
    expect(String(err)).not.toContain(PW);
  });

  it("잘못된 JSON이면 ConfigError이고 파일 내용이 메시지에 없다", () => {
    const p = writeConfigFile(`{"id":"x","password":"${PW}"`);
    const err = catchErr(() => loadConfig());
    expect(err).toBeInstanceOf(ConfigError);
    expect(String(err)).toContain(p);
    expect(String(err)).not.toContain(PW);
  });

  it("스키마 불일치면 ConfigError이고 비밀번호가 메시지에 없다", () => {
    writeConfigFile(JSON.stringify({ id: 123, password: PW }));
    const err = catchErr(() => loadConfig());
    expect(err).toBeInstanceOf(ConfigError);
    expect(String(err)).not.toContain(PW);
  });

  it("비밀번호 원문은 JSON/inspect/String/로거 출력 어디에도 없다", () => {
    vi.stubEnv("SHINGU_ID", "env-id");
    vi.stubEnv("SHINGU_PW", PW);
    const c = loadConfig();
    expect(JSON.stringify(c)).not.toContain(PW);
    expect(inspect(c, { depth: 5 })).not.toContain(PW);
    expect(`${c.password}`).toBe("***");
    expect(String(c.password)).toBe("***");

    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    logger.info(`config loaded ${PW}`, c);
    logger.error("raw", { pw: PW });
    const written = err.mock.calls.map((x) => String(x[0])).join("");
    expect(written.length).toBeGreaterThan(0);
    expect(written).not.toContain(PW);
  });
});
