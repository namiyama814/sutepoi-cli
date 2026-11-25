import { load } from 'cheerio';
import { parse } from 'acorn';
import { simple } from 'acorn-walk';
import { convert } from 'html-to-text';
import { CliError, type Address, type Mail, type Message } from './core.js';
import { HttpTransport } from './http.js';
const changed = () => new CliError('SITE_CHANGED', '内部APIの応答を解析できません。--headedで確認してください。');
interface MailRecord extends Mail { key: string }
/** Parse literal call arguments without executing scripts returned by the service. */
export function mailRecords(html: string): MailRecord[] {
  const $ = load(html); const calls = new Map<string, {key: string; params: string}>();
  const scripts = $('script').map((_, el) => $(el).html() ?? '').get();
  $('[onclick]').each((_, el) => { scripts.push($(el).attr('onclick') ?? ''); });
  for (const source of scripts) {
    try {
      simple(parse(source, {ecmaVersion:'latest', allowReturnOutsideFunction:true}), {
        CallExpression(node) {
          if (node.callee.type !== 'Identifier' || node.callee.name !== 'openMailData') return;
          const args = node.arguments.map(arg => arg.type === 'Literal' ? arg.value : undefined);
          if (args.length >= 3 && args.slice(0,3).every(a => typeof a === 'string' || typeof a === 'number')) {
            calls.set(String(args[0]), {key:String(args[1]), params:String(args[2])});
          }
        },
      });
    } catch { /* Unrelated scripts may use syntax unsupported by the parser. */ }
  }
  const records: MailRecord[] = [];
  $('[id^="link_maildata_"]').each((_, el) => {
    const id = $(el).attr('id')!.slice('link_maildata_'.length);
    if (!/^\d+$/.test(id)) throw changed();
    const call = calls.get(id);
    if (!call) throw changed();
    const values = new Map(call.params.split(';').map(part => {
      const equal = part.indexOf('=');
      const value = part.slice(equal + 1).replaceAll('#_S_#',';').replaceAll('#_E_#','=').replaceAll('#_A_#','&');
      try { return [part.slice(0,equal),decodeURIComponent(value)]; } catch { return [part.slice(0,equal),value]; }
    }));
    records.push({ id, key:call.key, from:values.get('from') ?? $(`#area_mail_from_${id}`).text().trim(),
      to:values.get('to') ?? $(`#area_mail_to_${id}`).text().trim(),
      subject:$(`#area_mail_title_${id}`).text().trim() || values.get('subject') || $(el).text().trim(),
      receivedAt:$(`#area_mail_date_${id}`).text().trim() || $(`#area_mail_time_${id}`).text().trim() || values.get('date') || '' });
  });
  const declared = scripts.join('\n').match(/mailnumlist\s*=\s*['"]([^'"]*)['"]/)?.[1];
  if (declared && !records.length) throw changed();
  return records;
}
export class HttpSite {
  expectedIdentity?: string;
  private id = '';
  private csrf = '';
  private homeHtml = '';
  constructor(readonly transport: HttpTransport) {}
  private token(html: string) {
    const token = html.match(/csrf_token_check[=:'"\s]+([a-f0-9]{16,})/i)?.[1];
    if (!token) throw new CliError('AUTH', 'セッションまたは追加認証を確認してください。sutepoi loginを実行してください。', 3);
    this.csrf = token;
  }
  async home() {
    const html = await this.transport.request('index.php');
    const id = load(html)('#area_numberview').text().trim();
    if (!id || (this.expectedIdentity && id !== this.expectedIdentity)) throw new CliError('AUTH', 'アカウントを確認できません。sutepoi loginを実行してください。', 3);
    this.id = id; this.homeHtml = html; this.token(html);
  }
  async identity() { if (!this.id) throw new CliError('AUTH', 'sutepoi loginを実行してください。',3); return this.id; }
  private async api(file: string, params: Record<string,string>) {
    return this.transport.request(file, {...params,nopost:'1',csrf_token_check:this.csrf}, 'GET', !params.action?.startsWith('addMailAddr'));
  }
  private ok(html: string) { if (!html.includes('[OK]')) throw changed(); }
  async addresses(): Promise<Address[]> {
    await this.home(); const found = new Set<string>();
    for (let page=0; page<1000; page++) {
      const html = await this.api('index._addrlist.php',{page:String(page)}); this.ok(html);
      const $ = load(html);
      const items = $('[id^="area_mailaddr_"]').map((_, el)=>$(el).text().trim()).get().filter(a=>/^[^\s@]+@[^\s@]+$/.test(a));
      const fresh = items.filter(a=>!found.has(a));
      if (!fresh.length) return [...found].map(address=>({address}));
      for (const address of fresh) found.add(address);
    }
    throw new CliError('PAGE_LIMIT','ページ数が上限を超えました。');
  }
  async create(name?: string, domain?: string): Promise<Address> {
    await this.home();
    if (!/\bconfirmEULA\s*=\s*['"]1['"]/.test(this.homeHtml)) throw new CliError('AGREEMENT','sutepoi loginで利用規約を確認し、ブラウザでアドレスを作成してください。',3);
    if (Boolean(name) !== Boolean(domain)) throw new CliError('ARGUMENT','--nameと--domainを両方指定してください。',2);
    const $ = load(this.homeHtml);
    if (domain && !$('input[name="input_manualmaildomain"]').toArray().some(el=>$(el).attr('value')===domain)) throw new CliError('ARGUMENT','指定したドメインは利用できません。',2);
    const params: Record<string,string> = {action:name?'addMailAddrByManual':'addMailAddrByAuto',by_system:'1',recaptcha_token:''};
    if (name && domain) { params.newuser=name;params.newdomain=domain; }
    try {
      const result = await this.api('index.php',params);
      if (result.startsWith('NG:')) throw new CliError('CREATE_REJECTED','アドレスを作成できません。--headedで確認してください。');
      const address = result.startsWith('OK:') ? result.slice(3).split(',,')[0].trim() : '';
      if (!/^[^\s@]+@[^\s@]+$/.test(address)) throw new Error();
      return {address};
    } catch (error) {
      if (error instanceof CliError && error.code === 'CREATE_REJECTED') throw error;
      throw new CliError('CREATE_UNKNOWN','作成結果を確認できません。sutepoi addresses listで確認してください。');
    }
  }
  private async records(address?: string, limit=20, id?: string): Promise<MailRecord[]> {
    await this.home();
    this.token(await this.transport.request('recv.php'));
    const found = new Map<string,MailRecord>();
    for (let page=0;page<1000;page++) {
      const html=await this.api('recv._ajax.php',{page:String(page),...(address?{q:address}:{}),...(id?{mailid:id}:{})});this.ok(html);
      const fresh=mailRecords(html).filter(m=>!found.has(m.id));
      for (const mail of fresh) found.set(mail.id,mail);
      const selected=[...found.values()].filter(m=>!address || m.to.includes(address));
      if (!fresh.length || selected.length>=limit || id) return selected.slice(0,limit);
    }
    throw new CliError('PAGE_LIMIT','ページ数が上限を超えました。');
  }
  async mails(address?:string,limit=20,id?:string):Promise<Mail[]> {
    return (await this.records(address,limit,id)).map(({key:_,...mail})=>mail);
  }
  async read(id:string):Promise<Message> {
    if (!/^\d+$/.test(id)) throw new CliError('ARGUMENT','メールIDは数字で指定してください。',2);
    const record=(await this.records(undefined,Number.MAX_SAFE_INTEGER,id)).find(m=>m.id===id);
    if (!record) throw new CliError('NOT_FOUND','メールが見つかりません。',4);
    const html=await this.transport.request('smphone.app.recv.view.php',{num:id,key:record.key,noscroll:'1'},'POST');
    const $=load(html);$('script,style,noscript').remove();
    const {key:_,...mail}=record;
    return {...mail,body:convert($.html(),{wordwrap:false,selectors:[{selector:'img',format:'skip'},{selector:'a',options:{ignoreHref:true}}]}).trim()};
  }
}
