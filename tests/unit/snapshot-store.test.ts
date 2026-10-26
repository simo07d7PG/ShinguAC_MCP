import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Assignment, NoticeDetail } from "../../src/schema/index.js";
import { SnapshotStore } from "../../src/store/snapshot-store.js";

const assignment: Assignment = {
  lectureSeq: "1",
  reportSeq: "2",
  courseName: "UI화면설계",
  title: "중간 과제",
  startAt: null,
  dueAt: "2026-10-30T23:59:00+09:00",
  extendedDueAt: null,
  submitStatus: "not_submitted",
  detailUrl: "/x",
};

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

let root: string;
let clock: Date;
let store: SnapshotStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "snap-"));
  clock = new Date("2026-10-26T03:00:00Z");
  store = new SnapshotStore(root, () => clock);
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("SnapshotStore", () => {
  it("writes latest json/md and history, and reads back", async () => {
    await store.write("assignments", [assignment], "2026-10-26T12:00:00+09:00");
    expect(await exists(join(root, "assignments.json"))).toBe(true);
    expect(await exists(join(root, "assignments.md"))).toBe(true);
    expect(await exists(join(root, "history", "2026-10-26", "assignments.json"))).toBe(true);
    const rec = await store.read("assignments");
    expect(rec?.fetchedAt).toBe("2026-10-26T12:00:00+09:00");
    expect(rec?.data[0]?.title).toBe("중간 과제");
  });

  it("read returns null when missing", async () => {
    expect(await store.read("grades")).toBeNull();
  });

  it("overwrites on the same day", async () => {
    await store.write("assignments", [assignment], "t1");
    await store.write("assignments", [], "t2");
    const hist = JSON.parse(await readFile(join(root, "history", "2026-10-26", "assignments.json"), "utf8"));
    expect(hist.fetchedAt).toBe("t2");
    expect(hist.data).toEqual([]);
  });

  it("uses a separate folder on another day", async () => {
    await store.write("assignments", [assignment], "t1");
    clock = new Date("2026-10-27T03:00:00Z");
    await store.write("assignments", [], "t2");
    expect(await exists(join(root, "history", "2026-10-26", "assignments.json"))).toBe(true);
    expect(await exists(join(root, "history", "2026-10-27", "assignments.json"))).toBe(true);
  });

  it("UTC 15:00 or later lands in the next KST day folder", async () => {
    clock = new Date("2026-10-26T15:00:00Z");
    await store.write("assignments", [assignment], "t");
    expect(await exists(join(root, "history", "2026-10-27", "assignments.json"))).toBe(true);
    expect(await exists(join(root, "history", "2026-10-26"))).toBe(false);
  });

  it("renders Korean markdown with LF", async () => {
    await store.write("assignments", [assignment], "t");
    const md = await readFile(join(root, "assignments.md"), "utf8");
    expect(md).toContain("# 과제");
    expect(md).toContain("UI화면설계");
    expect(md).toContain("미제출");
    expect(md).not.toContain("\r");
  });

  it("renders grades markdown", async () => {
    await store.write("grades", { semesters: [], credits: [], current: [] }, "t");
    expect(await readFile(join(root, "grades.md"), "utf8")).toContain("# 성적");
  });

  it("stores notices and rejects bad ids", async () => {
    const detail: NoticeDetail = {
      id: "n:1",
      category: "univ",
      title: "공지",
      postedAt: null,
      url: "/n",
      body: "본문",
      attachments: [],
    };
    await store.writeNotice("n:1", detail, "t");
    expect((await store.readNotice("n:1"))?.data.body).toBe("본문");
    expect(await exists(join(root, "history", "2026-10-26", "notices", "n%3A1.json"))).toBe(true);
    expect(await store.readNotice("missing")).toBeNull();
    await expect(store.writeNotice("../evil", detail, "t")).rejects.toThrow();
    await expect(store.readNotice("a/b")).rejects.toThrow();
  });
});
