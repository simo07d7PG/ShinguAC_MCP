// 실계정 submit_assignment 미리보기 확인(confirm_token 없음 → 제출 POST·업로드 없음). 개인 값은 출력하지 않는다.
// 사용: npx tsx --env-file=.env scripts/smoke-submit-preview.ts <lectureSeq> <reportSeq> [<reportSeq> ...]
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../src/auth/session-manager.js";
import { HttpClient } from "../src/http/http-client.js";
import { CategoryService } from "../src/service/category-service.js";
import { SnapshotStore } from "../src/store/snapshot-store.js";

const [lectureSeq, ...reportSeqs] = process.argv.slice(2);
if (!lectureSeq || reportSeqs.length === 0) throw new Error("인자: <lectureSeq> <reportSeq>...");
const client = new HttpClient();
const service = new CategoryService({
  session: new SessionManager({ client }),
  client,
  store: new SnapshotStore(mkdtempSync(join(tmpdir(), "shingu-preview-"))),
});
for (const reportSeq of reportSeqs) {
  const t0 = Date.now();
  try {
    const r = await service.submitAssignment({ reportSeq, lectureSeq, title: "미리보기", content: "미리보기" });
    console.log(reportSeq, `${Date.now() - t0}ms`, JSON.stringify({
      submitted: r.submitted, mode: r.mode, inExtension: r.inExtension, dueAt: r.dueAt,
      extendedDueAt: r.extendedDueAt, keepsExistingAttachment: r.keepsExistingAttachment,
      existingAttachments: r.existingAttachments.length, token: Boolean(r.confirmToken), warnings: r.warnings.length,
    }));
  } catch (err) {
    console.log(reportSeq, `${Date.now() - t0}ms`, "ERR", (err as Error).message);
  }
}
