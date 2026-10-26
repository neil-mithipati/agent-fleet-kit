'use strict';
// Intake: request → validated tasks on disk. Two-tier: the fast planner handles
// small requests in one short call; it escalates large ones to planner-deep.
// Plans are validated as data before anything is dispatched.
const fs = require('fs');
const path = require('path');
const { callAgent } = require('./dispatch');

function repoSnapshot(root) {
  let top = [];
  try { top = fs.readdirSync(root).filter(f => !['.git', 'node_modules', '.fleet', '.DS_Store'].includes(f)).slice(0, 60); } catch {}
  const manifests = ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'Gemfile', 'composer.json', 'pom.xml', 'build.gradle', 'mix.exs']
    .filter(f => fs.existsSync(path.join(root, f)));
  const empty = top.filter(f => !['README.md', 'CHANGELOG.md', '.gitignore', 'LICENSE'].includes(f)).length === 0;
  return { top, manifests, empty };
}

function humanNotes(root) {
  try { return fs.readFileSync(path.join(root, '.fleet', 'HUMAN_NOTES.md'), 'utf8').slice(0, 6000); } catch { return ''; }
}

function buildPrompt(ctx, request, snap, extra) {
  const { cfg, state } = ctx;
  const open = state.tasks(t => !['merged', 'cancelled'].includes(t.state));
  const recent = state.tasks(t => t.state === 'merged').slice(-8);
  const lines = [];
  lines.push(`# Request from the human\n\n${request.trim()}\n`);
  lines.push(`# Repository\n\nRoot: ${ctx.root}\nBase branch: ${ctx.base}\n${snap.empty ? 'The repository is EMPTY (no app yet). The first task must scaffold it.' : `Top level: ${snap.top.join(', ')}\nManifests: ${snap.manifests.join(', ') || 'none'}`}\nDetected gates: ${Object.entries(ctx.gates || {}).map(([k, v]) => `${k} (${v})`).join(', ') || 'none yet'}`);
  if (open.length) lines.push(`# Tasks already open (do not duplicate; you may reference them)\n\n${open.map(t => `- ${t.id} [${t.state}] ${t.title}${t.state === 'needs_human' ? ` — needs human: ${t.reason || ''}` : ''}`).join('\n')}`);
  if (recent.length) lines.push(`# Recently merged\n\n${recent.map(t => `- ${t.id} ${t.title}`).join('\n')}`);
  const st = cfg.stack;
  if (st && st.default) {
    lines.push(`# Default stack (.fleet/config.json)\n\nUse this for a new app, and for new parts of an existing app where it fits, unless the request names something else. In an existing repo, the stack already there wins.\n\nStack: ${st.default}${(st.rules || []).length ? `\n\nRules (carry the relevant ones into each task's description and acceptance criteria; builders and reviewers only see the task):\n${st.rules.map(r => '- ' + r).join('\n')}` : ''}`);
  }
  const notes = humanNotes(ctx.root);
  if (notes) lines.push(`# Human notes (.fleet/HUMAN_NOTES.md)\n\n${notes}`);
  if (extra) lines.push(extra);
  lines.push(`# Output\n\nReturn the structured plan. Task ids are local (t1, t2…). Paths are repo-relative. Max parallel builders: ${cfg.max_parallel}.`);
  return lines.join('\n\n');
}

function validate(plan) {
  const errors = [];
  if (!plan || typeof plan !== 'object') return ['plan is not an object'];
  if (plan.mode !== 'plan') return errors;
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) errors.push('plan has no tasks');
  const ids = new Set();
  for (const t of plan.tasks || []) {
    if (!t.id) errors.push('task without id');
    if (ids.has(t.id)) errors.push(`duplicate task id ${t.id}`);
    ids.add(t.id);
    if (!t.title) errors.push(`${t.id}: no title`);
    if (!['small', 'medium', 'large'].includes(t.size)) errors.push(`${t.id}: bad size`);
    if (!Array.isArray(t.acceptance) || !t.acceptance.length) errors.push(`${t.id}: no acceptance criteria`);
    if (!Array.isArray(t.files)) errors.push(`${t.id}: files missing`);
  }
  for (const t of plan.tasks || []) for (const d of t.depends_on || []) if (!ids.has(d)) errors.push(`${t.id} depends on unknown ${d}`);
  // cycle check
  const graph = new Map((plan.tasks || []).map(t => [t.id, t.depends_on || []]));
  const seen = new Map();
  const visit = (n, stack) => {
    if (seen.get(n) === 2) return false;
    if (seen.get(n) === 1) return true;
    seen.set(n, 1);
    for (const d of graph.get(n) || []) if (visit(d, stack)) return true;
    seen.set(n, 2); return false;
  };
  for (const id of graph.keys()) if (visit(id)) { errors.push('dependency cycle'); break; }
  if (plan.tasks && plan.tasks.length > 20) errors.push('more than 20 tasks; split the request into missions');
  return errors;
}

/** Add implicit dependencies between tasks that share files, so they never run concurrently. */
function serializeOverlaps(tasks) {
  const norm = f => f.replace(/\/$/, '');
  const overlaps = (a, b) => a.files.some(fa => b.files.some(fb => { const x = norm(fa), y = norm(fb); return x === y || x.startsWith(y + '/') || y.startsWith(x + '/'); }));
  for (let i = 0; i < tasks.length; i++) for (let j = 0; j < i; j++) {
    const a = tasks[i], b = tasks[j];
    if (overlaps(a, b) && !a.depends_on.includes(b.id) && !b.depends_on.includes(a.id)) {
      // later task waits for the earlier one unless that would form a cycle
      const reaches = (from, to) => { const st = [from]; const s = new Set(); while (st.length) { const n = st.pop(); if (n === to) return true; if (s.has(n)) continue; s.add(n); const t = tasks.find(x => x.id === n); for (const d of (t && t.depends_on) || []) st.push(d); } return false; };
      if (!reaches(b.id, a.id)) a.depends_on.push(b.id);
    }
  }
}

async function plan(ctx, request) {
  const { log, state } = ctx;
  const snap = repoSnapshot(ctx.root);
  let role = snap.empty ? 'planner-deep' : 'planner';
  let extra = snap.empty ? null : null;
  let res, p;
  for (let hop = 0; hop < 3; hop++) {
    res = await callAgent(ctx, role, { cwd: ctx.root, prompt: buildPrompt(ctx, request, snap, extra), schema: 'plan', label: 'planning', task: 'PLAN' });
    if (!res.ok) {
      if (role === 'planner' && ['max_turns', 'timeout', 'budget', 'bad_output'].includes(res.status)) { role = 'planner-deep'; extra = `# Note\n\nThe fast planner ran out of budget (${res.status}). Plan this properly.`; continue; }
      return { ok: false, error: res.error, cost: res.cost_usd };
    }
    p = res.output;
    if (p.mode === 'escalate' && role === 'planner') {
      log.info(`planner escalated: ${p.escalate_reason || p.summary}`);
      role = 'planner-deep'; extra = `# Note from the fast planner\n\nIt escalated to you because: ${p.escalate_reason || p.summary}`; continue;
    }
    const errors = validate(p);
    if (errors.length) {
      log.warn(`plan invalid: ${errors.join('; ')}`);
      extra = `# Your previous plan was rejected by the validator\n\n${errors.map(e => '- ' + e).join('\n')}\n\nFix these and return the full plan again.`;
      continue;
    }
    break;
  }
  if (!p) return { ok: false, error: 'no plan produced' };
  const errors = validate(p);
  if (errors.length) return { ok: false, error: `plan invalid after retries: ${errors.join('; ')}` };
  if (p.mode !== 'plan') return { ok: true, mode: p.mode, plan: p, tasks: [] };

  for (const t of p.tasks) { t.depends_on = t.depends_on || []; t.files = t.files || []; }
  serializeOverlaps(p.tasks);

  // Materialize tasks with global ids.
  const idMap = new Map();
  for (const t of p.tasks) idMap.set(t.id, state.nextId('T'));
  const created = [];
  for (const t of p.tasks) {
    const task = {
      id: idMap.get(t.id), mission: ctx.missionId, title: t.title, description: t.description, size: t.size,
      files: t.files, acceptance: t.acceptance, verify: t.verify || [], depends_on: t.depends_on.map(d => idMap.get(d)),
      state: 'queued', attempts: 0, review_rounds: 0, tier: null, promoted: false, created: new Date().toISOString(),
      history: [{ at: new Date().toISOString(), state: 'queued', note: 'planned' }], attempts_log: [], cost_usd: 0,
      worktree: null, branch: null, merged_sha: null, reason: null, summary: null, findings: [],
    };
    state.saveTask(task);
    state.event({ kind: 'task', task: task.id, state: 'queued', note: `${task.size}: ${task.title}` });
    created.push(task);
  }
  return { ok: true, mode: 'plan', plan: p, tasks: created, role, cost: res.cost_usd };
}

module.exports = { plan, validate, serializeOverlaps, repoSnapshot, buildPrompt };
