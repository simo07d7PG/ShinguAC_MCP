import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpStatusError, TimeoutError } from "../../src/http/errors.js";
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
});
