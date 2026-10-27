/** 비동기 상호 배제. 앞선 작업이 끝난 뒤(성공·실패 무관) 다음 작업을 시작한다. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
