import { CookieJar } from 'tough-cookie';
import { CliError } from './core.js';

/** HTTPS-only, same-origin transport. Redirects never receive cookies automatically. */
export class HttpTransport {
  readonly base: URL;
  readonly controller = new AbortController();
  constructor(readonly jar = new CookieJar(), base = 'https://m.kuku.lu/') {
    this.base = new URL(base);
    if (this.base.protocol !== 'https:' && !(this.base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(this.base.hostname))) {
      throw new CliError('PROTOCOL', 'HTTPSの接続先が必要です。');
    }
  }
  close() { this.controller.abort(); }
  async request(file: string, params: Record<string, string> = {}, method: 'GET' | 'POST' = 'GET', allowRedirects = true): Promise<string> {
    let url = new URL(file, this.base);
    if (url.origin !== this.base.origin) throw new CliError('ORIGIN', '異なるサイトへの通信を拒否しました。');
    const form = new URLSearchParams(params);
    if (method === 'GET') for (const [key, value] of form) url.searchParams.set(key, value);
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(30000)]);
    try {
      for (let redirects = 0; redirects <= 5; redirects++) {
        const response = await fetch(url, {
          method, redirect: 'manual', signal,
          headers: { Cookie: await this.jar.getCookieString(url.href), Referer: this.base.href,
            'User-Agent': 'sutepoi-cli/0.1.0', 'Accept-Language': 'ja',
            ...(method === 'POST' ? {'Content-Type':'application/x-www-form-urlencoded'} : {}) },
          body: method === 'POST' ? form.toString() : undefined,
        });
        for (const cookie of response.headers.getSetCookie()) await this.jar.setCookie(cookie, url.href);
        if ([301,302,303,307,308].includes(response.status)) {
          const location = response.headers.get('location');
          await response.body?.cancel();
          if (!location) throw new CliError('NETWORK', '転送先を確認できません。');
          const next = new URL(location, url);
          if (next.origin !== this.base.origin) throw new CliError('ORIGIN', '異なるサイトへの転送を拒否しました。');
          // Never replay a mutation after a redirect.
          if (!allowRedirects || method === 'POST') throw new CliError('NETWORK', '操作リクエストが転送されました。');
          url = next; continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new CliError(response.status === 403 ? 'AUTH' : 'NETWORK', response.status === 403 ? '追加認証が必要です。sutepoi loginを実行してください。' : 'サーバーへの接続に失敗しました。', response.status === 403 ? 3 : 1);
        }
        return await response.text();
      }
      throw new CliError('NETWORK', '転送回数が上限を超えました。');
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError('NETWORK', 'HTTPS通信に失敗しました。');
    }
  }
}
