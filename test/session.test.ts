import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkIdentity, hasSession, markSession, openSession, openHttpSession, exportBrowserCookies } from '../dist/session.js';
test('session locks, permissions, identity and cleanup', async () => {
  const dir=await mkdtemp(path.join(tmpdir(),'sutepoi-test-'));
  try {
    assert.equal(await hasSession(dir),false);
    await markSession('private-account-id',dir);
    assert.equal(await hasSession(dir),true);
    assert.ok(!(await readFile(path.join(dir,'session.json'),'utf8')).includes('private-account-id'));
    await checkIdentity('private-account-id',dir);
    await assert.rejects(checkIdentity('different',dir),{code:'AUTH'});
    const session=await openSession(false,dir);
    try {
      await assert.rejects(openSession(false,dir),{code:'LOCKED'});
      await assert.rejects(openHttpSession(dir),{code:'LOCKED'});
      await session.context.addCookies([{name:'test_session',value:'private-cookie',domain:'m.kuku.lu',path:'/',secure:true,httpOnly:true}]);
      await exportBrowserCookies(session.context,dir);
      if (process.platform!=='win32') {
        assert.equal((await stat(dir)).mode & 0o777,0o700);
        assert.equal((await stat(path.join(dir,'session.json'))).mode & 0o777,0o600);
      }
    } finally {await session.close();await session.close();}
    const http=await openHttpSession(dir);
    assert.match(await http.transport.jar.getCookieString('https://m.kuku.lu/'),/test_session=private-cookie/);
    await http.transport.jar.setCookie('rotated=next; Secure; Path=/','https://m.kuku.lu/');
    await http.close();await http.close();
    const nextHttp=await openHttpSession(dir);
    assert.match(await nextHttp.transport.jar.getCookieString('https://m.kuku.lu/'),/rotated=next/);
    await nextHttp.close();
    const again=await openSession(false,dir);await again.close();
  } finally {await rm(dir,{recursive:true,force:true});}
});
