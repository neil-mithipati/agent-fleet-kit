'use strict';
// Mission control: a tiny HTTP server serving one static page and the fleet's
// state as JSON. No dependencies. Start with `fleet dashboard`; `fleet do`
// starts it in the background when dashboard.auto_start is true.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { State, pidAlive } = require('./state');
const { KIT_ROOT, load } = require('./config');

function snapshot(root) {
  const state = new State(root);
  const cfg = load(root);
  const tasks = state.tasks();
  const mission = state.mission();
  const runnerPid = state.runnerPid();
  if (mission && mission.status === 'running' && !pidAlive(runnerPid)) mission.status = 'interrupted';
  return {
    now: new Date().toISOString(),
    name: cfg.name,
    runner_alive: pidAlive(runnerPid),
    mission,
    missions: state.missionHistory(10).reverse(),
    tasks,
    agents: state.agents(),
    events: state.events(150),
    usage: state.usage(),
    releases: state.releases(),
    roles: Object.keys(cfg.models).map(r => ({ role: r, model: cfg.models[r], limits: cfg.limits[r] })),
    config: { max_parallel: cfg.max_parallel, budget_usd: cfg.mission.budget_usd, timeout_min: cfg.mission.timeout_min, release: cfg.release },
  };
}

function serve(root, port, onReady) {
  const page = fs.readFileSync(path.join(KIT_ROOT, 'dashboard', 'index.html'), 'utf8');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }); res.end(body); };
    try {
      if (url.pathname === '/' || url.pathname === '/index.html') return send(200, 'text/html; charset=utf-8', page);
      if (url.pathname === '/api/state') return send(200, 'application/json', JSON.stringify(snapshot(root)));
      if (url.pathname === '/api/log') {
        const file = url.searchParams.get('file') || '';
        const state = new State(root);
        const abs = path.resolve(file);
        if (!abs.startsWith(path.resolve(state.p.runs))) return send(403, 'text/plain', 'forbidden');
        if (!fs.existsSync(abs)) return send(404, 'text/plain', 'no log');
        const txt = fs.readFileSync(abs, 'utf8');
        return send(200, 'text/plain; charset=utf-8', txt.length > 200000 ? txt.slice(-200000) : txt);
      }
      if (url.pathname === '/api/task') {
        const id = url.searchParams.get('id');
        const t = new State(root).task(id);
        return t ? send(200, 'application/json', JSON.stringify(t)) : send(404, 'text/plain', 'no task');
      }
      send(404, 'text/plain', 'not found');
    } catch (e) { send(500, 'text/plain', e.stack || String(e)); }
  });
  server.on('error', (e) => { if (e.code === 'EADDRINUSE') { console.error(`port ${port} is in use (is a dashboard already running?)`); process.exit(1); } throw e; });
  server.listen(port, '127.0.0.1', () => onReady && onReady(`http://127.0.0.1:${port}`));
  return server;
}

/** Start the dashboard detached if nothing is listening. Returns the URL. */
function ensureRunning(root, cfg) {
  const state = new State(root);
  const url = `http://127.0.0.1:${cfg.dashboard.port}`;
  let pid = null;
  try { pid = parseInt(fs.readFileSync(state.p.dashboardPid, 'utf8'), 10); } catch {}
  if (pidAlive(pid)) return url;
  const child = spawn(process.execPath, [path.join(KIT_ROOT, 'bin', 'fleet'), 'dashboard', '--detached'], {
    cwd: root, detached: true, stdio: 'ignore', env: { ...process.env, FLEET_ROOT: root },
  });
  child.unref();
  fs.writeFileSync(state.p.dashboardPid, String(child.pid));
  return url;
}

module.exports = { serve, ensureRunning, snapshot };
