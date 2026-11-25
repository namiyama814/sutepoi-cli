import { mkdir, chmod, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import envPaths from 'env-paths';
import lockfile from 'proper-lockfile';
import { chromium, type BrowserContext } from 'playwright';
import { CliError } from './core.js';
import { CookieJar } from 'tough-cookie';
import { HttpTransport } from './http.js';
import { SITE } from './site.js';
export const configDir = envPaths('sutepoi', { suffix: '' }).config;
export async function hasSession(dir = configDir): Promise<boolean> {
  try { return JSON.parse(await readFile(path.join(dir, 'session.json'), 'utf8')).ready === true; } catch { return false; }
}
export const fingerprint = (id: string) => createHash('sha256').update(id).digest('hex');
export async function checkIdentity(id: string, dir = configDir) {
  const stored = JSON.parse(await readFile(path.join(dir, 'session.json'), 'utf8'));
  if (stored.identity !== fingerprint(id)) throw new CliError('AUTH', 'アカウントが変わりました。sutepoi loginを実行してください。', 3);
}
export async function markSession(id: string, dir = configDir) {
  await writeFile(path.join(dir, 'session.json'), JSON.stringify({ ready: true, identity: fingerprint(id) }), { mode: 0o600 });
}
export async function acquireProfile(dir = configDir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  let release: () => Promise<void>;
  try { release = await lockfile.lock(dir, { retries: 0, realpath: false }); }
  catch { throw new CliError('LOCKED', '別のsutepoiが実行中です。終了してから再実行してください。'); }
  return release;
}
export async function saveCookies(jar: CookieJar, dir = configDir) {
  const target = path.join(dir, 'http-cookies.json');
  const temp = target + '.tmp';
  await writeFile(temp, JSON.stringify(await jar.serialize()), {mode:0o600});
  await chmod(temp, 0o600);
  await rename(temp,target);
}
export async function exportBrowserCookies(context: BrowserContext, dir = configDir) {
  const jar = new CookieJar();
  for (const cookie of await context.cookies(SITE)) {
    const attrs = [`${cookie.name}=${cookie.value}`, `Path=${cookie.path}`];
    if (cookie.domain.startsWith('.')) attrs.push(`Domain=${cookie.domain}`);
    if (cookie.secure) attrs.push('Secure');
    if (cookie.httpOnly) attrs.push('HttpOnly');
    if (cookie.expires > 0) attrs.push(`Expires=${new Date(cookie.expires*1000).toUTCString()}`);
    await jar.setCookie(attrs.join('; '), SITE);
  }
  await saveCookies(jar,dir);
}
export async function openHttpSession(dir = configDir) {
  const release = await acquireProfile(dir);
  let jar: CookieJar;
  try { jar = await CookieJar.deserialize(await readFile(path.join(dir,'http-cookies.json'),'utf8')); }
  catch { await release(); throw new CliError('AUTH','HTTPS通信用のセッションがありません。sutepoi loginを実行してください。',3); }
  const transport = new HttpTransport(jar);
  let closing: Promise<void> | undefined;
  return { transport, close: () => closing ??= (async () => {
    transport.close();
    try { await saveCookies(jar,dir); } finally { await release(); }
  })() };
}
export async function openSession(headed: boolean, dir = configDir): Promise<{context: BrowserContext; close: () => Promise<void>}> {
  const release = await acquireProfile(dir);
  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(path.join(dir, 'browser'), { headless: !headed, locale: 'ja-JP' });
    context.setDefaultTimeout(15000);
    context.setDefaultNavigationTimeout(30000);
  } catch {
    await release();
    throw new CliError('BROWSER', 'ブラウザを起動できません。sutepoi setupを実行してください。');
  }
  let closed = false;
  return { context, close: async () => { if (closed) return; closed = true; try { await context.close(); } finally { await release(); } } };
}
