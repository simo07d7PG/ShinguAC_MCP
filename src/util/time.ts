const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

const DATE_RE =
  /^(\d{4})[-.](\d{1,2})[-.](\d{1,2})\.?(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?$/;

/** 포털 날짜 문자열을 KST ISO(`YYYY-MM-DDTHH:mm:ss+09:00`)로 변환한다. 해석 불가면 null. */
export function parseKst(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = input.replace(/ /g, " ").trim();
  const bracket = /^\[(.*)\]$/.exec(s);
  if (bracket) s = (bracket[1] ?? "").trim();
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi, se] = [m[1], m[2], m[3], m[4] ?? "0", m[5] ?? "0", m[6] ?? "0"].map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || se > 59) return null;
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return `${pad(y, 4)}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(se)}+09:00`;
}

/** 현재 시각의 KST ISO 문자열. */
export function nowKst(now: Date = new Date()): string {
  const k = new Date(now.getTime() + KST_OFFSET_MS);
  return `${kstDateString(now)}T${pad(k.getUTCHours())}:${pad(k.getUTCMinutes())}:${pad(k.getUTCSeconds())}+09:00`;
}

/** KST 기준 날짜(YYYY-MM-DD). UTC 15:00 이후는 KST 다음 날. */
export function kstDateString(date: Date): string {
  const k = new Date(date.getTime() + KST_OFFSET_MS);
  return `${pad(k.getUTCFullYear(), 4)}-${pad(k.getUTCMonth() + 1)}-${pad(k.getUTCDate())}`;
}

/** 주어진 시각이 속한 KST 주(월~일)의 시작/끝 날짜. */
export function weekRangeKst(date: Date): { start: string; end: string } {
  const k = new Date(date.getTime() + KST_OFFSET_MS);
  const sinceMonday = (k.getUTCDay() + 6) % 7;
  const startMs = Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate()) - sinceMonday * DAY_MS;
  const fmt = (ms: number): string => {
    const x = new Date(ms);
    return `${pad(x.getUTCFullYear(), 4)}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`;
  };
  return { start: fmt(startMs), end: fmt(startMs + 6 * DAY_MS) };
}

/** 학기 라벨 `YYYY-H` (예: `2026-1`). */
export function semesterLabel(year: number, code: string | number): string {
  return `${year}-${String(code).trim()}`;
}
