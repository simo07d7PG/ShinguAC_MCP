import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { registerSecret } from "../log/redact.js";
import { Secret } from "./secret.js";

export interface Config {
  id: string;
  password: Secret;
  /** `<home>/.shingu-mcp` */
  homeDir: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const FileSchema = z.object({
  id: z.string().min(1),
  password: z.string().min(1),
});

function guide(configPath: string): string {
  return (
    `환경변수 SHINGU_ID, SHINGU_PW를 모두 설정하거나, 설정 파일 ${configPath} 을(를) 만들어 주세요. ` +
    `예시: {"id":"학번","password":"비밀번호"}`
  );
}

/** 자격증명·데이터 디렉터리(`<SHINGU_MCP_HOME 또는 홈>/.shingu-mcp`). */
export function shinguHomeDir(): string {
  return join(process.env["SHINGU_MCP_HOME"] || homedir(), ".shingu-mcp");
}

export function loadConfig(): Config {
  const homeDir = shinguHomeDir();
  const configPath = join(homeDir, "config.json");

  const envId = process.env["SHINGU_ID"];
  const envPw = process.env["SHINGU_PW"];

  if (envId && envPw) {
    registerSecret(envPw);
    return { id: envId, password: new Secret(envPw), homeDir };
  }
  if (envId || envPw) {
    const missing = envId ? "SHINGU_PW" : "SHINGU_ID";
    throw new ConfigError(
      `환경변수 ${missing}가 설정되지 않았습니다. SHINGU_ID와 SHINGU_PW는 함께 설정해야 합니다. ${guide(configPath)}`,
    );
  }

  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch {
    throw new ConfigError(`자격증명을 찾을 수 없습니다. ${guide(configPath)}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    // 원본 SyntaxError 메시지에는 파일 내용 일부가 포함될 수 있어 사용하지 않는다.
    throw new ConfigError(`설정 파일 ${configPath} 이(가) 올바른 JSON이 아닙니다. ${guide(configPath)}`);
  }

  const parsed = FileSchema.safeParse(json);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))].join(", ");
    throw new ConfigError(
      `설정 파일 ${configPath} 의 형식이 올바르지 않습니다 (문제 필드: ${fields}). ${guide(configPath)}`,
    );
  }

  registerSecret(parsed.data.password);
  return { id: parsed.data.id, password: new Secret(parsed.data.password), homeDir };
}
