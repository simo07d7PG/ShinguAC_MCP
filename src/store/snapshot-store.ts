import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Category, CategoryData, NoticeDetail } from "../schema/index.js";
import { kstDateString } from "../util/time.js";
import { renderMarkdown } from "./markdown.js";

const NOTICE_ID_RE = /^[A-Za-z0-9_:-]+$/;

export interface SnapshotRecord<T> {
  fetchedAt: string;
  data: T;
}

export class SnapshotStore {
  constructor(
    private readonly rootDir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async write<K extends Category>(category: K, data: CategoryData[K], fetchedAt: string): Promise<void> {
    const json = JSON.stringify({ category, fetchedAt, data }, null, 2) + "\n";
    await atomicWrite(join(this.rootDir, `${category}.json`), json);
    await atomicWrite(join(this.rootDir, `${category}.md`), renderMarkdown(category, data, fetchedAt));
    await atomicWrite(join(this.historyDir(), `${category}.json`), json);
  }

  async read<K extends Category>(category: K): Promise<SnapshotRecord<CategoryData[K]> | null> {
    return readRecord(join(this.rootDir, `${category}.json`));
  }

  async writeNotice(id: string, detail: NoticeDetail, fetchedAt: string): Promise<void> {
    assertNoticeId(id);
    const json = JSON.stringify({ category: "notice", fetchedAt, data: detail }, null, 2) + "\n";
    await atomicWrite(join(this.rootDir, "notices", noticeFile(id)), json);
    await atomicWrite(join(this.historyDir(), "notices", noticeFile(id)), json);
  }

  async readNotice(id: string): Promise<SnapshotRecord<NoticeDetail> | null> {
    assertNoticeId(id);
    return readRecord(join(this.rootDir, "notices", noticeFile(id)));
  }

  private historyDir(): string {
    return join(this.rootDir, "history", kstDateString(this.now()));
  }
}

function assertNoticeId(id: string): void {
  if (!NOTICE_ID_RE.test(id)) throw new Error(`잘못된 공지 id: ${JSON.stringify(id)}`);
}

async function readRecord<T>(path: string): Promise<SnapshotRecord<T> | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  const parsed = JSON.parse(raw) as { fetchedAt: string; data: T };
  return { fetchedAt: parsed.fetchedAt, data: parsed.data };
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, content.replace(/\r\n/g, "\n"), "utf8");
  try {
    try {
      await rename(tmp, path);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EBUSY") throw e;
      await new Promise((r) => setTimeout(r, 50));
      await rename(tmp, path);
    }
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/** Windows 파일명에 쓸 수 없는 `:`는 `%3A`로 인코딩한다. */
function noticeFile(id: string): string {
  return `${id.replace(/:/g, "%3A")}.json`;
}
