import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { Site } from '../dist/site.js';

test('browser adapter against a local site: pagination, creation, read and failures', async () => {
  let rejectCreation=false;let malformed=false;let agreement=true;let networkFailure=false;let unknownCreation=false;let emptyBody=false;
  const server=createServer((req,res)=>{
    const url=new URL(req.url!,'http://localhost');
    res.setHeader('Content-Type','text/html; charset=utf-8');
    if(url.pathname==='/index.php' && url.searchParams.has('action')) {
      res.end(unknownCreation?'unexpected':rejectCreation?'NG:unavailable':'OK:new@example.com');return;
    }
    if(url.pathname==='/index._addrlist.php') {
      const page=Number(url.searchParams.get('page')??0);
      res.end(`<!--[OK]-->${page<2?`<span id="area_mailaddr_${page}">${page?'second':'first'}@example.com</span>`:''}`);return;
    }
    if(url.pathname==='/recv._ajax.php') {
      const page=Number(url.searchParams.get('page')??0);
      if(networkFailure){res.statusCode=500;res.end('failed');return;}
      if(malformed){res.end('unexpected');return;}
      const id=url.searchParams.get('mailid')==='999'?'999':String(page+1);
      res.end(`<!--[OK]-->${page<2 && id!=='999'?`
        <div id="area_mail_${id}"><a id="link_maildata_${id}" onclick="openMailData('${id}','key','from=alice%40example.com;to=first%40example.com;');return false;">open</a>
        <span id="area_mail_title_${id}">件名 ${id}</span><span id="area_mail_date_${id}">2026-11-25 12:00</span>
        <div id="area_maildata_iframe_${id}_master"></div></div>`:''}`);return;
    }
    if(url.pathname==='/body'){res.end(emptyBody?'<body></body>':'<body>本文です。</body>');return;}
    const inbox=url.pathname==='/recv.php';
    res.end(`<html><body><div id="area_numberview">test-account</div>
      <div id="${inbox?'area_maillist':'area_addrlist'}"><div class="loader"></div></div>
      <button id="link_addMailAddrByAuto" onclick="create('addMailAddrByAuto')">auto</button>
      <button id="link_addMailAddrByManual" onclick="document.querySelector('#manual').hidden=false">manual</button>
      <div id="manual" hidden><input id="input_manualmailaddr"><input type="radio" id="domain" name="input_manualmaildomain" value="example.com"><label for="domain">example.com</label>
      <button id="link_addMailAddrByManualSubmit" onclick="create('addMailAddrByManual')">create</button></div>
      <script>
      var confirmEULA='${agreement?'1':''}';
      async function load(endpoint,root,q){const r=await fetch(endpoint+'?'+q);document.querySelector(root).innerHTML=await r.text();}
      function viewAddrList(q){load('index._addrlist.php','#area_addrlist',q);}
      function viewMail(q){load('recv._ajax.php','#area_maillist',q);}
      function openMailData(id,key,param){document.querySelector('#area_maildata_iframe_'+id+'_master').innerHTML='<iframe id="area_maildata_iframe_'+id+'" src="/body"></iframe>';}
      function create(action){fetch('index.php?action='+action);}
      ${inbox?"viewMail(location.search.slice(1));":"viewAddrList('');"}
      </script></body></html>`);
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address && typeof address!=='string');
  const browser=await chromium.launch();
  try {
    const page=await browser.newPage();const site=new Site(page,`http://127.0.0.1:${address.port}/`);
    await site.home();assert.equal(await site.identity(),'test-account');
    assert.deepEqual(await site.addresses(),[{address:'first@example.com'},{address:'second@example.com'}]);
    assert.deepEqual(await site.create(),{address:'new@example.com'});
    assert.deepEqual(await site.create('new','example.com'),{address:'new@example.com'});
    const mails=await site.mails(undefined,10);
    assert.equal(mails.length,2);assert.equal(mails[0].from,'alice@example.com');assert.equal(mails[0].to,'first@example.com');
    assert.equal((await site.mails('other@example.com')).length,0);
    assert.equal((await site.mails(undefined,1)).length,1);
    assert.equal((await site.read('1')).body,'本文です。');
    emptyBody=true;assert.equal((await site.read('1')).body,'');
    site.expectedIdentity='wrong-account';await assert.rejects(site.home(),{code:'AUTH'});site.expectedIdentity=undefined;
    await assert.rejects(site.read('999'),{code:'NOT_FOUND'});
    await assert.rejects(site.read('invalid'),{code:'ARGUMENT'});
    await assert.rejects(site.create('new','missing.example'),{code:'ARGUMENT'});
    unknownCreation=true;await assert.rejects(site.create(),{code:'CREATE_UNKNOWN'});unknownCreation=false;
    rejectCreation=true;await assert.rejects(site.create(),{code:'CREATE_REJECTED'});
    agreement=false;await assert.rejects(site.create(),{code:'AGREEMENT'});
    networkFailure=true;await assert.rejects(site.mails(),{code:'NETWORK'});networkFailure=false;
    malformed=true;await assert.rejects(site.mails(),{code:'SITE_CHANGED'});
  } finally {
    await browser.close();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  }
});
