import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SessionManager } from "./auth/session-manager.js";
import { loadConfig } from "./config/config.js";
import { HttpClient } from "./http/http-client.js";
import { logger } from "./log/logger.js";
import { redact } from "./log/redact.js";
import { CategoryService } from "./service/category-service.js";
import { ArchiveDb } from "./store/archive-db.js";

import { registerAllTools, type ToolService } from "./tools/index.js";

// src/server.ts(tsx)와 dist/server.js 모두 한 단계 위가 패키지 루트다.
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

function createDefaultService(): CategoryService {
  const config = loadConfig();
  const client = new HttpClient();
  const session = new SessionManager({ client, loadConfig: () => config });
  // 아카이브 DB를 못 열어도(잠김·권한) 조회·제출 도구는 동작하게 하고 sync_eclass만 실패시킨다.
  try {
    const archive = { db: new ArchiveDb(config.dbPath), dbPath: config.dbPath, filesDir: config.filesDir };
    return new CategoryService({ session, client, archive });
  } catch (err) {
    const why = redact(err instanceof Error ? err.message : String(err));
    logger.warn("E클래스 아카이브 DB를 열지 못했습니다", why);
    return new CategoryService({ session, client, archiveError: `E클래스 아카이브 DB(${config.dbPath})를 열지 못했습니다: ${why}` });
  }
}

/**
 * 도구를 등록한 MCP 서버를 만든다. 설정·서비스는 첫 도구 호출 때 만들므로 자격증명 없이도 기동·tools/list가 된다.
 * 설정 로드가 실패하면(ConfigError) 캐시하지 않아, 사용자가 설정을 고친 뒤 다음 호출에서 다시 시도된다.
 */
export function createServer(deps: { service?: ToolService } = {}): McpServer {
  const server = new McpServer({ name: "shingu-mcp", version });
  let service = deps.service;
  registerAllTools(server, () => (service ??= createDefaultService()));
  return server;
}
