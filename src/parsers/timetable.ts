import type { AnyNode } from "domhandler";
import { TimetableEntrySchema, type TimetableEntry } from "../schema/timetable.js";
import { ParseError, load, text, type $ } from "./common.js";

const SCREEN = "SSE013R";
const TIME_RE = /(\d{1,2}:\d{2})\s*~\s*(\d{1,2}:\d{2})/;
const TERM_RE = /(\d{4})\s*년도\s*(\d+)\s*학기/;

/** 셀 내부를 `<br>` 기준 줄 단위 텍스트로 분해한다 (빈 줄 제외). */
function cellLines($: $, td: AnyNode): string[] {
  const html = $(td).html() ?? "";
  return html
    .split(/<br\s*\/?>/i)
    .map((frag) => text($(`<div>${frag}</div>`)))
    .filter((line) => line.length > 0);
}

function splitRoom(place: string): { building?: string; room?: string } {
  const idx = place.lastIndexOf(" ");
  if (idx < 0) return { building: place };
  return { building: place.slice(0, idx), room: place.slice(idx + 1) };
}

function parseTable($: $): TimetableEntry[] {
  const table = $("table.table-list.table-center").last();
  if (table.length === 0) throw new ParseError(SCREEN, "table.table-list.table-center");
  const entries: TimetableEntry[] = [];
  table.find("tr").each((_, tr) => {
    const tds = $(tr).children("td").toArray();
    if (tds.length < 7) return;
    const head = cellLines($, tds[0]!).join(" ");
    const period = Number(/^\d+/.exec(head)?.[0]);
    if (!Number.isInteger(period)) return;
    // 실측: 교시와 시간이 첫 td 하나(`7<br>14:30~15:20`)에 들어 있다. 시간이 별도 td인 변형도 허용.
    let dayStart = 1;
    let timeText = head;
    if (tds.length >= 8) {
      dayStart = 2;
      timeText = text($(tds[1]!));
    }
    const time = TIME_RE.exec(timeText);
    for (let d = 0; d < 6; d++) {
      const td = tds[dayStart + d];
      if (!td) continue;
      const lines = cellLines($, td);
      for (let i = 0; i + 1 < lines.length; i += 4) {
        const place = lines[i + 2];
        entries.push(
          TimetableEntrySchema.parse({
            day: d + 1,
            period,
            startTime: time?.[1],
            endTime: time?.[2],
            courseName: lines[i],
            professorName: lines[i + 1],
            ...(place ? splitRoom(place) : {}),
            roomAlias: lines[i + 3],
          }),
        );
      }
    }
  });
  return entries;
}

/** 개인 시간표(SSE013R)의 데스크톱 표(마지막 표)를 교시×요일 엔트리로 변환한다. */
export function parseTimetable(html: string): TimetableEntry[] {
  return parseTable(load(html));
}

/** `parseTimetable` + `panel-heading`의 "2026 년도 2 학기"에서 학년도/학기 코드를 함께 반환한다. */
export function parseTimetablePage(html: string): { year: number; semester: string; entries: TimetableEntry[] } {
  const $ = load(html);
  const m = $(".panel-heading")
    .toArray()
    .map((el) => TERM_RE.exec(text($(el))))
    .find((r) => r !== null);
  if (!m) throw new ParseError(SCREEN, ".panel-heading", "'YYYY 년도 N 학기' 문구 없음");
  return { year: Number(m[1]), semester: m[2]!, entries: parseTable($) };
}
