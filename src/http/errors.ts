export class NetworkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NetworkError";
  }
}

export class TimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`요청이 ${timeoutMs}ms 안에 응답하지 않았습니다`);
    this.name = "TimeoutError";
  }
}

/**
 * 오류 메시지용 URL: 쿼리스트링을 뺀 origin + 경로. 첨부 키(`file_key` 등)는 쿠키 없이 파일을 받을 수 있는 값이라
 * 메시지·로그·DB에 남기지 않는다(원본은 오류 객체의 `url` 속성에만 둔다).
 */
export function urlForMessage(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "(잘못된 URL)";
  }
}

export class HttpStatusError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
  ) {
    super(`HTTP ${status}: ${urlForMessage(url)}`);
    this.name = "HttpStatusError";
  }
}

export class HostNotAllowedError extends Error {
  constructor(public readonly url: string) {
    super(`허용되지 않은 호스트입니다: ${urlForMessage(url)}`);
    this.name = "HostNotAllowedError";
  }
}

/** 호출한 쪽(도구 호출 취소 등)이 요청을 취소했다. 큐는 재시도하지 않고, HttpClient도 다른 오류로 감싸지 않는다. */
export class AbortError extends Error {
  constructor() {
    super("요청이 취소되었습니다");
    this.name = "AbortError";
  }
}
