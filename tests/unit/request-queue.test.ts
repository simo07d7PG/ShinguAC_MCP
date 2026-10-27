import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AbortError, HttpStatusError, NetworkError, TimeoutError } from "../../src/http/errors.js";
import { RequestQueue } from "../../src/queue/request-queue.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("RequestQueue", () => {
  it("5개 동시 enqueue: 동시성 1, 시작은 이전 완료 + 200ms 이후", async () => {
    const q = new RequestQueue();
    let running = 0;
    let maxRunning = 0;
    const starts: number[] = [];
    const ends: number[] = [];
    const task = async () => {
      starts.push(Date.now());
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 100));
      running--;
      ends.push(Date.now());
    };
    const all = Promise.all(Array.from({ length: 5 }, () => q.enqueue(task)));
    await vi.advanceTimersByTimeAsync(10_000);
    await all;
    expect(maxRunning).toBe(1);
    expect(starts).toHaveLength(5);
    for (let i = 1; i < 5; i++) {
      expect(starts[i]! - ends[i - 1]!).toBeGreaterThanOrEqual(200);
    }
  });

  it("15초 미응답: TimeoutError, 1회 재시도(총 2회 호출)", async () => {
    const q = new RequestQueue();
    const fn = vi.fn(() => new Promise<never>(() => {}));
    const result = q.enqueue(fn).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(15_000 + 200 + 15_000);
    expect(await result).toBeInstanceOf(TimeoutError);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries: 0이면 전송 실패해도 재시도하지 않는다(제출 POST용)", async () => {
    const q = new RequestQueue();
    const fn = vi.fn(() => new Promise<never>(() => {}));
    const result = q.enqueue(fn, { retries: 0 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(15_000 + 200 + 15_000);
    expect(await result).toBeInstanceOf(TimeoutError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("timeoutMs로 요청별 타임아웃을 늘린다(업로드용)", async () => {
    const q = new RequestQueue();
    let settled = false;
    const result = q
      .enqueue(() => new Promise<never>(() => {}), { retries: 0, timeoutMs: 60_000 })
      .catch((e: unknown) => e)
      .finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await result).toBeInstanceOf(TimeoutError);
  });

  it("5xx 후 200: 성공, 2회 호출", async () => {
    const q = new RequestQueue();
    const fn = vi
      .fn<(s: AbortSignal) => Promise<string>>()
      .mockRejectedValueOnce(new HttpStatusError(503, "https://x"))
      .mockResolvedValueOnce("ok");
    const result = q.enqueue(fn);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("4xx: 재시도 없이 HttpStatusError, 1회 호출", async () => {
    const q = new RequestQueue();
    const fn = vi.fn().mockRejectedValue(new HttpStatusError(404, "https://x"));
    const result = q.enqueue(fn).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2_000);
    const err = await result;
    expect(err).toBeInstanceOf(HttpStatusError);
    expect((err as HttpStatusError).status).toBe(404);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("이미 취소된 signal: fn을 실행하지 않고 AbortError", async () => {
    const q = new RequestQueue();
    const ac = new AbortController();
    ac.abort();
    const fn = vi.fn(async () => "x");
    const result = q.enqueue(fn, { signal: ac.signal }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toBeInstanceOf(AbortError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("대기 중 취소: 바로 AbortError, 차례가 와도 실행하지 않고 다음 요청은 진행", async () => {
    const q = new RequestQueue();
    const ac = new AbortController();
    const first = q.enqueue(() => new Promise<string>((r) => setTimeout(() => r("a"), 1_000)));
    const fn = vi.fn(async () => "b");
    const second = q.enqueue(fn, { signal: ac.signal }).catch((e: unknown) => e);
    const third = q.enqueue(async () => "c");
    await vi.advanceTimersByTimeAsync(100);
    ac.abort();
    expect(await second).toBeInstanceOf(AbortError);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await first).toBe("a");
    expect(await third).toBe("c");
    expect(fn).not.toHaveBeenCalled();
  });

  it("실행 중 취소: 내부 signal을 끊고 재시도 없이 AbortError(감싸지 않음)", async () => {
    const q = new RequestQueue({ maxRetries: 3 });
    const ac = new AbortController();
    let inner: AbortSignal | undefined;
    const fn = vi.fn(
      (signal: AbortSignal) =>
        new Promise<never>((_, reject) => {
          inner = signal;
          // fetch처럼 끊기면 전송 실패로 거부한다(재시도 대상 오류).
          signal.addEventListener("abort", () => reject(new NetworkError("aborted")));
        }),
    );
    const result = q.enqueue(fn, { signal: ac.signal }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(100);
    ac.abort();
    await vi.advanceTimersByTimeAsync(5_000);
    const err = await result;
    expect(err).toBeInstanceOf(AbortError);
    expect((err as Error).message).toBe("요청이 취소되었습니다");
    expect(inner?.aborted).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
