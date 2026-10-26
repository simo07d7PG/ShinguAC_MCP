// 포털 장애 시 스냅샷 fallback(AC-E4) 확인: 네트워크를 끊는 대신 항상 실패하는 fetch를 주입한다.
// 사용: npx tsx --env-file=.env scripts/smoke-stale.ts   (사전에 smoke/smoke:service 로 스냅샷이 생성돼 있어야 함)
import { loadConfig } from "../src/config/config.js";
import { HttpClient } from "../src/http/http-client.js";
import { RequestQueue } from "../src/queue/request-queue.js";
import { SessionManager } from "../src/auth/session-manager.js";
import { SnapshotStore } from "../src/store/snapshot-store.js";
import { CategoryService } from "../src/service/category-service.js";
import { logger } from "../src/log/logger.js";

const config = loadConfig();
const failingFetch: typeof fetch = async () => {
  throw Object.assign(new Error("connect ECONNREFUSED (simulated outage)"), { code: "ECONNREFUSED" });
};
const client = new HttpClient({ fetch: failingFetch, queue: new RequestQueue({ minGapMs: 0, timeoutMs: 2000 }) });
const session = new SessionManager({ client, loadConfig: () => config });
const store = new SnapshotStore(config.snapshotsDir);
const service = new CategoryService({ session, client, store });

let ok = true;
for (const [name, fn] of [
  ["getAssignments", () => service.getAssignments({ dueWithinDays: 7 })],
  ["getTimetable", () => service.getTimetable()],
  ["getGrades", () => service.getGrades({})],
  ["getNotices", () => service.getNotices({ limit: 5 })],
] as const) {
  try {
    const r = await fn();
    const pass = r.meta.stale === true && r.meta.source === "snapshot";
    ok &&= pass;
    logger.info(`${name}: ${pass ? "PASS" : "FAIL"} stale=${r.meta.stale} source=${r.meta.source} fetchedAt=${r.meta.fetchedAt} warning=${r.meta.warning ?? "-"}`);
  } catch (err) {
    ok = false;
    logger.error(`${name}: FAIL (throw) ${(err as Error).name}: ${(err as Error).message}`);
  }
}
logger.info(`snapshots dir: ${config.snapshotsDir}`);
process.exit(ok ? 0 : 1);
