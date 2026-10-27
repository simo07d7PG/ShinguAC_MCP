// 실계정으로 CategoryService를 끝까지 돌려 본다(읽기 전용). 개인 값은 건수·상태만 출력한다.
// 사용: npx tsx --env-file=.env scripts/smoke-service.ts
import { HttpClient } from "../src/http/http-client.js";
import { SessionManager } from "../src/auth/session-manager.js";
import { CategoryService } from "../src/service/category-service.js";
import { logger } from "../src/log/logger.js";

const client = new HttpClient();
const session = new SessionManager({ client });
const service = new CategoryService({ session, client });

async function step<T>(name: string, fn: () => Promise<T>, summarize: (v: T) => string): Promise<T | undefined> {
  const t0 = Date.now();
  try {
    const v = await fn();
    logger.info(`${name}: OK ${Date.now() - t0}ms — ${summarize(v)}`);
    return v;
  } catch (err) {
    logger.error(`${name}: FAIL ${Date.now() - t0}ms — ${(err as Error).name}: ${(err as Error).message}`);
    return undefined;
  }
}

const tt = await step("getTimetable", () => service.getTimetable(), (r) => `entries=${r.data.length}`);
const gr = await step("getGrades", () => service.getGrades({}), (r) => `semesters=${r.data.semesters.length} credits=${r.data.credits.length} current=${r.data.current.length}`);
const no = await step("getNotices", () => service.getNotices({ limit: 5 }), (r) => `n=${r.data.length} first=${r.data[0]?.id ?? "-"}`);
if (no?.data[0]) {
  await step("getNotice(univ)", () => service.getNotice(no.data[0]!.id), (r) => `title.len=${r.data.title.length} body.len=${r.data.body.length} attachments=${r.data.attachments.length}`);
}
const as = await step("getAssignments(7d)", () => service.getAssignments({ dueWithinDays: 7 }), (r) => {
  const by = r.data.reduce<Record<string, number>>((m, a) => ((m[a.submitStatus] = (m[a.submitStatus] ?? 0) + 1), m), {});
  return `n=${r.data.length} status=${JSON.stringify(by)}`;
});
const co = await step("getCourses(contacts)", () => service.getCourses({ includeContacts: true }), (r) => `n=${r.data.length} withEmail=${r.data.filter((c) => c.professor.email).length} withOffice=${r.data.filter((c) => c.professor.office).length}`);

const ok = [tt, gr, no, as, co].every(Boolean);
process.exit(ok ? 0 : 1);
