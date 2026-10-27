import { HttpStatusError, NetworkError, TimeoutError } from "../http/errors.js";

export interface RequestQueueOptions {
  minGapMs?: number;
  timeoutMs?: number;
  maxRetries?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** 요청별 재정의. 제출처럼 멱등이 아닌 요청은 `retries: 0`으로 중복 전송을 막는다. */
export interface EnqueueOptions {
  retries?: number;
  timeoutMs?: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryable(err: unknown): boolean {
  if (err instanceof NetworkError || err instanceof TimeoutError) return true;
  return err instanceof HttpStatusError && err.status >= 500;
}

/** 동시 실행 1, 이전 요청 완료 + minGapMs 이후 시작, 전송 실패 시 최대 maxRetries회 재시도. */
export class RequestQueue {
  private readonly minGapMs: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private tail: Promise<unknown> = Promise.resolve();
  private lastFinishedAt: number | null = null;

  constructor(options: RequestQueueOptions = {}) {
    this.minGapMs = options.minGapMs ?? 200;
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.maxRetries = options.maxRetries ?? 1;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  enqueue<T>(fn: (signal: AbortSignal) => Promise<T>, options: EnqueueOptions = {}): Promise<T> {
    const run = this.tail.then(() =>
      this.execute(fn, options.retries ?? this.maxRetries, options.timeoutMs ?? this.timeoutMs),
    );
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async execute<T>(fn: (signal: AbortSignal) => Promise<T>, maxRetries: number, timeoutMs: number): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.waitGap();
      try {
        return await this.runOnce(fn, timeoutMs);
      } catch (err) {
        if (attempt < maxRetries && isRetryable(err)) continue;
        throw err;
      } finally {
        this.lastFinishedAt = this.now();
      }
    }
  }

  private async waitGap(): Promise<void> {
    if (this.lastFinishedAt === null) return;
    const wait = this.lastFinishedAt + this.minGapMs - this.now();
    if (wait > 0) await this.sleep(wait);
  }

  private async runOnce<T>(fn: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new TimeoutError(timeoutMs));
      }, timeoutMs);
    });
    try {
      return await Promise.race([fn(controller.signal), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}

export const requestQueue = new RequestQueue();
