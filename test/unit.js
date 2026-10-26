#!/usr/bin/env node
// Fast unit checks for runner behaviour the e2e scenarios can't observe. No API calls.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const gates = require('../lib/gates');
const { runAgent } = require('../lib/claude');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('gates run without blocking the event loop', async () => {
  let ticks = 0;
  const iv = setInterval(() => ticks++, 50);
  const r = await gates.run(os.tmpdir(), { slow: 'sleep 1' }, 10000);
  clearInterval(iv);
  assert.strictEqual(r.pass, true);
  assert.ok(ticks >= 10, `event loop ticked only ${ticks} times during a 1s gate`);
});

test('gate failure and output are reported', async () => {
  const r = await gates.run(os.tmpdir(), { a: 'echo boom; exit 3', b: 'echo never' }, 10000);
  assert.strictEqual(r.pass, false);
  assert.strictEqual(r.results.length, 1, 'stops at first failure');
  assert.strictEqual(r.results[0].code, 3);
  assert.match(r.results[0].output, /boom/);
});

test('gate timeout kills the whole process tree', async () => {
  const marker = path.join(os.tmpdir(), `fleet-gate-${process.pid}`);
  const r = await gates.run(os.tmpdir(), { hang: `sh -c 'sleep 3; touch ${marker}' & wait` }, 500);
  assert.strictEqual(r.pass, false);
  assert.strictEqual(r.results[0].timeout, true);
  await new Promise(res => setTimeout(res, 3500));
  assert.ok(!fs.existsSync(marker), 'grandchild survived the timeout');
});

function fakeBin(body) {
  const f = path.join(os.tmpdir(), `fleet-fake-${process.pid}-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(f, `#!/usr/bin/env node\nconst emit=o=>process.stdout.write(JSON.stringify(o)+'\\n');\n${body}\n`, { mode: 0o755 });
  return f;
}

test('a timed-out call is charged its budget cap, not $0', async () => {
  const bin = fakeBin(`emit({type:'assistant',message:{content:[{type:'tool_use',name:'Bash',input:{command:'x'}}]}}); setInterval(()=>{},1000);`);
  const r = await runAgent({ bin, cwd: os.tmpdir(), prompt: 'x', budgetUsd: 4, timeoutMs: 700 });
  assert.strictEqual(r.status, 'timeout');
  assert.strictEqual(r.cost_estimated, true);
  assert.strictEqual(r.cost_usd, 4);
});

test('a call that dies before any turn costs $0', async () => {
  const bin = fakeBin(`process.exit(1);`);
  const r = await runAgent({ bin, cwd: os.tmpdir(), prompt: 'x', budgetUsd: 4, timeoutMs: 5000 });
  assert.strictEqual(r.status, 'crashed');
  assert.strictEqual(r.cost_usd, 0);
  assert.strictEqual(r.cost_estimated, false);
});

test('a reported cost is used as-is', async () => {
  const bin = fakeBin(`emit({type:'assistant',message:{content:[]}}); emit({type:'result',subtype:'success',total_cost_usd:0.37,result:'{}',structured_output:{}});`);
  const r = await runAgent({ bin, cwd: os.tmpdir(), prompt: 'x', budgetUsd: 4, timeoutMs: 5000, schema: {} });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.cost_usd, 0.37);
  assert.strictEqual(r.cost_estimated, false);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`ok   ${name}`); }
    catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
  }
  console.log(failed ? `${failed} failed` : `all ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
