// 빌드된 서버(dist/index.js)를 stdio로 띄워 SDK Client로 7개 도구를 순차 호출한다(실계정, 읽기 전용).
// 사용: npm run build && npx tsx --env-file=.env scripts/smoke.ts
// 출력은 건수·소요 시간·메타만. 개인 값은 출력하지 않는다.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  env: { ...(process.env as Record<string, string>), SHINGU_MCP_LOG: process.env["SHINGU_MCP_LOG"] ?? "info" },
  stderr: "inherit",
});
const client = new Client({ name: "shingu-smoke", version: "0.0.0" });
const t0 = Date.now();
await client.connect(transport);
const tools = await client.listTools();
console.log(`tools: ${tools.tools.map((t) => t.name).join(", ")} (${Date.now() - t0}ms)`);

type Meta = { fetchedAt?: string; stale?: boolean; source?: string; warning?: string };
async function call(name: string, args: Record<string, unknown>, summarize: (sc: Record<string, unknown>) => string): Promise<boolean> {
  const s = Date.now();
  const res = await client.callTool({ name, arguments: args });
  const ms = Date.now() - s;
  if (res.isError) {
    console.log(`✖ ${name} ${ms}ms — ${(res.content as { text?: string }[])[0]?.text?.slice(0, 200)}`);
    return false;
  }
  const sc = (res.structuredContent ?? {}) as Record<string, unknown> & Meta;
  console.log(`✔ ${name} ${ms}ms — ${summarize(sc)} | fetchedAt=${sc.fetchedAt}`);
  return true;
}
const len = (sc: Record<string, unknown>): number => (Array.isArray(sc["data"]) ? (sc["data"] as unknown[]).length : -1);

const results: boolean[] = [];
results.push(await call("get_assignments", { due_within_days: 7 }, (sc) => {
  const d = sc["data"] as { submitStatus: string }[];
  const by: Record<string, number> = {};
  for (const a of d) by[a.submitStatus] = (by[a.submitStatus] ?? 0) + 1;
  return `n=${d.length} ${JSON.stringify(by)}`;
}));
{
  // 첫 과제의 상세(본문·첨부) — get_assignments 결과의 reportSeq/lectureSeq 사용
  const first = ((await client.callTool({ name: "get_assignments", arguments: { due_within_days: 14 } })).structuredContent as { data: { reportSeq: string; lectureSeq: string }[] }).data[0];
  if (first) {
    results.push(await call("get_assignment", { report_seq: first.reportSeq, lecture_seq: first.lectureSeq }, (sc) => {
      const d = sc["data"] as { body: string; attachments: unknown[]; submitStatus: string };
      return `body.len=${d.body.length} attachments=${d.attachments.length} status=${d.submitStatus}`;
    }));
  }
}
results.push(await call("get_timetable", {}, (sc) => `entries=${len(sc)} week=${JSON.stringify(sc["week"])}`));
results.push(await call("get_courses", {}, (sc) => `n=${len(sc)}`));
let firstNotice: string | undefined;
results.push(await call("get_notices", { limit: 5 }, (sc) => {
  const d = sc["data"] as { id: string }[];
  firstNotice = d[0]?.id;
  return `n=${d.length} first=${firstNotice}`;
}));
if (firstNotice) {
  results.push(await call("get_notice", { id: firstNotice }, (sc) => {
    const d = sc["data"] as { body: string; attachments: unknown[] };
    return `body.len=${d.body.length} attachments=${d.attachments.length}`;
  }));
}
results.push(await call("get_grades", {}, (sc) => {
  const d = sc["data"] as { semesters: unknown[]; credits: unknown[]; current: unknown[] };
  return `semesters=${d.semesters.length} credits=${d.credits.length} current=${d.current.length}`;
}));

await client.close();
console.log(`total ${Date.now() - t0}ms, ${results.filter(Boolean).length}/${results.length} ok`);
process.exit(results.every(Boolean) ? 0 : 1);
