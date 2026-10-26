import { CookieJar } from "tough-cookie";

/** tough-cookie 래퍼. Domain 속성에 따른 서브도메인 공유·Secure 규칙은 라이브러리 기본 동작을 따른다. */
export class PortalCookieJar {
  private readonly jar = new CookieJar();

  async storeFromResponse(url: string, setCookieHeaders: string[]): Promise<void> {
    for (const header of setCookieHeaders) {
      try {
        await this.jar.setCookie(header, url);
      } catch {
        // 규칙 위반 쿠키(도메인 불일치 등)는 브라우저처럼 무시한다.
      }
    }
  }

  async headerFor(url: string): Promise<string> {
    return this.jar.getCookieString(url);
  }
}
