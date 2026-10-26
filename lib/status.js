'use strict';
const { State, pidAlive } = require('./state');
const { load } = require('./config');
const log = require('./log');

const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);

function print(root, opts = {}) {
  const state = new State(root);
  const cfg = load(root);
  const m = state.mission();
  const tasks = state.tasks();
  const alive = pidAlive(state.runnerPid());
  const u = state.usage();
  log.raw(log.bold(`${cfg.name}`) + `  runner: ${alive ? log.green('running') : log.dim('idle')}  spent: $${u.total_cost_usd.toFixed(2)} over ${u.calls} agent calls  dashboard: http://127.0.0.1:${cfg.dashboard.port}`);
  if (m && m.status === 'running' && !alive) m.status = 'interrupted (fleet do to resume)';
  if (m) log.raw(`mission ${m.id} [${m.status}] "${(m.request || '').replace(/\s+/g, ' ').slice(0, 100)}"${m.summary ? '\n  ' + m.summary : ''}`);
  if (opts.id) {
    const t = state.task(opts.id);
    if (!t) return log.err(`no task ${opts.id}`);
    log.raw(JSON.stringify(t, null, 2));
    return;
  }
  const show = opts.all ? tasks : tasks.filter(t => !t.released);
  if (!show.length) { log.raw(log.dim('no tasks')); return; }
  log.raw('');
  log.raw(log.dim(`${pad('id', 7)} ${pad('state', 12)} ${pad('size', 7)} ${pad('tier', 14)} ${pad('att', 4)} ${pad('cost', 7)} title`));
  for (const t of show) {
    const color = t.state === 'merged' ? log.green : t.state === 'needs_human' ? log.red : ['queued', 'cancelled'].includes(t.state) ? log.dim : log.yellow;
    log.raw(`${pad(t.id, 7)} ${color(pad(t.state, 12))} ${pad(t.size + (t.promoted ? '↑' : ''), 7)} ${pad(t.tier || '', 14)} ${pad(t.attempts, 4)} ${pad('$' + (t.cost_usd || 0).toFixed(2), 7)} ${t.title}${t.released ? log.dim(` (${t.released})`) : ''}`);
  }
  const stuck = tasks.filter(t => t.state === 'needs_human');
  if (stuck.length) {
    log.raw('');
    log.raw(log.red('needs a human:'));
    for (const t of stuck) log.raw(`  ${t.id}: ${t.reason}\n    → fleet retry ${t.id} "your answer or instruction"`);
  }
  const active = Object.values(state.agents().active || {});
  if (active.length) {
    log.raw('');
    log.raw('agents active:');
    for (const a of active) log.raw(`  [${a.role}] ${a.task || ''} ${a.last_tool || ''} ${log.dim(`${a.turns} turns`)}`);
  }
  const unreleased = tasks.filter(t => t.state === 'merged' && !t.released).length;
  if (unreleased) log.raw(log.dim(`\n${unreleased} merged task${unreleased > 1 ? 's' : ''} not yet in CHANGELOG.md → fleet release`));
}

module.exports = { print };
