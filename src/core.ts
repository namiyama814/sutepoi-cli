import { stripVTControlCharacters } from 'node:util';
export class CliError extends Error {
  constructor(public code: string, message: string, public exitCode = 1) { super(message); }
}
export interface Address { address: string }
export interface Mail { id: string; from: string; to: string; subject: string; receivedAt: string }
export interface Message extends Mail { body: string }
export function clean(value: string): string {
  return stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').replace(/[\u202a-\u202e\u2066-\u2069]/g, '');
}
export function sanitize(value: unknown): unknown {
  if (typeof value === 'string') return clean(value);
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,sanitize(v)]));
  return value;
}
export function integer(value: string, minimum = 1): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum) throw new CliError('ARGUMENT', `${minimum}以上の整数を指定してください。`, 2);
  return Number(value);
}
export async function watchMail(options: {
  list: () => Promise<Mail[]>; emit: (mail: Mail) => void;
  interval: number; timeout?: number; signal: AbortSignal;
}) {
  const seen = new Set((await options.list()).map(m => m.id));
  const deadline = options.timeout === undefined ? Infinity : Date.now() + options.timeout * 1000;
  while (!options.signal.aborted && Date.now() < deadline) {
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); options.signal.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, Math.min(options.interval * 1000, deadline - Date.now()));
      options.signal.addEventListener('abort', finish, { once: true });
      if (options.signal.aborted) finish();
    });
    if (options.signal.aborted || Date.now() >= deadline) break;
    const mails = await options.list();
    if (options.signal.aborted) break;
    for (const mail of mails.reverse()) {
      if (!seen.has(mail.id)) { options.emit(mail); seen.add(mail.id); }
    }
  }
}
