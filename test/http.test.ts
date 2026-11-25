import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { HttpTransport } from '../dist/http.js';
import { HttpSite, mailRecords } from '../dist/http-site.js';

test('direct HTTP adapter: cookies, CSRF, pagination, POST body, errors and safe parsing', async () => {
  let unknown=false; let rejected=false; let failed=false;let changed=false;let account='account-a';
  let mutations=0;let bodyRequests=0;const requests: string[]=[];
  const server=createServer(async(req,res)=>{
    const u=new URL(req.url!,'http://localhost');requests.push(u.pathname);
    if(u.pathname==='/redirect'){res.writeHead(302,{Location:'https://example.com/', 'Set-Cookie':'secret=value; Path=/'});res.end();return;}
    if(u.pathname==='/repeat'){res.writeHead(302,{Location:'/repeat'});res.end();return;}
    if(u.pathname==='/rotate'){res.setHeader('Set-Cookie','session=rotated; Path=/; HttpOnly');res.end('ok');return;}
    if(u.pathname==='/index.php'&&!u.searchParams.has('action')) {
      res.setHeader('Set-Cookie','session=valid; Path=/; HttpOnly');
      res.end(`<div id="area_numberview">${account}</div><input name="input_manualmaildomain" value="example.com"><script>var confirmEULA='1';var token='csrf_token_check=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';</script>`);return;
    }
    assert.match(req.headers.cookie??'',/session=valid/);
    if(u.pathname==='/recv.php') {res.end(`<script>var token='csrf_token_check=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';</script>`);return;}
    if(u.pathname==='/smphone.app.recv.view.php') {
      bodyRequests++;assert.equal(req.method,'POST');let body='';for await(const data of req)body+=data;
      const form=new URLSearchParams(body);assert.equal(form.get('num'),'1');assert.equal(form.get('key'),'secret-key');
      res.end('<html><body><script>throw new Error("never run")</script><style>secret{}</style><p>本文</p><p>次の行</p></body></html>');return;
    }
    const inbox=u.pathname==='/recv._ajax.php';
    assert.equal(u.searchParams.get('csrf_token_check'),(inbox?'b':'a').repeat(32));
    if(u.pathname==='/index.php') {mutations++;res.end(unknown?'unexpected':rejected?'NG:denied':'OK:new@example.com');return;}
    if(failed){res.statusCode=500;res.end('failure');return;}
    if(changed){res.end('changed');return;}
    const page=Number(u.searchParams.get('page')??0);
    if(!inbox){res.end(`<!--[OK]-->${page<2?`<span id="area_mailaddr_${page}">addr${page}@example.com</span>`:''}`);return;}
    const id=String(page+1);
    res.end(`<!--[OK]-->${page<2 && u.searchParams.get('mailid')!=='999'?`
      <div id="area_mail_${id}"><a id="link_maildata_${id}">read</a><span id="area_mail_title_${id}">件名</span><span id="area_mail_date_${id}">today</span></div>
      <script>$('#link_maildata_${id}').on('click',function(){openMailData('${id}','secret-key','from=alice%40example.com;to=addr0%40example.com;');});</script>`:''}`);
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address && typeof address!=='string');
  const transport=new HttpTransport(undefined,`http://127.0.0.1:${address.port}/`);const site=new HttpSite(transport);
  try {
    await site.home();assert.equal(await site.identity(),'account-a');site.expectedIdentity='account-a';
    assert.equal((await site.addresses()).length,2);
    assert.equal((await site.mails()).length,2);
    assert.equal((await site.mails('addr0@example.com',1))[0].from,'alice@example.com');
    assert.equal((await site.mails('other@example.com')).length,0);
    assert.deepEqual(await site.create('new','example.com'),{address:'new@example.com'});
    unknown=true;const before=mutations;await assert.rejects(site.create(),{code:'CREATE_UNKNOWN'});assert.equal(mutations,before+1);unknown=false;
    rejected=true;await assert.rejects(site.create(),{code:'CREATE_REJECTED'});rejected=false;
    const message=await site.read('1');assert.equal(message.body,'本文\n\n次の行');assert.ok(!('key' in message));assert.equal(bodyRequests,1);
    await assert.rejects(site.read('999'),{code:'NOT_FOUND'});
    await assert.rejects(site.read('../1'),{code:'ARGUMENT'});
    failed=true;await assert.rejects(site.mails(),{code:'NETWORK'});failed=false;
    changed=true;await assert.rejects(site.mails(),{code:'SITE_CHANGED'});changed=false;
    account='account-b';await assert.rejects(site.home(),{code:'AUTH'});
    await assert.rejects(transport.request('/repeat',{},'GET',false),{code:'NETWORK'});
    assert.equal(requests.filter(p=>p==='/repeat').length,1);
    await assert.rejects(transport.request('/redirect'),{code:'ORIGIN'});
    await assert.rejects(transport.request('https://example.com/'),{code:'ORIGIN'});
    await transport.request('/rotate');assert.equal((await transport.jar.getCookies(transport.base.href)).find(c=>c.key==='session')?.value,'rotated');
    assert.ok(requests.includes('/smphone.app.recv.view.php'));
  } finally {transport.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
test('HTTPS required except loopback fixtures; metadata scripts never execute', () => {
  assert.throws(()=>new HttpTransport(undefined,'http://example.com/'),{code:'PROTOCOL'});
  assert.equal(new HttpTransport().base.protocol,'https:');
  const records=mailRecords(`<a id="link_maildata_123">read</a><script>globalThis.compromised=true;openMailData('123','key','from=a%2Bb%40example.com;to=c%40example.com;');</script>`);
  assert.equal(records[0].from,'a+b@example.com');assert.equal((globalThis as any).compromised,undefined);
  assert.throws(()=>mailRecords(`<a id="link_maildata_123"></a><script>openMailData('123',steal(),'from=a');</script>`),{code:'SITE_CHANGED'});
});
