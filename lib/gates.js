'use strict';
// Quality gates: detected from the repo, run by the runner (never self-reported
// by an agent). A failing gate sends the task back to a builder with the output.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function exists(dir, f) { return fs.existsSync(path.join(dir, f)); }
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }

function pkgManager(dir) {
  if (exists(dir, 'pnpm-lock.yaml')) return 'pnpm';
  if (exists(dir, 'yarn.lock')) return 'yarn';
  if (exists(dir, 'bun.lockb') || exists(dir, 'bun.lock')) return 'bun';
  return 'npm';
}

/** Detect gates for the project in `dir`. Returns { name: command } (ordered). */
function detect(dir, overrides = {}) {
  const gates = {};
  const pkg = readJson(path.join(dir, 'package.json'));
  if (pkg) {
    const pm = pkgManager(dir);
    const run = (s) => (pm === 'npm' ? `npm run ${s} --silent` : `${pm} run ${s}`);
    const scripts = pkg.scripts || {};
    if (scripts.typecheck) gates.typecheck = run('typecheck');
    else if (scripts['type-check']) gates.typecheck = run('type-check');
    else if (exists(dir, 'tsconfig.json')) gates.typecheck = 'npx tsc --noEmit -p tsconfig.json';
    if (scripts.lint) gates.lint = run('lint');
    if (scripts.test && !/no test specified/.test(scripts.test)) {
      gates.test = pm === 'npm' ? 'npm test --silent' : `${pm} test`;
    }
    if (scripts.build && !scripts.test && !gates.typecheck) gates.build = run('build');
  }
  if (exists(dir, 'pyproject.toml') || exists(dir, 'requirements.txt') || exists(dir, 'setup.py')) {
    const py = exists(dir, '.venv/bin/python') ? '.venv/bin/python' : 'python3';
    if (exists(dir, 'ruff.toml') || /\[tool\.ruff\]/.test(safeRead(path.join(dir, 'pyproject.toml')))) gates.lint = `${py} -m ruff check .`;
    if (exists(dir, 'tests') || exists(dir, 'test') || /pytest/.test(safeRead(path.join(dir, 'pyproject.toml')))) gates.test = `${py} -m pytest -q -x`;
  }
  if (exists(dir, 'go.mod')) { gates.build = 'go build ./... && go vet ./...'; gates.test = 'go test ./...'; }
  if (exists(dir, 'Cargo.toml')) { gates.build = 'cargo build --quiet'; gates.test = 'cargo test --quiet'; }
  for (const [k, v] of Object.entries(overrides || {})) {
    if (v === null || v === false) delete gates[k]; else if (typeof v === 'string') gates[k] = v;
  }
  return gates;
}

function safeRead(f) { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } }

/** Run one shell command without blocking the event loop. Kills the process group on timeout. */
function runOne(dir, cmd, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const MAX = 2 * 1024 * 1024; // keep the head and tail of large outputs only
    let out = '', dropped = false, timedOut = false, done = false;
    const keep = (d) => { out += d.toString(); if (out.length > MAX) { out = out.slice(0, MAX / 4) + '\n...\n' + out.slice(-MAX / 2); dropped = true; } };
    let child;
    try {
      child = spawn('sh', ['-c', cmd], {
        cwd: dir, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', NODE_ENV: process.env.NODE_ENV || 'test' },
      });
    } catch (e) { return resolve({ code: null, error: e, out: e.message, ms: 0, timeout: false }); }
    const kill = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} } };
    const timer = setTimeout(() => { timedOut = true; kill('SIGTERM'); setTimeout(() => kill('SIGKILL'), 5000).unref(); }, timeoutMs);
    const onExit = () => kill('SIGKILL');
    process.on('exit', onExit);
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    const finish = (code, error) => {
      if (done) return; done = true;
      clearTimeout(timer); process.removeListener('exit', onExit);
      resolve({ code, error, out: out + (dropped ? '\n(output truncated)' : ''), ms: Date.now() - started, timeout: timedOut });
    };
    child.on('error', (e) => finish(null, e));
    child.on('close', (code) => finish(timedOut ? null : code, timedOut ? Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) : null));
  });
}

/** Run all gates in `dir`. Async: other agents keep streaming while gates run.
 *  Returns { pass, results: [{name, cmd, pass, code, output, ms, timeout}] } */
async function run(dir, gates, timeoutMs = 10 * 60 * 1000) {
  const results = [];
  let pass = true;
  for (const [name, cmd] of Object.entries(gates)) {
    const r = await runOne(dir, cmd, timeoutMs);
    const out = (r.out || '').trim();
    const ok = r.code === 0 && !r.error;
    if (!ok) pass = false;
    results.push({
      name, cmd, pass: ok, code: r.code, ms: r.ms, timeout: r.timeout,
      output: (r.timeout ? `(timed out after ${Math.round(timeoutMs / 60000)} min)\n` : '') + (out.length > 6000 ? out.slice(0, 2000) + '\n...\n' + out.slice(-4000) : out),
    });
    if (!ok) break; // first failure is enough; fix it, then run the rest
  }
  return { pass, results };
}

function summarize(res) {
  return res.results.map(r => `${r.name} ${r.pass ? 'pass' : 'FAIL'}`).join(' · ') || 'no gates';
}

module.exports = { detect, run, summarize, pkgManager };
