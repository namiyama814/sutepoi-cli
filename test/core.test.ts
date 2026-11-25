import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clean, integer, sanitize, watchMail, type Mail } from '../dist/core.js';
const mail = (id: string): Mail => ({id,from:'a@example.com',to:'b@example.com',subject:'test',receivedAt:'2026-11-25'});
test('terminal escape sequences and bidi controls are removed recursively', () => {
  assert.equal(clean('\x1b[31mred\x1b[0m\x1b]0;title\x07\x00\u202e'), 'red');
  assert.deepEqual(sanitize([{subject:'\x1b[2Jhello',body:'a\nb\tc'}]), [{subject:'hello',body:'a\nb\tc'}]);
});
test('numeric arguments reject unsafe and fractional values', () => {
  for (const value of ['0','-1','1.5','NaN','9007199254740992']) assert.throws(() => integer(value));
  assert.throws(() => integer('9',10)); assert.equal(integer('10',10),10);
});
test('watch skips initial mail and deduplicates subsequent polls', async () => {
  const controller = new AbortController(); const emitted: string[] = []; let calls = 0;
  await watchMail({list:async () => {
    calls++; if (calls===4) controller.abort();
    return calls===1 ? [mail('1')] : [mail('2'),mail('1')];
  },emit:m=>emitted.push(m.id),interval:0.001,signal:controller.signal});
  assert.deepEqual(emitted,['2']);
});
test('watch timeout ends without another poll', async () => {
  let calls=0;
  await watchMail({list:async()=>{calls++;return [];},emit:()=>assert.fail(),interval:10,timeout:0.01,signal:new AbortController().signal});
  assert.equal(calls,1);
});
test('watch abort interrupts a long polling delay', async () => {
  const controller = new AbortController();
  const start = Date.now();setTimeout(()=>controller.abort(),10);
  await watchMail({list:async()=>[],emit:()=>assert.fail(),interval:30,signal:controller.signal});
  assert.ok(Date.now()-start<1000);
});
