function charsetFromContentType(contentType: string | null): string | null {
  const m = contentType?.match(/charset\s*=\s*["']?([^\s;"']+)/i);
  return m?.[1] ?? null;
}

function charsetFromMeta(buf: ArrayBuffer): string | null {
  const head = new TextDecoder("latin1").decode(buf.slice(0, 2048));
  const m =
    head.match(/<meta[^>]+charset\s*=\s*["']?([^\s"'>;/]+)/i) ??
    head.match(/<meta[^>]+http-equiv\s*=\s*["']?content-type["']?[^>]*content\s*=\s*["'][^"']*charset=([^\s"';]+)/i);
  return m?.[1] ?? null;
}

export function decodeBody(buf: ArrayBuffer, contentType: string | null): string {
  const candidates = [charsetFromContentType(contentType), charsetFromMeta(buf), "utf-8"];
  for (const label of candidates) {
    if (!label) continue;
    try {
      return new TextDecoder(label).decode(buf);
    } catch {
      // 알 수 없는 라벨이면 다음 후보로 넘어간다.
    }
  }
  return new TextDecoder("utf-8").decode(buf);
}
