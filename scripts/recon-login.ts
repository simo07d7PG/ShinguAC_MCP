// 실계정으로 SSO 로그인 체인을 실측한다. 값(학번·비밀번호·쿠키)은 출력하지 않는다.
// 사용: npx tsx --env-file=.env scripts/recon-login.ts
import { HttpClient } from "../src/http/http-client.js";
import { SessionManager } from "../src/auth/session-manager.js";
import { DASHBOARD_URL, isSessionExpired } from "../src/auth/sso-flow.js";
import { logger } from "../src/log/logger.js";

const hops: string[] = [];
const client = new HttpClient({
  logger: { debug: (...args: unknown[]) => hops.push(args.map(String).join(" ")) },
});
const session = new SessionManager({ client });

const t0 = Date.now();
const res = await session.request((c) => c.get(DASHBOARD_URL));
const ms = Date.now() - t0;

logger.info(`로그인 포함 대시보드 응답: status=${res.status} finalUrl=${res.finalUrl} ${ms}ms`);
logger.info(`리다이렉트 hop(마지막 요청): ${res.redirectChain.map((h) => `${h.status}${h.location ? "→" + new URL(h.location, h.url).pathname : ""}`).join(" ")}`);
logger.info(`클라이언트 리다이렉트 로그 ${hops.length}건`);
logger.info(`세션 만료 판정: ${isSessionExpired(res)} (false 여야 정상)`);

// 세션 재사용 확인: 두 번째 요청은 로그인 없이 바로
const t1 = Date.now();
const res2 = await session.request((c) => c.get(DASHBOARD_URL));
logger.info(`두 번째 요청: status=${res2.status} hops=${res2.redirectChain.length} ${Date.now() - t1}ms`);

if (isSessionExpired(res) || isSessionExpired(res2)) process.exit(1);
