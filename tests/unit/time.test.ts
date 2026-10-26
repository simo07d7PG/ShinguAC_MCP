import { describe, expect, it } from "vitest";
import { kstDateString, nowKst, parseKst, semesterLabel, weekRangeKst } from "../../src/util/time.js";

describe("parseKst", () => {
  it.each([
    ["2026-10-27 00:00:00.0", "2026-10-27T00:00:00+09:00"],
    ["2026-10-27 00:00", "2026-10-27T00:00:00+09:00"],
    ["2026.10.27", "2026-10-27T00:00:00+09:00"],
    ["2026.10.30 23:59", "2026-10-30T23:59:00+09:00"],
    ["2026-10-27", "2026-10-27T00:00:00+09:00"],
    ["[2026-10-27]", "2026-10-27T00:00:00+09:00"],
    ["2026-12-31 23:59:59", "2026-12-31T23:59:59+09:00"],
    ["2027-01-01 00:00:00", "2027-01-01T00:00:00+09:00"],
  ])("%s", (input, expected) => {
    expect(parseKst(input)).toBe(expected);
  });

  it.each(["", "abc", "2026-13-01", "2026-02-30", "2026-10-27 24:00", null, undefined])("null for %s", (input) => {
    expect(parseKst(input as string)).toBeNull();
  });
});

describe("kstDateString", () => {
  it("UTC 14:59:59 is the same KST day", () => {
    expect(kstDateString(new Date("2026-10-26T14:59:59Z"))).toBe("2026-10-26");
  });
  it("UTC 15:00 is the next KST day", () => {
    expect(kstDateString(new Date("2026-10-26T15:00:00Z"))).toBe("2026-10-27");
  });
  it("year boundary", () => {
    expect(kstDateString(new Date("2026-12-31T15:00:00Z"))).toBe("2027-01-01");
  });
});

describe("nowKst", () => {
  it("formats with +09:00", () => {
    expect(nowKst(new Date("2026-12-31T15:00:00Z"))).toBe("2027-01-01T00:00:00+09:00");
  });
});

describe("weekRangeKst", () => {
  it("Monday to Sunday", () => {
    expect(weekRangeKst(new Date("2026-10-26T03:00:00Z"))).toEqual({ start: "2026-10-26", end: "2026-11-01" });
  });
  it("Sunday belongs to the previous Monday's week", () => {
    expect(weekRangeKst(new Date("2026-11-01T03:00:00Z"))).toEqual({ start: "2026-10-26", end: "2026-11-01" });
  });
  it("UTC Sunday 15:00 is KST Monday", () => {
    expect(weekRangeKst(new Date("2026-11-01T15:00:00Z"))).toEqual({ start: "2026-11-02", end: "2026-11-08" });
  });
  it("crosses year boundary", () => {
    expect(weekRangeKst(new Date("2026-12-31T03:00:00Z"))).toEqual({ start: "2026-12-28", end: "2027-01-03" });
  });
});

describe("semesterLabel", () => {
  it("joins year and code", () => {
    expect(semesterLabel(2026, "2")).toBe("2026-2");
  });
});
