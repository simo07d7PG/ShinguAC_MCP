import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";
import { shinguHomeDir } from "../config/config.js";
import type { UploadFile } from "../portal/submit.js";

/** 한 번에 메모리로 읽을 최대 크기. 포털 쪽 실제 한도는 확인되지 않았다. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/** 포털 업로드 위젯 설정값(`maxFileSize: 999000`). 넘으면 경고만 한다. */
export const PORTAL_WIDGET_MAX_BYTES = 999_000;

const MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".hwp": "application/x-hwp",
  ".hwpx": "application/haansofthwpx",
  ".zip": "application/zip",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".txt": "text/plain",
};

/** 비밀이 담기는 확장자·파일 이름. */
const SECRET_EXT = new Set([
  ".env", ".pem", ".key", ".p12", ".pfx", ".ppk", ".kdbx", ".keychain", ".ovpn", ".gpg", ".jks", ".keystore",
]);
const SECRET_NAME = /^(id_(rsa|dsa|ecdsa|ed25519)|credentials?|login data|cookies|local state)(\..*)?$/i;

export interface LoadedFile extends UploadFile {
  /** 링크를 풀어 낸 실제 경로. 미리보기에 보여 어느 파일이 올라가는지 확인받는다. */
  path: string;
  size: number;
  /** 내용 SHA-256(hex). 미리보기 토큰에 묶어 승인 후 파일이 바뀌면 제출하지 않는다. */
  sha256: string;
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.startsWith(sep));
}

/** UNC(`\\host\share`, `//host`)·장치 경로(`\\?\`, `\\.\`). 열기만 해도 원격 접속(NTLM 인증)이 일어날 수 있다. */
function isRemoteOrDevice(p: string): boolean {
  return /^[\\/]{2}/.test(p);
}

function reject(path: string): never {
  throw new Error(`이 파일은 보안상 첨부할 수 없습니다: ${path}`);
}

/**
 * 제출할 로컬 파일을 읽는다. 과제 본문 같은 외부 데이터가 비밀 파일 첨부를 유도할 수 있으므로 거부한다:
 * 원격·장치 경로(파일시스템 접근 전), 숨김 경로 구성요소(`.ssh`, `.aws`, `.env` 등)·`AppData`,
 * 자격증명 디렉터리(`.shingu-mcp`, `SHINGU_MCP_HOME` 포함), 비밀 확장자·이름.
 */
export async function loadUploadFile(path: string): Promise<LoadedFile> {
  if (isRemoteOrDevice(path)) reject(path);
  if (process.platform === "win32" ? !/^[A-Za-z]:[\\/]/.test(path) : !isAbsolute(path)) {
    throw new Error(`file_path는 로컬 절대 경로여야 합니다: ${path}`);
  }
  let real: string;
  try {
    real = await realpath(path);
  } catch {
    throw new Error(`첨부 파일을 찾을 수 없습니다: ${path}`);
  }
  if (isRemoteOrDevice(real)) reject(path);
  const denied = [shinguHomeDir(), join(homedir(), ".shingu-mcp")];
  const parts = real.split(/[\\/]+/).filter(Boolean);
  const name = basename(real);
  if (
    denied.some((d) => isInside(real, d)) ||
    parts.some((p) => p.startsWith(".") || p.toLowerCase() === "appdata") ||
    SECRET_EXT.has(extname(name).toLowerCase()) ||
    SECRET_NAME.test(name)
  ) {
    reject(path);
  }
  const info = await stat(real);
  if (!info.isFile()) throw new Error(`첨부 대상이 파일이 아닙니다: ${path}`);
  if (info.size === 0) throw new Error(`빈 파일은 첨부할 수 없습니다: ${path}`);
  if (info.size > MAX_UPLOAD_BYTES) {
    throw new Error(`첨부 파일이 너무 큽니다(${info.size}바이트, 최대 ${MAX_UPLOAD_BYTES}바이트): ${path}`);
  }
  const data = new Uint8Array(await readFile(real));
  return {
    name,
    path: real,
    type: MIME[extname(name).toLowerCase()] ?? "application/octet-stream",
    data,
    size: info.size,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}
