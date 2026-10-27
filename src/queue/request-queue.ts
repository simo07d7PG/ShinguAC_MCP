import { AbortError, HttpStatusError, NetworkError, TimeoutError } from "../http/errors.js";

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
  /** 바깥 취소 신호. 대기 중에 abort되면 시작하지 않고, 실행 중이면 요청을 끊는다. 어느 쪽이든 AbortError(재시도 없음). */
  signal?: AbortSignal;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryable(err: unknown): boolean {
  if (err instanceof NetworkError || err instanceof TimeoutError) return true;
  return err instanceof HttpStatusError && err.status >= 500;
}

/** 이미 abort됐거나 abort되면 AbortError로 거부되는 promise와 리스너 해제 함수. */
function abortPromise(signal: AbortSignal | undefined, onAbort?: () => void): { promise: Promise<never>; dispose: () => void } {
  if (!signal) return { promise: new Promise<never>(() => {}), dispose: () => {} };
  let listener: (() => void) | undefined;
  const promise = new Promise<never>((_, reject) => {
    listener = () => {
      // 먼저 거부해 두어야 끊긴 요청의 NetworkError보다 AbortError가 앞선다.
      reject(new AbortError());
      onAbort?.();
    };
    if (signal.aborted) listener();
    else signal.addEventListener("abort", listener, { once: true });
  });
  return { promise, dispose: () => listener && signal.removeEventListener("abort", listener) };
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
    const { signal } = options;
    const run = this.tail.then(() =>
      this.execute(fn, options.retries ?? this.maxRetries, options.timeoutMs ?? this.timeoutMs, signal),
    );
    this.tail = run.catch(() => undefined);
    if (!signal) return run;
    // 대기 중 abort: 호출자는 바로 AbortError를 받고, 차례가 와도 fn은 실행하지 않는다(execute에서 확인).
    const aborted = abortPromise(signal);
    return Promise.race([run, aborted.promise]).finally(aborted.dispose);
  }

  private async execute<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    maxRetries: number,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw new AbortError();
      await this.waitGap();
      if (signal?.aborted) throw new AbortError();
      try {
        return await this.runOnce(fn, timeoutMs, signal);
      } catch (err) {
        if (signal?.aborted) throw new AbortError();
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

  private async runOnce<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new TimeoutError(timeoutMs));
      }, timeoutMs);
    });
    const aborted = abortPromise(signal, () => controller.abort());
    try {
      return await Promise.race([fn(controller.signal), timeout, aborted.promise]);
    } finally {
      clearTimeout(timer);
      aborted.dispose();
    }
  }
}

export const requestQueue = new RequestQueue();
/** 첨부 다운로드 전용 큐. 조회 큐와 따로 돌아 다운로드 중에도 조회 도구가 진행된다(포털 동시 요청 최대 2). */
export const downloadRequestQueue = new RequestQueue();
