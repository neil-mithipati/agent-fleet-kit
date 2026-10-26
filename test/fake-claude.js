#!/usr/bin/env node
// A stand-in for `claude -p` so the whole pipeline (planning, worktrees, gates,
// boundary promotion, review loops, merges, releases) runs deterministically
// and for free. Behaviour is keyed off the role in --append-system-prompt and
// the scenario in FLEET_FAKE_SCENARIO. Emits the same stream-json the runner parses.
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const sys = flag('--append-system-prompt') || '';
const role = (/# Role: ([a-z-]+)/.exec(sys) || [])[1] || 'unknown';
const scenario = process.env.FLEET_FAKE_SCENARIO || 'default';
const prompt = fs.readFileSync(0, 'utf8');
const cwd = process.cwd();

const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const tool = (name, input) => emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name, input }] } });
const finish = (output, cost = 0.01) => {
  emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.12 }, seven_day: { utilization: 0.05 } } } });
  emit({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: cost, num_turns: 3, duration_ms: 1200, result: JSON.stringify(output), structured_output: output });
  process.exit(0);
};
const sh = (c) => execSync(c, { cwd, stdio: 'pipe' }).toString();
const write = (f, s) => { fs.mkdirSync(path.dirname(path.join(cwd, f)), { recursive: true }); fs.writeFileSync(path.join(cwd, f), s); };
const taskId = (/# Task (T-\d+)/.exec(prompt) || [])[1];
const title = (/# Task T-\d+: (.*)/.exec(prompt) || [])[1] || '';
const attempt = parseInt((/attempt (\d+)/.exec(prompt) || [])[1] || '1', 10);
const sleep = (ms) => { const end = Date.now() + ms; while (Date.now() < end) {} };

sleep(parseInt(process.env.FLEET_FAKE_DELAY_MS || '300', 10));

if (role === 'planner') {
  tool('Read', { file_path: 'package.json' });
  if (scenario === 'questions') finish({ mode: 'questions', summary: 'unclear', assumptions: [], questions: ['Which database should the app use?'], tasks: [] });
  // Escalate on anything that smells big, so planner-deep gets exercised.
  if (/app|scaffold|large/i.test(prompt) && !/tiny fix/i.test(prompt)) finish({ mode: 'escalate', summary: 'needs design', escalate_reason: 'new app from scratch', assumptions: [], tasks: [] });
  finish({ mode: 'plan', summary: 'one small fix', assumptions: ['keep it minimal'], tasks: [
    { id: 't1', title: 'create hello.txt', description: 'Create hello.txt containing "hello fleet".', size: 'small', files: ['hello.txt'], acceptance: ['hello.txt exists and contains hello fleet'], verify: ['grep -q "hello fleet" hello.txt'], depends_on: [] },
  ] });
}

if (role === 'planner-deep') {
  tool('Glob', { pattern: '**/*' });
  const tasks = [
    { id: 't1', title: 'scaffold node project with tests', description: 'Create package.json with a test script `node --test` and src/add.js exporting add(a,b).', size: 'large', files: ['package.json', 'src/add.js', 'test/add.test.js'], acceptance: ['npm test passes', 'src/add.js exports add'], verify: ['npm test'], depends_on: [] },
    { id: 't2', title: 'create hello.txt', description: 'Create hello.txt containing "hello fleet".', size: 'small', files: ['hello.txt'], acceptance: ['hello.txt contains hello fleet'], verify: [], depends_on: [] },
    { id: 't3', title: 'add sub to add.js and bump package version', description: 'Export sub(a,b) from src/add.js and set package.json version to 0.2.0.', size: 'small', files: ['src/add.js', 'package.json'], acceptance: ['sub exported', 'version 0.2.0'], verify: ['npm test'], depends_on: ['t1'] },
    { id: 't4', title: 'write README usage section', description: 'Add a Usage section to README.md showing add and sub.', size: 'medium', files: ['README.md'], acceptance: ['README has a Usage section'], verify: [], depends_on: ['t3'] },
  ];
  if (scenario === 'blocked') tasks.push({ id: 't5', title: 'ambiguous feature', description: 'Do the ambiguous thing.', size: 'medium', files: ['src/ambiguous.js'], acceptance: ['something'], verify: [], depends_on: [] });
  finish({ mode: 'plan', summary: 'tiny add library with tests', assumptions: ['plain node, no deps', 'node --test as runner'], stack: 'node', tasks }, 0.05);
}

if (role.startsWith('builder')) {
  tool('Read', { file_path: 'README.md' });
  tool('Bash', { command: 'ls', description: 'list files' });
  const gateFailPrev = /Gates failed on the previous attempt/.test(prompt);
  const reviewPrev = /Review findings to fix/.test(prompt);
  const humanNote = /Note from the human/.test(prompt);
  if (/scaffold/.test(title)) {
    write('package.json', JSON.stringify({ name: 'fake-app', version: '0.1.0', scripts: { test: 'node --test' } }, null, 2));
    write('src/add.js', "'use strict';\nmodule.exports = { add: (a, b) => a + b };\n");
    // scenario gatefail: first attempt writes a failing test, fixed on retry
    const broken = scenario === 'gatefail' && !gateFailPrev;
    write('test/add.test.js', `const test = require('node:test');\nconst assert = require('node:assert');\nconst { add } = require('../src/add.js');\ntest('add', () => assert.strictEqual(add(1, 2), ${broken ? 4 : 3}));\n`);
  } else if (/hello\.txt/.test(title)) {
    write('hello.txt', 'hello fleet\n');
  } else if (/sub to add/.test(title)) {
    write('src/add.js', "'use strict';\nmodule.exports = { add: (a, b) => a + b, sub: (a, b) => a - b };\n");
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')); pkg.version = '0.2.0';
    write('package.json', JSON.stringify(pkg, null, 2));
  } else if (/README/.test(title)) {
    const extra = (scenario === 'reviewfail' && !reviewPrev) ? '' : '\n```js\nconst { add, sub } = require("./src/add");\n```\n';
    fs.appendFileSync(path.join(cwd, 'README.md'), `\n## Usage\n${extra}`);
  } else if (/ambiguous/.test(title)) {
    if (!humanNote) finish({ status: 'blocked', summary: 'unclear', files_changed: [], notes: '', blocked_reason: 'What should the ambiguous thing actually do?' });
    write('src/ambiguous.js', '// resolved per human note\n');
  }
  sh('git add -A && git -c user.name=fake -c user.email=f@x commit -q -m "' + (taskId || 'x') + ': fake work" || true');
  finish({ status: 'done', summary: `Did: ${title}`, files_changed: ['(see diff)'], gates_run: 'npm test', notes: gateFailPrev ? 'fixed failing test' : reviewPrev ? 'added code sample per review' : '' }, role === 'builder-deep' ? 0.4 : role === 'builder' ? 0.15 : 0.03);
}

if (role.startsWith('reviewer')) {
  tool('Bash', { command: 'git diff', description: 'read diff' });
  const criteria = [...prompt.matchAll(/^\d+\. (.*)$/gm)].map(m => m[1]);
  let fail = false;
  if (scenario === 'reviewfail' && /README/.test(title) && !/```js/.test(prompt)) fail = true;
  if (scenario === 'escalate' && role === 'reviewer' && /README/.test(title)) finish({ verdict: 'escalate', criteria: criteria.map(c => ({ text: c, pass: true })), findings: [], scope_ok: true, summary: 'touches auth-ish things', escalate_reason: 'session handling', gates_run: 'npm test' }, 0.1);
  finish({
    verdict: fail ? 'fail' : 'pass',
    criteria: criteria.map(c => ({ text: c, pass: !fail, note: fail ? 'no code sample' : 'ok' })),
    findings: fail ? [{ severity: 'high', title: 'Usage section has no example', detail: 'README.md Usage section is empty; add a code sample', file: 'README.md' }] : (/sub to add/.test(title) ? [{ severity: 'low', title: 'no test for sub', detail: 'src/add.js sub has no unit test' }] : []),
    scope_ok: true, summary: fail ? 'criteria not met' : 'all criteria met', gates_run: 'npm test',
  }, role === 'reviewer-deep' ? 0.3 : 0.1);
}

if (role === 'publisher') {
  tool('Bash', { command: 'git log', description: 'read log' });
  finish({ bump: 'minor', headline: 'Tiny add library with tests', added: ['add and sub helpers', 'hello.txt'], changed: ['README usage section'], fixed: [], removed: [], internal: ['node --test wired as the test gate'], attention: ['version bumped to 0.2.0 by a small task; confirm that is wanted'] }, 0.05);
}

finish({ error: 'unknown role ' + role });
