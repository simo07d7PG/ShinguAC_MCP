import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../../src/server.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SENTINEL = "SENTINEL-PW-7c1e";

let home: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "shingu-server-"));
  for (const k of ["SHINGU_ID", "SHINGU_PW", "SHINGU_MCP_HOME"]) saved[k] = process.env[k];
  delete process.env["SHINGU_ID"];
  delete process.env["SHINGU_PW"];
  process.env["SHINGU_MCP_HOME"] = home;
});

afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true });
});

describe("자격증명 없이 기동한 서버", () => {
  it("tools/list는 동작하고, 도구 호출은 설정 안내가 담긴 isError를 반환한다", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // SHINGU_PW만 있는 경우: 비밀번호 원문이 메시지에 섞이면 안 된다.
    process.env["SHINGU_PW"] = SENTINEL;
    const server = createServer();
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);

    const { tools } = await client.listTools();
    expect(tools).toHaveLength(10);

    const res = (await client.callTool({ name: "get_assignments", arguments: {} })) as CallToolResult;
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("SHINGU_ID");
    expect(text).toContain(join(home, ".shingu-mcp", "config.json"));
    expect(text).not.toContain(SENTINEL);

    // 설정 실패는 캐시하지 않는다: 둘 다 없을 때도 같은 안내.
    delete process.env["SHINGU_PW"];
    const res2 = (await client.callTool({ name: "get_grades", arguments: {} })) as CallToolResult;
    expect(res2.isError).toBe(true);
    expect((res2.content[0] as { text: string }).text).toContain("config.json");
    await client.close();
  });
});

describe("stdio 프로세스", () => {
  it("initialize → tools/list 왕복, stdout에는 JSON-RPC만 나온다", async () => {
    const env = { ...process.env, SHINGU_MCP_HOME: home };
    delete env["SHINGU_ID"];
    delete env["SHINGU_PW"];
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: ROOT,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stderr.resume();

    const waitFor = (id: number): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`응답 대기 시간 초과: id=${id}\n${stdout}`)), 20_000);
        const onData = (chunk: string): void => {
          stdout += chunk;
          // 마지막 조각은 아직 덜 받은 줄일 수 있으므로 제외한다.
          for (const line of stdout.split("\n").slice(0, -1)) {
            if (!line.trim()) continue;
            const msg = JSON.parse(line) as Record<string, unknown>;
            if (msg["id"] === id) {
              clearTimeout(timer);
              child.stdout.off("data", onData);
              resolve(msg);
              return;
            }
          }
        };
        child.stdout.on("data", onData);
      });
    const send = (msg: unknown): void => {
      child.stdin.write(`${JSON.stringify(msg)}\n`);
    };

    try {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "spawn-test", version: "0" } },
      });
      const init = await waitFor(1);
      expect((init["result"] as { serverInfo: { name: string } }).serverInfo.name).toBe("shingu-mcp");

      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      const list = await waitFor(2);
      expect((list["result"] as { tools: unknown[] }).tools).toHaveLength(10);

      for (const line of stdout.split("\n").filter((l) => l.trim())) {
        expect((JSON.parse(line) as { jsonrpc: string }).jsonrpc).toBe("2.0");
      }
    } finally {
      child.kill();
    }
  }, 30_000);
});
