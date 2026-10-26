import * as cheerio from "cheerio";

export interface ExtractedForm {
  action: string;
  method: string;
  fields: Record<string, string>;
}

export function stripHtmlComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, "");
}

/** 주석을 제거한 뒤 `form[name=...]`의 hidden/text/password input을 수집한다. 없으면 null. */
export function extractForm(html: string, formName: string): ExtractedForm | null {
  const $ = cheerio.load(stripHtmlComments(html));
  const form = $("form")
    .filter((_, el) => $(el).attr("name") === formName)
    .first();
  if (form.length === 0) return null;
  const fields: Record<string, string> = {};
  form.find("input").each((_, el) => {
    const name = $(el).attr("name");
    const type = ($(el).attr("type") ?? "text").toLowerCase();
    if (!name || !["hidden", "text", "password"].includes(type)) return;
    fields[name] = $(el).attr("value") ?? "";
  });
  return {
    action: form.attr("action") ?? "",
    method: (form.attr("method") ?? "get").toUpperCase(),
    fields,
  };
}

/** 인라인 JS의 `var name = "value"` 문자열 값을 반환한다. 없으면 null. */
export function extractJsVar(html: string, name: string): string | null {
  const m = new RegExp(`\\bvar\\s+${name}\\s*=\\s*(["'])(.*?)\\1`).exec(html);
  return m ? (m[2] ?? "") : null;
}
