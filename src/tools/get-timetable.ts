import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TimetableEntrySchema } from "../schema/index.js";
import { kstDateString, weekRangeKst } from "../util/time.js";
import type { GetService } from "./index.js";
import { flatten, run, SOURCE_NOTE, withMeta } from "./result.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD`를 그 날 KST 정오로 해석한다. 달력에 없는 날짜면 Error. */
function parseWeekArg(week: string): Date {
  const date = new Date(`${week}T12:00:00+09:00`);
  if (Number.isNaN(date.getTime()) || kstDateString(date) !== week) {
    throw new Error(`week 날짜가 올바르지 않습니다(예: 2026-10-26): ${week}`);
  }
  return date;
}

function addDays(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function registerGetTimetable(server: McpServer, getService: GetService): void {
  server.registerTool(
    "get_timetable",
    {
      title: "시간표",
      description:
        "이번 학기 주간 시간표(요일·교시·과목·교수·강의실)를 반환한다. 시간표는 학기 동안 고정이므로 " +
        "week는 각 항목에 붙는 실제 날짜(date)만 바꾼다. " +
        "로컬에 저장된 시간표를 돌려주며(fetchedAt은 저장 시각, sync_eclass 때도 갱신) " +
        "이번 학기 저장본이 없거나 비어 있거나 24시간이 지났으면 포털에서 읽어 저장한다. " +
        SOURCE_NOTE,
      inputSchema: {
        week: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("이 날짜가 속한 주(월~일, KST)의 날짜를 붙인다. 형식 YYYY-MM-DD. 생략 시 이번 주."),
      },
      outputSchema: withMeta(z.array(TimetableEntrySchema.extend({ date: z.string() }))).extend({
        week: z.object({ start: z.string(), end: z.string() }),
      }),
    },
    ({ week }) =>
      run(async () => {
        const range = weekRangeKst(week === undefined ? new Date() : parseWeekArg(week));
        const result = flatten(await getService().getTimetable());
        // day: 1=월 … 7=일, range.start는 월요일
        const data = result.data.map((e) => ({ ...e, date: addDays(range.start, e.day - 1) }));
        return { ...result, data, week: range };
      }),
  );
}
