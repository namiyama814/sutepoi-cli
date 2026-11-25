import type { Page, Response } from 'playwright';
import { CliError, type Address, type Mail, type Message } from './core.js';
export const SITE = 'https://m.kuku.lu/';
const changed = () => new CliError('SITE_CHANGED', '画面を読み取れません。--headedで確認してください。');
export class Site {
  expectedIdentity?: string;
  constructor(readonly page: Page, readonly base = SITE) {}
  private url(file: string) { return new URL(file, this.base).href; }
  async identity(): Promise<string> {
    const id = (await this.page.locator('#area_numberview').textContent())?.trim();
    if (!id) throw new CliError('AUTH', 'sutepoi loginを実行してください。', 3);
    return id;
  }
  async home() {
    await this.page.goto(this.url('index.php'), { waitUntil: 'domcontentloaded' });
    if (this.expectedIdentity && await this.identity() !== this.expectedIdentity) throw new CliError('AUTH', 'アカウントが変わりました。sutepoi loginを実行してください。', 3);
  }
  private waitList(endpoint: string) {
    const response = this.page.waitForResponse(r => {
      const u = new URL(r.url());
      return u.pathname.endsWith('/' + endpoint) && !u.searchParams.has('action');
    });
    void response.catch(() => undefined);
    return response;
  }
  private async nextPage(kind: 'addresses' | 'mail', page: number, address?: string) {
    const response = this.waitList(kind === 'addresses' ? 'index._addrlist.php' : 'recv._ajax.php');
    await this.page.evaluate(({kind, page, address}) => {
      const w = window as unknown as { viewAddrList: (q: string) => void; viewMail: (q: string) => void };
      const root = document.querySelector(kind === 'addresses' ? '#area_addrlist' : '#area_maillist');
      if (root) root.innerHTML = '';
      if (kind === 'addresses') w.viewAddrList('&page=' + page);
      else w.viewMail('&page=' + page + (address ? '&q=' + encodeURIComponent(address) : ''));
    }, {kind, page, address});
    await this.loaded(response);
  }
  async addresses(): Promise<Address[]> {
    const response = this.waitList('index._addrlist.php');
    await this.home();
    await this.loaded(response);
    const found = new Map<string, Address>();
    for (let page = 0; page < 1000; page++) {
      const items = await this.page.locator('#area_addrlist [id^="area_mailaddr_"]').evaluateAll(els =>
        els.map(el => el.textContent?.trim() ?? '').filter(text => /^[^\s@]+@[^\s@]+$/.test(text)));
      const fresh = items.filter(address => !found.has(address));
      if (!fresh.length) return [...found.values()];
      for (const address of fresh) found.set(address, {address});
      await this.nextPage('addresses', page + 1);
    }
    throw new CliError('PAGE_LIMIT', 'ページ数が上限を超えました。');
  }
  private async loaded(response: Promise<Response>) {
    const r = await response;
    if (!r.ok()) throw new CliError('NETWORK', '一覧を取得できません。');
    if (!(await r.text()).includes('[OK]')) throw changed();
    await this.page.waitForFunction(() => {
      const root = document.querySelector('#area_maillist') ?? document.querySelector('#area_addrlist');
      return root?.innerHTML.includes('[OK]');
    });
  }
  async create(name?: string, domain?: string): Promise<Address> {
    await this.home();
    // Agreement is always performed interactively by the user.
    if (!(await this.page.evaluate(() => (window as unknown as { confirmEULA?: string }).confirmEULA === '1'))) {
      throw new CliError('AGREEMENT', 'sutepoi loginで利用規約を確認し、ブラウザでアドレスを作成してください。', 3);
    }
    if (name) {
      await this.page.locator('#link_addMailAddrByManual').click();
      await this.page.locator('#input_manualmailaddr').fill(name);
      const radio = this.page.locator('input[name="input_manualmaildomain"]');
      const values = await radio.evaluateAll(els => els.map(el => (el as HTMLInputElement).value));
      if (!values.includes(domain!)) throw new CliError('ARGUMENT', '指定したドメインは利用できません。', 2);
      // Hidden radio inputs are backed by visible labels.
      const id = await this.page.locator('input[name="input_manualmaildomain"]').evaluateAll((els, d) => els.find(el => (el as HTMLInputElement).value === d)?.id, domain);
      await this.page.locator(`label[for=${JSON.stringify(id)}]`).click();
    }
    const action = name ? 'addMailAddrByManual' : 'addMailAddrByAuto';
    const result = this.page.waitForResponse(r => {
      const u = new URL(r.url());
      return u.pathname.endsWith('/index.php') && u.searchParams.get('action') === action;
    });
    void result.catch(() => undefined);
    try {
      await this.page.locator(name ? '#link_addMailAddrByManualSubmit' : '#link_addMailAddrByAuto').click();
      const r = await result;
      const text = await r.text();
      if (r.ok() && text.startsWith('OK:')) {
        const address = text.slice(3).split(',,')[0].trim();
        if (/^[^\s@]+@[^\s@]+$/.test(address)) return { address };
      }
      if (text.startsWith('NG:')) throw new CliError('CREATE_REJECTED', 'アドレスを作成できません。--headedで確認してください。');
      throw new Error();
    } catch (error) {
      // Consume pending rejection even if click itself failed.
      void result.catch(() => undefined);
      if (error instanceof CliError) throw error;
      throw new CliError('CREATE_UNKNOWN', '作成結果を確認できません。sutepoi addresses listで確認してください。');
    }
  }
  async mails(address?: string, limit = 20, id?: string): Promise<Mail[]> {
    const url = new URL('recv.php', this.base);
    if (address) url.searchParams.set('q', address);
    if (id) url.searchParams.set('mailid', id);
    const response = this.waitList('recv._ajax.php');
    await this.page.goto(url.href, { waitUntil: 'domcontentloaded' });
    await this.loaded(response);
    const found = new Map<string, Mail>();
    for (let page = 0; page < 1000; page++) {
    const mails = await this.page.locator('#area_maillist').evaluate(root => {
      const text = (selector: string) => root.querySelector(selector)?.textContent?.trim() ?? '';
      return Array.from(root.querySelectorAll('[id^="link_maildata_"]')).map(link => {
        const id = link.id.slice('link_maildata_'.length);
        const row = root.querySelector(`#area_mail_${CSS.escape(id)}`);
        // The website binds openMailData in inline scripts, with URL-encoded metadata.
        const scripts = Array.from(root.querySelectorAll('script')).map(s => s.textContent ?? '').join('\n');
        const call = scripts.split('\n').find(line => line.includes('openMailData(') && new RegExp("['\"]" + id + "['\"]").test(line)) ?? link.getAttribute('onclick') ?? '';
        const params = call.match(/(?:from|to|subject|date|time)=[^'"\s)]*/g)?.join(';') ?? '';
        const values = new Map(params.split(';').map(part => {
          const equal = part.indexOf('=');
          const key = part.slice(0, equal);
          const value = part.slice(equal + 1).replaceAll('#_S_#', ';').replaceAll('#_E_#', '=').replaceAll('#_A_#', '&');
          try { return [key, decodeURIComponent(value)] as const; } catch { return [key, value] as const; }
        }));
        return { id,
          from: values.get('from') ?? text(`#area_mail_from_${CSS.escape(id)}`),
          to: values.get('to') ?? text(`#area_mail_to_${CSS.escape(id)}`),
          subject: text(`#area_mail_title_${CSS.escape(id)}`) || values.get('subject') || link.textContent?.trim() || '',
          receivedAt: text(`#area_mail_date_${CSS.escape(id)}`) || text(`#area_mail_time_${CSS.escape(id)}`) || values.get('date') || '',
          rowText: row?.textContent ?? '' };
      });
    });
    const declared = await this.page.locator('#area_maillist').evaluate(root => {
      const scripts = [...root.querySelectorAll('script')].map(s => s.textContent ?? '').join('\n');
      return scripts.match(/mailnumlist\s*=\s*['"]([^'"]*)['"]/)?.[1];
    });
    if ((declared && !mails.length) || mails.some(m => !/^\d+$/.test(m.id))) throw changed();
    const fresh = mails.filter(m => !found.has(m.id));
    for (const { rowText: _, ...mail } of fresh) found.set(mail.id, mail);
    const selected = [...found.values()].filter(m => !address || m.to.includes(address));
    if (!fresh.length || selected.length >= limit || id) return selected.slice(0, limit);
    await this.nextPage('mail', page + 1, address);
    }
    throw new CliError('PAGE_LIMIT', 'ページ数が上限を超えました。');
  }

  async read(id: string): Promise<Message> {
    if (!/^\d+$/.test(id)) throw new CliError('ARGUMENT', 'メールIDは数字で指定してください。', 2);
    const mail = (await this.mails(undefined, Number.MAX_SAFE_INTEGER, id)).find(m => m.id === id);
    if (!mail) throw new CliError('NOT_FOUND', 'メールが見つかりません。', 4);
    const frameSelector = `#area_maildata_iframe_${id}`;
    if (!(await this.page.locator(frameSelector).count())) await this.page.locator(`#link_maildata_${id}`).click();
    const frame = this.page.frameLocator(frameSelector);
    await frame.locator('body').waitFor();
    await this.page.waitForFunction(selector => {
      const iframe = document.querySelector(selector) as HTMLIFrameElement | null;
      return !!iframe?.contentDocument && iframe.contentDocument.URL !== 'about:blank' && iframe.contentDocument.readyState === 'complete';
    }, frameSelector);
    return { ...mail, body: await frame.locator('body').innerText() };
  }
}
