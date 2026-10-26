'use strict';
// Async process runner with arg arrays (no shell), a timeout that kills the
// process group, and stdin closed so a CLI that wants to prompt fails fast
// instead of hanging.
const { spawn } = require('child_process');

function run(bin, args, opts = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', timedOut = false, done = false;
    let child;
    try {
      child = spawn(bin, args, { cwd: opts.cwd, detached: true, stdio: [opts.input != null ? 'pipe' : 'ignore', 'pipe', 'pipe'], env: { ...process.env, ...(opts.env || {}) } });
    } catch (e) { return resolve({ code: null, out: '', err: e.message, missing: e.code === 'ENOENT' }); }
    const kill = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} } };
    const timer = setTimeout(() => { timedOut = true; kill('SIGTERM'); setTimeout(() => kill('SIGKILL'), 5000).unref(); }, opts.timeoutMs || 5 * 60 * 1000);
    if (opts.input != null) child.stdin.end(opts.input);
    child.stdout.on('data', d => { out += d; if (out.length > 4e6) out = out.slice(-2e6); });
    child.stderr.on('data', d => { err += d; if (err.length > 1e6) err = err.slice(-5e5); });
    const finish = (code, e) => {
      if (done) return; done = true; clearTimeout(timer);
      resolve({ code: timedOut ? null : code, out: out.trim(), err: (e ? e.message + '\n' : '') + err.trim(), timedOut, missing: !!(e && e.code === 'ENOENT') });
    };
    child.on('error', (e) => finish(null, e));
    child.on('close', (code) => finish(code));
  });
}

/** Parse JSON from CLI output that may carry log lines around it. */
function parseJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  for (const [o, c] of [['[', ']'], ['{', '}']]) {
    const i = text.indexOf(o), j = text.lastIndexOf(c);
    if (i >= 0 && j > i) { try { return JSON.parse(text.slice(i, j + 1)); } catch {} }
  }
  return null;
}

module.exports = { run, parseJson };
