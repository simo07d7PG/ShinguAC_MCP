import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { ConfigError } from "../config/config.js";
import { logger } from "../log/logger.js";
import { redact } from "../log/redact.js";
import { MetaSchema, type Meta } from "../schema/index.js";
import type { Result } from "../service/category-service.js";

export const SOURCE_NOTE = "출처: 신구대학교 학생종합포털.";

/** 조회 도구 공통 출력: `{ data, fetchedAt }`. */
export function withMeta<T extends z.ZodType>(data: T) {
  return MetaSchema.extend({ data });
}

export function flatten<T>({ data, meta }: Result<T>): { data: T } & Meta {
  return { data, ...meta };
}

function userAction(err: unknown): string | undefined {
  const action = (err as { userAction?: unknown } | null)?.userAction;
  return typeof action === "string" ? action : undefined;
}

/** 사용자에게 보일 메시지. 인증 오류는 조치 안내를 덧붙인다(이미 포함돼 있으면 생략). */
function userMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const action = userAction(err);
  return action && !err.message.includes(action) ? `${err.message} ${action}` : err.message;
}

export function errorResult(err: unknown): CallToolResult {
  const text = redact(userMessage(err));
  if (err instanceof ConfigError || userAction(err)) logger.warn("도구 호출 실패", text);
  else logger.error("도구 호출 중 예기치 않은 오류", err instanceof Error ? (err.stack ?? err.message) : err);
  return { content: [{ type: "text", text }], isError: true };
}

/** 핸들러 실행 → structuredContent + 같은 JSON 텍스트. 오류는 isError 결과로 감싼다. */
export async function run(fn: () => Promise<Record<string, unknown>>): Promise<CallToolResult> {
  try {
    const structured = await fn();
    return { structuredContent: structured, content: [{ type: "text", text: JSON.stringify(structured) }] };
  } catch (err) {
    return errorResult(err);
  }
}
