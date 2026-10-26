'use strict';
// Quality gates: detected from the repo, run by the runner (never self-reported
// by an agent). A failing gate sends the task back to a builder with the output.
const { spawnSync } = require('child_process');
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

/** Run all gates in `dir`. Returns { pass, results: [{name, cmd, pass, code, output, ms}] } */
function run(dir, gates, timeoutMs = 10 * 60 * 1000) {
  const results = [];
  let pass = true;
  for (const [name, cmd] of Object.entries(gates)) {
    const started = Date.now();
    const r = spawnSync('sh', ['-c', cmd], {
      cwd: dir, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', NODE_ENV: process.env.NODE_ENV || 'test' },
    });
    const out = ((r.stdout || '') + '\n' + (r.stderr || '')).trim();
    const ok = r.status === 0 && !r.error;
    if (!ok) pass = false;
    results.push({
      name, cmd, pass: ok, code: r.status, ms: Date.now() - started,
      timeout: !!(r.error && r.error.code === 'ETIMEDOUT'),
      output: out.length > 6000 ? out.slice(0, 2000) + '\n...\n' + out.slice(-4000) : out,
    });
    if (!ok) break; // first failure is enough; fix it, then run the rest
  }
  return { pass, results };
}

function summarize(res) {
  return res.results.map(r => `${r.name} ${r.pass ? 'pass' : 'FAIL'}`).join(' · ') || 'no gates';
}

module.exports = { detect, run, summarize, pkgManager };
