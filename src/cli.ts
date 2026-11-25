#!/usr/bin/env node
import { Command, CommanderError } from 'commander';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline/promises';
import { CliError, integer, sanitize, watchMail } from './core.js';
import { checkIdentity, hasSession, markSession, openSession, openHttpSession, exportBrowserCookies } from './session.js';
import { Site } from './site.js';
import { HttpSite } from './http-site.js';
type SiteClient = Pick<Site, 'home' | 'identity' | 'addresses' | 'create' | 'mails' | 'read' | 'expectedIdentity'>;

const program = new Command().name('sutepoi').description('捨てメアドぽいぽい CLI').version('0.1.0')
  .option('--json', 'JSONで出力').option('--headed', 'ブラウザを表示');
const controller = new AbortController();
let close: (() => Promise<void>) | undefined;
let interrupted = false;
for (const event of ['SIGINT', 'SIGTERM'] as const) process.on(event, () => {
  interrupted = true;
  controller.abort();
  void close?.().catch(() => undefined);
  process.exitCode = event === 'SIGINT' ? 130 : 143;
});
function output(value: unknown) {
  const safe = sanitize(value);
  if (program.opts().json) { console.log(JSON.stringify(safe)); return; }
  if (Array.isArray(safe)) { for (const item of safe) output(item); return; }
  if (safe && typeof safe === 'object') {
    const row = safe as Record<string, unknown>;
    if ('body' in row) {
      console.log(`${row.subject}\n${row.from}\n${row.to}\n${row.receivedAt}\n\n${row.body}`);
    } else console.log(Object.values(row).join('\t'));
  } else console.log(safe);
}
async function withSite(run: (site: SiteClient) => Promise<void>, login = false) {
  if (!login && !(await hasSession())) throw new CliError('AUTH', 'sutepoi loginを実行してください。', 3);
  if (!login && !program.opts().headed) {
    const session = await openHttpSession();
    close = session.close;
    try {
      if (controller.signal.aborted) return;
      const site = new HttpSite(session.transport);
      await site.home();
      const id = await site.identity();
      await checkIdentity(id);
      site.expectedIdentity = id;
      await run(site);
    } finally { await session.close(); close = undefined; }
    return;
  }
  const session = await openSession(true);
  close = session.close;
  try {
    if (controller.signal.aborted) return;
    const page = session.context.pages()[0] ?? await session.context.newPage();
    const site = new Site(page);
    await site.home();
    if (!login) {
      const id = await site.identity();
      await checkIdentity(id);
      site.expectedIdentity = id;
    }
    await run(site);
    await exportBrowserCookies(session.context);
  } finally { await session.close(); close = undefined; }
}
program.command('setup').description('Chromiumをインストール').action(async () => {
  const require = createRequire(import.meta.url);
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [require.resolve('playwright/cli'), 'install', 'chromium'], { stdio: ['inherit', 'pipe', 'pipe'] });
    child.stdout.on('data', data => process.stderr.write(data));
    child.stderr.on('data', data => process.stderr.write(data));
    child.on('error', reject); child.on('exit', code => resolve(code ?? 1));
    controller.signal.addEventListener('abort', () => child.kill(), { once: true });
  });
  if (code) throw new CliError('SETUP', 'Chromiumのインストールに失敗しました。');
  output({ installed: true });
});
program.command('login').description('ブラウザでログイン').action(async () => {
  if (!process.stdin.isTTY) throw new CliError('TTY', '対話可能なターミナルでsutepoi loginを実行してください。', 2);
  await withSite(async site => {
    console.error('ブラウザでログイン、または新規利用を開始してください。');
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try { await rl.question('完了したらEnterを押してください。 ', { signal: controller.signal }); }
    finally { rl.close(); }
    await site.home();
    await markSession(await site.identity());
    output({ authenticated: true });
  }, true);
});
program.command('status').description('接続状態を確認').action(async () => {
  if (!(await hasSession())) { output({ saved: false, connected: false }); return; }
  await withSite(async () => output({ saved: true, connected: true }));
});
const addresses = program.command('addresses').description('アドレスを操作');
addresses.command('list').description('アドレスを一覧表示').action(async () => withSite(async site => output(await site.addresses())));
addresses.command('create').description('アドレスを1件作成').option('--name <name>', 'アカウント名').option('--domain <domain>', 'ドメイン').action(async options => {
  if (Boolean(options.name) !== Boolean(options.domain)) throw new CliError('ARGUMENT', '--nameと--domainを両方指定してください。', 2);
  if (options.name && (!/^[a-zA-Z0-9._+-]+$/.test(options.name) || !/^[a-zA-Z0-9.-]+$/.test(options.domain))) throw new CliError('ARGUMENT', '名前またはドメインの形式を確認してください。', 2);
  await withSite(async site => output(await site.create(options.name, options.domain)));
});
const mail = program.command('mail').description('受信メールを読む');
mail.command('list').description('受信メールを一覧表示').option('--address <address>', '宛先で絞り込み').option('--limit <number>', '表示件数', '20').action(async options => {
  const limit = integer(options.limit);
  await withSite(async site => output(await site.mails(options.address, limit)));
});
mail.command('read <id>').description('メール本文を表示').action(async id => {
  if (!/^\d+$/.test(id)) throw new CliError('ARGUMENT', 'メールIDは数字で指定してください。', 2);
  await withSite(async site => output(await site.read(id)));
});
mail.command('watch').description('新着メールを待機').option('--address <address>', '宛先で絞り込み').option('--interval <seconds>', '確認間隔（最短10秒）', '30').option('--timeout <seconds>', '待機時間').action(async options => {
  const interval = integer(options.interval, 10);
  const timeout = options.timeout === undefined ? undefined : integer(options.timeout);
  await withSite(async site => {
    await watchMail({ list: async () => {
      await site.home();
      await checkIdentity(await site.identity());
      return site.mails(options.address, Number.MAX_SAFE_INTEGER);
    }, emit: output, interval, timeout, signal: controller.signal });
  });
});
program.exitOverride();
program.configureOutput({ outputError: () => undefined });
try { await program.parseAsync(); }
catch (error) {
  if (!interrupted && error instanceof CommanderError) {
    process.exitCode = error.exitCode === 0 ? 0 : 2;
    if (error.exitCode !== 0) console.error(program.opts().json ? JSON.stringify({error:{code:'ARGUMENT',message:error.message}}) : error.message);
  } else if (!interrupted) {
    const e = error instanceof CliError ? error : new CliError('OPERATION', '操作に失敗しました。接続とログイン状態を--headedで確認してください。');
    console.error(program.opts().json ? JSON.stringify({ error: { code: e.code, message: e.message } }) : e.message);
    process.exitCode = e.exitCode;
  }
}
