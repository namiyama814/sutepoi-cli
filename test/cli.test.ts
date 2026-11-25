import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const run = (...args: string[]) => spawnSync(process.execPath,['dist/cli.js',...args],{encoding:'utf8'});
test('CLI help and JSON argument errors', () => {
  const help=run('--help');assert.equal(help.status,0);assert.match(help.stdout,/addresses/);assert.equal(help.stderr,'');
  for(const args of [['--json','mail','list','--limit','0'],['--json','addresses','create','--name','only'],['--json','mail','watch','--interval','9'],['--json','mail','read','invalid'],['--json','unknown']]) {
    const result=run(...args);assert.equal(result.status,2);assert.equal(result.stdout,'');assert.equal(JSON.parse(result.stderr).error.code,'ARGUMENT');
  }
  const login=run('--json','login');assert.equal(login.status,2);assert.equal(JSON.parse(login.stderr).error.code,'TTY');
});
