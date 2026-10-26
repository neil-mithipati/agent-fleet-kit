'use strict';
// On-disk state: tasks, mission, live agents, events. Atomic writes, no in-memory
// source of truth, so a crashed or stopped run resumes from what is on disk.
const fs = require('fs');
const path = require('path');
const { paths, ensureDirs } = require('./config');

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

class State {
  constructor(root) {
    this.root = root;
    this.p = ensureDirs(root);
  }

  // ---- ids -----------------------------------------------------------------
  nextId(prefix) {
    const c = readJson(this.p.counter, {});
    c[prefix] = (c[prefix] || 0) + 1;
    writeJsonAtomic(this.p.counter, c);
    return `${prefix}-${String(c[prefix]).padStart(3, '0')}`;
  }

  // ---- mission -------------------------------------------------------------
  mission() { return readJson(this.p.mission, null); }
  saveMission(m) { m.updated = new Date().toISOString(); writeJsonAtomic(this.p.mission, m); return m; }
  archiveMission(m) {
    fs.appendFileSync(this.p.missions, JSON.stringify(m) + '\n');
  }
  missionHistory(limit = 20) {
    try {
      return fs.readFileSync(this.p.missions, 'utf8').trim().split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).slice(-limit);
    } catch { return []; }
  }

  // ---- tasks ---------------------------------------------------------------
  taskFile(id) { return path.join(this.p.tasks, `${id}.json`); }
  task(id) { return readJson(this.taskFile(id), null); }
  tasks(filter) {
    let files = [];
    try { files = fs.readdirSync(this.p.tasks).filter(f => f.endsWith('.json')); } catch { return []; }
    const all = files.map(f => readJson(path.join(this.p.tasks, f), null)).filter(Boolean)
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    return filter ? all.filter(filter) : all;
  }
  saveTask(t) { t.updated = new Date().toISOString(); writeJsonAtomic(this.taskFile(t.id), t); return t; }
  setTask(id, patch, event) {
    const t = this.task(id);
    if (!t) throw new Error(`no such task ${id}`);
    Object.assign(t, patch);
    if (patch.state && t.history) t.history.push({ at: new Date().toISOString(), state: patch.state, note: event || null });
    this.saveTask(t);
    if (patch.state) this.event({ kind: 'task', task: id, state: patch.state, note: event || null });
    return t;
  }

  // ---- live agents ---------------------------------------------------------
  agents() { return readJson(this.p.agentsLive, { active: {}, recent: [] }); }
  agentStart(run) {
    const a = this.agents();
    a.active[run.id] = run;
    writeJsonAtomic(this.p.agentsLive, a);
    this.event({ kind: 'agent', agent: run.role, task: run.task, run: run.id, state: 'start' });
  }
  agentUpdate(id, patch) {
    const a = this.agents();
    if (!a.active[id]) return;
    Object.assign(a.active[id], patch);
    writeJsonAtomic(this.p.agentsLive, a);
  }
  agentEnd(id, result) {
    const a = this.agents();
    const run = a.active[id];
    if (!run) return;
    delete a.active[id];
    const done = { ...run, ...result, ended: new Date().toISOString() };
    a.recent.unshift(done);
    a.recent = a.recent.slice(0, 50);
    writeJsonAtomic(this.p.agentsLive, a);
    this.event({ kind: 'agent', agent: run.role, task: run.task, run: run.id, state: 'end', status: result.status, cost: result.cost_usd, ms: result.duration_ms });
  }
  clearAgents() { writeJsonAtomic(this.p.agentsLive, { active: {}, recent: this.agents().recent || [] }); }

  // ---- usage ---------------------------------------------------------------
  usage() { return readJson(this.p.usage, { total_cost_usd: 0, calls: 0, by_role: {}, rate_limit: null }); }
  addUsage(role, cost, rateLimit) {
    const u = this.usage();
    u.total_cost_usd = +(u.total_cost_usd + (cost || 0)).toFixed(4);
    u.calls += 1;
    u.by_role[role] = u.by_role[role] || { calls: 0, cost_usd: 0 };
    u.by_role[role].calls += 1;
    u.by_role[role].cost_usd = +(u.by_role[role].cost_usd + (cost || 0)).toFixed(4);
    if (rateLimit) u.rate_limit = { ...rateLimit, at: new Date().toISOString() };
    writeJsonAtomic(this.p.usage, u);
  }

  // ---- events --------------------------------------------------------------
  event(e) {
    const line = JSON.stringify({ at: new Date().toISOString(), ...e });
    fs.appendFileSync(this.p.events, line + '\n');
  }
  events(limit = 200) {
    try {
      const txt = fs.readFileSync(this.p.events, 'utf8');
      const lines = txt.trim().split('\n');
      return lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  }

  // ---- releases ------------------------------------------------------------
  releases() { return readJson(this.p.releases, []); }
  addRelease(r) { const all = this.releases(); all.unshift(r); writeJsonAtomic(this.p.releases, all); }

  // ---- control -------------------------------------------------------------
  stopRequested() { return fs.existsSync(this.p.stopFlag); }
  requestStop() { fs.writeFileSync(this.p.stopFlag, new Date().toISOString()); }
  clearStop() { try { fs.unlinkSync(this.p.stopFlag); } catch {} }
  writePid() { fs.writeFileSync(this.p.pid, String(process.pid)); }
  clearPid() { try { fs.unlinkSync(this.p.pid); } catch {} }
  runnerPid() {
    const pid = parseInt(readJson.call(null, this.p.pid, 'x'), 10);
    try { const s = fs.readFileSync(this.p.pid, 'utf8').trim(); const n = parseInt(s, 10); return Number.isFinite(n) ? n : null; } catch { return null; }
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

module.exports = { State, writeJsonAtomic, readJson, pidAlive };
