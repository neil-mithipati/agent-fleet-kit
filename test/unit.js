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

const { shouldEscalate } = require('../lib/scheduler');
test('escalation policy: last_resort vs eager', () => {
  const cfg = (escalation) => ({ escalation, retries: { max_attempts: 3, max_review_rounds: 2 } });
  const t = (attempts, extra = {}) => ({ attempts, review_rounds: 0, gate_failures: 0, ...extra });
  const L = cfg('last_resort'), E = cfg('eager');
  // last_resort: same tier until the final attempt, and only for capability failures
  for (const k of ['failed', 'no_changes', 'gates_test']) {
    assert.strictEqual(shouldEscalate(L, t(1), k), false, `${k} after attempt 1`);
    assert.strictEqual(shouldEscalate(L, t(2), k), true, `${k} before final attempt`);
  }
  for (const k of ['timeout', 'max_turns', 'budget', 'crashed', 'error', 'bad_output', 'gates_mechanical', 'review'])
    assert.strictEqual(shouldEscalate(L, t(2, { gate_failures: 5, review_rounds: 5 }), k), false, `${k} never escalates`);
  assert.strictEqual(shouldEscalate(L, t(1), 'light_blocked'), true);
  // default is last_resort
  assert.strictEqual(shouldEscalate({ retries: { max_attempts: 3 } }, t(1), 'failed'), false);
  // eager keeps the original behaviour
  assert.strictEqual(shouldEscalate(E, t(1), 'failed'), true);
  assert.strictEqual(shouldEscalate(E, t(1), 'timeout'), true);
  assert.strictEqual(shouldEscalate(E, t(1), 'crashed'), false);
  assert.strictEqual(shouldEscalate(E, t(2), 'crashed'), true);
  assert.strictEqual(shouldEscalate(E, t(1, { gate_failures: 1 }), 'gates_test'), false);
  assert.strictEqual(shouldEscalate(E, t(1, { gate_failures: 2 }), 'gates_test'), true);
});

const { buildPrompt } = require('../lib/planner');
const { DEFAULTS } = require('../lib/config');
test('planner prompt carries the default stack and its rules', () => {
  const ctx = (stack) => ({ cfg: { ...DEFAULTS, stack }, state: { tasks: () => [] }, root: os.tmpdir(), base: 'main', gates: {} });
  const snap = { top: [], manifests: [], empty: true };
  const p = buildPrompt(ctx(DEFAULTS.stack), 'build a habit tracker', snap, null);
  assert.match(p, /# Default stack/);
  assert.match(p, /React \+ Vite/);
  assert.match(p, /Row Level Security/);
  assert.doesNotMatch(buildPrompt(ctx(null), 'x', snap, null), /Default stack/);
});

const connectMod = require('../lib/connect');
test('connect picks the publishable key, never service_role', () => {
  assert.strictEqual(connectMod.pickPublicKey([{ name: 'anon', api_key: 'a' }, { name: 'service_role', api_key: 's' }, { name: 'default', type: 'publishable', api_key: 'sb_publishable_p' }]), 'sb_publishable_p');
  assert.strictEqual(connectMod.pickPublicKey([{ name: 'service_role', api_key: 's' }, { name: 'anon', api_key: 'a' }]), 'a');
  assert.strictEqual(connectMod.pickPublicKey([{ name: 'service_role', api_key: 's' }]), null);
});
test('.env.local merge keeps other lines and updates keys in place', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-env-'));
  fs.writeFileSync(path.join(d, '.env.local'), '# mine\nSTRIPE_KEY=x\nVITE_SUPABASE_URL=old\n');
  connectMod.writeEnv(d, { VITE_SUPABASE_URL: 'new', VITE_SUPABASE_ANON_KEY: 'k' });
  assert.strictEqual(fs.readFileSync(path.join(d, '.env.local'), 'utf8'), '# mine\nSTRIPE_KEY=x\nVITE_SUPABASE_URL=new\nVITE_SUPABASE_ANON_KEY=k\n');
  assert.deepStrictEqual(connectMod.readEnv(d), { STRIPE_KEY: 'x', VITE_SUPABASE_URL: 'new', VITE_SUPABASE_ANON_KEY: 'k' });
});
test('a repo with only init/connect files still counts as empty', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-snap-'));
  for (const f of ['README.md', 'CHANGELOG.md', '.gitignore', '.env.local']) fs.writeFileSync(path.join(d, f), '');
  for (const f of ['supabase', '.vercel', '.fleet']) fs.mkdirSync(path.join(d, f));
  assert.strictEqual(require('../lib/planner').repoSnapshot(d).empty, true);
  fs.writeFileSync(path.join(d, 'package.json'), '{}');
  assert.strictEqual(require('../lib/planner').repoSnapshot(d).empty, false);
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
