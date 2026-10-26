import { inspect } from "node:util";

const MASK = "***";

/** 비밀번호 등 비밀 값 래퍼. 원문은 reveal()로만 접근한다. */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return MASK;
  }

  toJSON(): string {
    return MASK;
  }

  [inspect.custom](): string {
    return MASK;
  }
}
