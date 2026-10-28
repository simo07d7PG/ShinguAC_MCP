// 실계정 sync_eclass 확인(포털 쓰기 없음). 개인 값은 출력하지 않고 건수·크기만 출력한다.
// 사용: npx tsx --env-file=.env scripts/smoke-archive.ts <빈 작업 폴더> [--no-download] [--full]
// 작업 폴더에 eclass.db와 files/를 만든다(~/.shingu-mcp는 건드리지 않는다).
import { resolve } from "node:path";
import { SessionManager } from "../src/auth/session-manager.js";
import { HttpClient } from "../src/http/http-client.js";
import { CategoryService } from "../src/service/category-service.js";
import { ArchiveDb } from "../src/store/archive-db.js";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
if (!dir) throw new Error("인자: <작업 폴더> [--no-download] [--full]");
const dbPath = resolve(dir, "eclass.db");
const filesDir = resolve(dir, "files");
const db = new ArchiveDb(dbPath);
const client = new HttpClient();
const service = new CategoryService({
  session: new SessionManager({ client }),
  client,
  archive: { db, dbPath, filesDir },
});

const t0 = Date.now();
const r = await service.syncArchive({ downloadFiles: !args.includes("--no-download"), full: args.includes("--full") });
console.log(`sync ${((Date.now() - t0) / 1000).toFixed(1)}s term=${r.term} courses=${r.courses.length} skippedEmpty=${r.skippedEmptyCourses}`);
for (const [i, c] of r.courses.entries()) {
  console.log(
    `  course#${i} assignments=${JSON.stringify(c.assignments)} submissions=${JSON.stringify(c.submissions)} ` +
      `notices=${JSON.stringify(c.notices)} materials=${JSON.stringify(c.materials)}${c.error ? ` ERROR=${c.error}` : ""}`,
  );
}
console.log(`  timetable=${JSON.stringify(r.timetable)} files=${JSON.stringify(r.files)} warnings=${r.warnings.length}`);
for (const w of r.warnings) console.log(`  warn: ${w.replace(/"[^"]*"/g, '"…"')}`);
const stats = db.all<{ owner_type: string; n: number; bytes: number | null; done: number }>(
  "SELECT owner_type, COUNT(*) n, SUM(size) bytes, COUNT(local_path) done FROM attachments GROUP BY owner_type",
);
for (const s of stats) console.log(`  attachments ${s.owner_type}: ${s.done}/${s.n} saved, ${((s.bytes ?? 0) / 1e6).toFixed(1)}MB`);
const empty = db.all<{ n: number }>("SELECT COUNT(*) n FROM posts WHERE body_text = ''")[0]!.n;
const emptyHw = db.all<{ n: number }>("SELECT COUNT(*) n FROM assignments WHERE content_text = ''")[0]!.n;
console.log(`  posts with empty body=${empty}, assignments with empty content=${emptyHw}`);
db.close();
