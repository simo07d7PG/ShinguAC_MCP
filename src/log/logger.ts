import { inspect } from "node:util";
import { redact } from "./redact.js";

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function currentLevel(): Level {
  const v = process.env["SHINGU_MCP_LOG"]?.toLowerCase();
  return v === "debug" || v === "info" || v === "warn" || v === "error" ? v : "info";
}

function write(level: Level, msg: string, meta?: unknown): void {
  if (ORDER[level] < ORDER[currentLevel()]) return;
  let line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${msg}`;
  if (meta !== undefined) {
    line += ` ${typeof meta === "string" ? meta : inspect(meta, { depth: 4, breakLength: Infinity })}`;
  }
  // stdout은 MCP 프로토콜 전용이므로 stderr만 사용한다.
  process.stderr.write(`${redact(line)}\n`);
}

export const logger = {
  debug: (msg: string, meta?: unknown): void => write("debug", msg, meta),
  info: (msg: string, meta?: unknown): void => write("info", msg, meta),
  warn: (msg: string, meta?: unknown): void => write("warn", msg, meta),
  error: (msg: string, meta?: unknown): void => write("error", msg, meta),
};
