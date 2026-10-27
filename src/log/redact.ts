const MASK = "***";
const globalSecrets = new Set<string>();

/** 전역 비밀 원문을 등록한다. 이후 모든 redact() 호출에서 마스킹된다. */
export function registerSecret(value: string): void {
  if (value) globalSecrets.add(value);
}

const PATTERNS: Array<[RegExp, string]> = [
  [/\b(set-cookie|cookie)(\s*:\s*)[^\r\n]*/gi, `$1$2${MASK}`],
  [/\b(password|passwd|pw)(\s*[=:]\s*)[^&\s"',;}]*/gi, `$1$2${MASK}`],
  [/\b(jsessionid)(\s*=\s*)[^;&\s"',]*/gi, `$1$2${MASK}`],
  [/\b(access_token|refresh_token)(\s*[=:]\s*)[^&\s"',;}]*/gi, `$1$2${MASK}`],
  // 첨부 키는 쿠키 없이 파일을 받을 수 있는 값이다(docs/portal-pages.md §3.4).
  [/\b(file[_-]?key|file[_-]?master[_-]?key)("?\s*[=:]\s*"?)[^&\s"',;}]*/gi, `$1$2${MASK}`],
];

export function redact(text: string, secrets: string[] = []): string {
  let out = text;
  const all = [...globalSecrets, ...secrets].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const s of all) out = out.split(s).join(MASK);
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}
