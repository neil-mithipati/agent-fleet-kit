'use strict';
// The mission loop. Deterministic code owns every loop and every bound:
// attempts, review rounds, timeouts, budget, parallelism. Agents are called
// for exactly one job each and their output is parsed as data.
const path = require('path');
const git = require('./git');
const gates = require('./gates');
const boundary = require('./boundary');
const { callAgent } = require('./dispatch');

const TIERS = ['builder-light', 'builder', 'builder-deep'];
const TERMINAL = new Set(['merged', 'needs_human', 'cancelled']);
const baseTier = (size) => (size === 'small' ? 0 : size === 'medium' ? 1 : 2);

function tierFor(task) {
  const idx = Math.min(baseTier(task.size) + (task.escalations || 0), TIERS.length - 1);
  return TIERS[idx];
}

function fmtGates(res) {
  if (!res) return 'not run';
  return res.results.map(r => `- ${r.name}: ${r.pass ? 'pass' : 'FAIL'} (${r.cmd})${r.pass ? '' : '\n```\n' + r.output.slice(-3500) + '\n```'}`).join('\n');
}

function taskBlock(task, base) {
  return [
    `# Task ${task.id}: ${task.title}`,
    `Size: ${task.size}${task.promoted ? ' (promoted to reviewed path)' : ''}`,
    `Branch: ${task.branch} (base: ${base}). You are inside its worktree.`,
    `\n## Description\n${task.description}`,
    `\n## Files in scope\n${task.files.length ? task.files.map(f => '- ' + f).join('\n') : '- (not specified; keep the change minimal)'}`,
    `\n## Acceptance criteria\n${task.acceptance.map((a, i) => `${i + 1}. ${a}`).join('\n')}`,
    task.verify && task.verify.length ? `\n## Verify commands\n${task.verify.map(v => '- `' + v + '`').join('\n')}` : '',
    task.human_note ? `\n## Note from the human\n${task.human_note}` : '',
  ].filter(Boolean).join('\n');
}

function attemptsBlock(task) {
  const log = (task.attempts_log || []).slice(-2);
  if (!log.length) return '';
  return `\n# Previous attempts on this task\n\n${log.map(a => `## Attempt ${a.n} (${a.tier}) → ${a.outcome}\n${a.detail || ''}`).join('\n\n')}\n\nContinue from the existing worktree state (your branch already has the previous commits). Fix what failed; do not start over unless the previous approach is unworkable.`;
}

class Mission {
  constructor(ctx, mission) {
    this.ctx = ctx; this.m = mission;
    this.running = new Map();      // id → promise
    this.mergeLock = Promise.resolve();
    this.startCost = ctx.state.usage().total_cost_usd;
  }

  get state() { return this.ctx.state; }
  get log() { return this.ctx.log; }
  get cfg() { return this.ctx.cfg; }

  elapsedMin() { return (Date.now() - new Date(this.m.started).getTime()) / 60000; }
  spent() { return +(this.state.usage().total_cost_usd - this.startCost).toFixed(2); }

  overLimit() {
    if (this.elapsedMin() > this.cfg.mission.timeout_min) return `mission exceeded ${this.cfg.mission.timeout_min} min`;
    if (this.spent() > this.cfg.mission.budget_usd) return `mission exceeded $${this.cfg.mission.budget_usd}`;
    return null;
  }

  myTasks() { return this.state.tasks(t => t.mission === this.m.id); }

  async run() {
    const { state, log } = this;
    state.clearStop();
    for (;;) {
      if (state.stopRequested()) { log.warn('stop requested'); break; }
      const limit = this.overLimit();
      const tasks = this.myTasks();
      const open = tasks.filter(t => !TERMINAL.has(t.state));
      if (!open.length) break;
      if (limit) {
        for (const t of open.filter(t => t.state === 'queued')) state.setTask(t.id, { state: 'needs_human', reason: limit }, limit);
        if (!this.running.size) break;
      } else {
        // dependency failures propagate
        for (const t of open.filter(t => t.state === 'queued')) {
          const bad = t.depends_on.map(id => state.task(id)).find(d => d && (d.state === 'needs_human' || d.state === 'cancelled'));
          if (bad) state.setTask(t.id, { state: 'needs_human', reason: `depends on ${bad.id}, which needs a human` }, 'dependency stuck');
        }
        const inflight = tasks.filter(t => this.running.has(t.id));
        const ready = tasks.filter(t => t.state === 'queued' && !this.running.has(t.id)
          && t.depends_on.every(id => { const d = state.task(id); return d && d.state === 'merged'; })
          && !inflight.some(r => overlaps(r, t)));
        for (const t of ready) {
          if (this.running.size >= this.cfg.max_parallel) break;
          const p = this.runTask(t.id).catch(e => {
            log.err(`${t.id} crashed in runner: ${e.stack || e.message}`);
            state.setTask(t.id, { state: 'needs_human', reason: `runner error: ${e.message}` }, 'runner error');
          }).finally(() => this.running.delete(t.id));
          this.running.set(t.id, p);
          inflight.push(t);
        }
        if (!this.running.size) {
          const stuckQueued = this.myTasks().filter(t => t.state === 'queued');
          for (const t of stuckQueued) state.setTask(t.id, { state: 'needs_human', reason: 'unschedulable: a dependency never finished' }, 'unschedulable');
          continue;
        }
      }
      await Promise.race([...this.running.values()]);
    }
    if (state.stopRequested()) {
      // wait for children to be killed by the runner exit; mark in-flight as interrupted
      for (const id of this.running.keys()) state.setTask(id, { state: 'queued', interrupted: true }, 'interrupted by fleet stop');
    }
    return this.summary();
  }

  summary() {
    const tasks = this.myTasks();
    return {
      merged: tasks.filter(t => t.state === 'merged'),
      needs_human: tasks.filter(t => t.state === 'needs_human'),
      open: tasks.filter(t => !TERMINAL.has(t.state)),
      cost_usd: this.spent(), minutes: +this.elapsedMin().toFixed(1),
    };
  }

  // -------------------------------------------------------------------------
  async runTask(id) {
    const { state, log, cfg, ctx } = this;
    let task = state.task(id);
    const base = ctx.base;
    const wt = git.ensureWorktree(ctx.root, cfg.worktree_root, id, base);
    task = state.setTask(id, { worktree: wt.dir, branch: wt.branch, state: 'building', tier: tierFor(task) }, wt.reused ? 'resuming in existing worktree' : 'worktree created');
    log.task(id, `${task.size} · ${task.title}`);

    const fail = (reason) => { state.setTask(id, { state: 'needs_human', reason }, reason); log.warn(`${id} needs a human: ${reason}`); };
    const noteAttempt = (outcome, detail) => {
      task = state.task(id);
      task.attempts_log.push({ n: task.attempts, tier: task.tier, outcome, detail: (detail || '').slice(0, 6000), at: new Date().toISOString() });
      state.saveTask(task);
    };

    let pendingFindings = null;   // review findings for the next build
    let gateFail = null;          // gate output for the next build

    for (;;) {
      task = state.task(id);
      if (state.stopRequested()) return;
      if (task.attempts >= cfg.retries.max_attempts) return fail(`${task.attempts} attempts exhausted; last: ${lastOutcome(task)}`);

      // ---- build -----------------------------------------------------------
      task.attempts += 1; task.tier = tierFor(task); state.saveTask(task);
      state.setTask(id, { state: 'building' }, `attempt ${task.attempts} on ${task.tier}`);
      const extra = [];
      if (gateFail) extra.push(`\n# Gates failed on the previous attempt\n\nThe runner ran these in your worktree:\n${gateFail}\n\nFix the cause. Do not weaken tests.`);
      if (pendingFindings) extra.push(`\n# Review findings to fix\n\n${pendingFindings.map(f => `- [${f.severity}] ${f.title}${f.file ? ` (${f.file})` : ''}: ${f.detail}`).join('\n')}`);
      const prompt = [taskBlock(task, base), gatesHint(ctx, wt.dir), attemptsBlock(task), ...extra, '\n# Finish\n\nCommit in this worktree, then return the structured result.'].join('\n');
      const b = await callAgent(ctx, task.tier, { cwd: wt.dir, prompt, schema: 'build', task: id, attempt: task.attempts, label: gateFail ? 'fixing gates' : pendingFindings ? 'fixing review findings' : 'building' });
      gateFail = null; pendingFindings = null;
      addCost(state, id, b.cost_usd);
      task = state.task(id);

      if (!b.ok) {
        noteAttempt(b.status, `${b.error}\n${b.text ? 'Last output: ' + b.text.slice(-1500) : ''}`);
        git.commitAll(wt.dir, `${id}: wip (${b.status})`);
        if (b.status === 'crashed' && task.attempts < 2) continue;              // same tier, once
        escalate(state, id);                                                       // more capability, continue from worktree
        continue;
      }
      const out = b.output;
      if (out.status === 'blocked') {
        if (task.tier === 'builder-light') { noteAttempt('blocked', `light builder blocked: ${out.blocked_reason}`); escalate(state, id); continue; }
        return fail(`builder blocked: ${out.blocked_reason || out.notes || out.summary}`);
      }
      if (out.status === 'failed') { noteAttempt('failed', `${out.summary}\n${out.notes}`); git.commitAll(wt.dir, `${id}: wip (failed)`); escalate(state, id); continue; }

      git.commitAll(wt.dir, `${id}: ${task.title.toLowerCase().slice(0, 60)}`);
      if (git.aheadCount(wt.dir, base) === 0 && !git.isDirty(wt.dir)) {
        noteAttempt('no_changes', `builder reported done but made no commits. Summary: ${out.summary}`);
        escalate(state, id); continue;
      }
      state.setTask(id, { summary: out.summary, notes: out.notes, files_changed: out.files_changed }, null);

      // ---- gates (runner-owned) ---------------------------------------------
      state.setTask(id, { state: 'gating' }, null);
      const g = await runGates(ctx, wt.dir);
      state.setTask(id, { gates: gates.summarize(g) }, null);
      if (!g.pass) {
        log.warn(`${id} gates: ${gates.summarize(g)}`);
        noteAttempt('gates_failed', fmtGates(g));
        gateFail = fmtGates(g);
        task.gate_failures = (task.gate_failures || 0) + 1; state.saveTask(task);
        if (task.gate_failures >= 2) escalate(state, id);
        continue;
      }
      log.ok(`${id} gates: ${gates.summarize(g)}`);

      // ---- small-task boundary ----------------------------------------------
      task = state.task(id);
      let needsReview = task.size !== 'small' || task.promoted;
      if (!needsReview) {
        const stat = git.diffStat(wt.dir, base);
        const chk = boundary.check(stat, cfg.small);
        if (!chk.ok) {
          log.warn(`${id} escaped the small boundary (${chk.reasons.join('; ')}) → review required`);
          state.setTask(id, { promoted: true, promote_reason: chk.reasons.join('; ') }, 'promoted: ' + chk.reasons[0]);
          needsReview = true;
        }
      }

      // ---- review ------------------------------------------------------------
      if (needsReview) {
        task = state.task(id);
        if (task.review_rounds >= cfg.retries.max_review_rounds) return fail(`review failed ${task.review_rounds} times; last findings: ${(task.last_findings || []).map(f => f.title).join('; ')}`);
        state.setTask(id, { state: 'reviewing' }, null);
        let role = task.size === 'large' ? 'reviewer-deep' : 'reviewer';
        let r = null;
        for (let tryN = 0; tryN < 2 && !r; tryN++) {
          r = await this.review(role, task, wt.dir, g);
          if (r && r.verdict === 'escalate' && role === 'reviewer') {
            log.info(`${id} reviewer escalated: ${r.escalate_reason || ''}`);
            role = 'reviewer-deep';
            r = await this.review(role, task, wt.dir, g, r);
          }
          if (!r) log.warn(`${id} reviewer produced no verdict${tryN === 0 ? '; retrying the review' : ''}`);
        }
        if (!r) return fail('reviewer failed twice to produce a verdict');
        const kept = (r.findings || []).filter(f => f.severity !== 'high');
        task = state.task(id);
        task.findings = dedupe([...(task.findings || []), ...kept]);
        task.review_verdict = r.verdict === 'pass' ? `pass (${role})` : task.review_verdict;
        task.last_findings = r.findings;
        state.saveTask(task);
        if (r.verdict !== 'pass') {
          const high = (r.findings || []).filter(f => f.severity === 'high');
          const failedCriteria = (r.criteria || []).filter(c => !c.pass).map(c => ({ severity: 'high', title: `criterion not met: ${c.text}`, detail: c.note || '' }));
          pendingFindings = [...high, ...failedCriteria];
          if (!pendingFindings.length) pendingFindings = [{ severity: 'high', title: 'review failed', detail: r.summary }];
          log.warn(`${id} review ${r.verdict}: ${r.summary}`);
          noteAttempt('review_failed', pendingFindings.map(f => `- ${f.title}: ${f.detail}`).join('\n'));
          task = state.task(id); task.review_rounds += 1; state.saveTask(task);
          // Out of review rounds: stop here. Escalating would buy a stronger (pricier)
          // build whose result can never be reviewed.
          if (task.review_rounds >= cfg.retries.max_review_rounds) return fail(`review failed ${task.review_rounds} times; last findings: ${pendingFindings.map(f => f.title).join('; ')}`);
          if (task.review_rounds >= 2) escalate(state, id);
          continue;
        }
        log.ok(`${id} review pass (${role})${kept.length ? ` · ${kept.length} non-blocking finding${kept.length > 1 ? 's' : ''} kept for the changelog` : ''}`);
      }

      // ---- merge -------------------------------------------------------------
      const merged = await this.merge(task, wt);
      if (merged === 'retry') continue;
      return;
    }
  }

  async review(role, task, dir, g, prev) {
    const { ctx, state } = this;
    const stat = git.diffStat(dir, ctx.base);
    const diff = git.diffText(dir, ctx.base, 40000);
    const prompt = [
      taskBlock(task, ctx.base),
      `\n# Builder's report\n${task.summary}\n${task.notes ? 'Notes: ' + task.notes : ''}`,
      `\n# Runner gate results (already run; re-run them yourself)\n${fmtGates(g)}`,
      `\n# Diff vs ${ctx.base} (${stat.files.length} files, +${stat.insertions} −${stat.deletions})\n\`\`\`diff\n${diff}\n\`\`\``,
      prev ? `\n# The standard reviewer escalated\nReason: ${prev.escalate_reason}\nIts correctness summary: ${prev.summary}` : '',
      '\n# Finish\n\nReturn the structured review.',
    ].filter(Boolean).join('\n');
    const r = await callAgent(ctx, role, { cwd: dir, prompt, schema: 'review', task: task.id, attempt: task.attempts, label: 'reviewing' });
    addCost(state, task.id, r.cost_usd);
    return r.ok ? r.output : null;
  }

  async merge(task, wt) {
    const { ctx, state, log, cfg } = this;
    const id = task.id;
    state.setTask(id, { state: 'merging' }, null);
    let result = 'retry';
    const prevLock = this.mergeLock;
    let release;
    this.mergeLock = new Promise(r => (release = r));
    await prevLock;
    try {
      // bring the branch up to date if base moved
      if (git.aheadCount(ctx.root, wt.branch) > 0) {
        const before = git.headSha(wt.dir);
        const s = git.syncWithBase(wt.dir, ctx.base);
        if (!s.ok) {
          const fixed = s.conflict ? await this.resolveConflicts(task, wt, s.error) : false;
          if (!fixed) { state.setTask(id, { state: 'needs_human', reason: 'merge conflict with base branch could not be resolved' }, 'conflict'); return 'done'; }
        }
        if (git.headSha(wt.dir) !== before) {
          const g = await runGates(ctx, wt.dir);
          if (!g.pass) {
            log.warn(`${id} gates failed after syncing with ${ctx.base}`);
            task = state.task(id); task.attempts_log.push({ n: task.attempts, tier: task.tier, outcome: 'gates_failed_after_sync', detail: fmtGates(g) }); state.saveTask(task);
            return 'retry';
          }
        }
      }
      const m = git.mergeBranch(ctx.root, wt.branch, ctx.base, `merge ${id}: ${task.title.toLowerCase()}`);
      if (!m.ok) {
        state.setTask(id, { state: 'needs_human', reason: `merge into ${ctx.base} failed: ${m.error.split('\n').slice(-2).join(' ')}` }, 'merge failed');
        return 'done';
      }
      state.setTask(id, { state: 'merged', merged_sha: m.sha, merged_at: new Date().toISOString() }, `merged as ${m.sha}`);
      log.ok(`${id} merged into ${ctx.base} as ${m.sha}`);
      git.removeWorktree(ctx.root, wt.dir, wt.branch);
      pushBase(ctx, `${id}`);
      result = 'done';
    } finally { release(); }
    return result;
  }

  async resolveConflicts(task, wt, error) {
    const { ctx, state, log } = this;
    log.info(`${task.id} conflicts with ${ctx.base}; asking a builder to resolve`);
    const prompt = `${taskBlock(task, ctx.base)}\n\n# Merge conflict\n\nRun \`git merge ${ctx.base}\` in this worktree and resolve every conflict, keeping both the base branch's intent and this task's. Then run the gates and commit the merge. Output:\n\n${error}\n\n# Finish\n\nReturn the structured result (status done when the merge commit exists and gates pass).`;
    const r = await callAgent(ctx, 'builder', { cwd: wt.dir, prompt, schema: 'build', task: task.id, attempt: task.attempts, label: 'resolving conflicts' });
    addCost(state, task.id, r.cost_usd);
    if (!r.ok || r.output.status !== 'done') return false;
    git.commitAll(wt.dir, `${task.id}: merge ${ctx.base}`);
    if (git.git(wt.dir, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true }).stdout) { git.git(wt.dir, ['merge', '--abort'], { allowFail: true }); return false; }
    return true;
  }
}

/** Push the base branch if push.auto is on and the remote exists. Failures warn, never block. */
function pushBase(ctx, why, tags = []) {
  const { cfg, state, log } = ctx;
  if (!cfg.push || !cfg.push.auto) return false;
  if (!git.hasRemote(ctx.root, cfg.push.remote)) {
    if (!ctx._noRemoteWarned) { ctx._noRemoteWarned = true; log.info(`no remote "${cfg.push.remote}"; skipping push (set push.auto=false in .fleet/config.json to silence)`); }
    return false;
  }
  const r = git.push(ctx.root, cfg.push.remote, ctx.base, tags);
  if (r.ok) {
    log.ok(`pushed ${ctx.base}${tags.length ? ' + ' + tags.join(', ') : ''} to ${cfg.push.remote}${r.tagError ? ` (tag push failed: ${r.tagError})` : ''}`);
    state.event({ kind: 'push', remote: cfg.push.remote, branch: ctx.base, note: why, tags });
  } else {
    log.warn(`push to ${cfg.push.remote} failed: ${r.error}`);
    state.event({ kind: 'push', remote: cfg.push.remote, branch: ctx.base, note: `FAILED after ${why}: ${r.error}`, failed: true });
  }
  return r.ok;
}

function overlaps(a, b) {
  const norm = f => f.replace(/\/$/, '');
  return (a.files || []).some(fa => (b.files || []).some(fb => { const x = norm(fa), y = norm(fb); return x === y || x.startsWith(y + '/') || y.startsWith(x + '/'); }));
}
function dedupe(findings) {
  const seen = new Set(); const out = [];
  for (const f of findings) { const k = `${f.severity}|${f.title}`; if (!seen.has(k)) { seen.add(k); out.push(f); } }
  return out;
}
function lastOutcome(task) { const l = task.attempts_log.slice(-1)[0]; return l ? `${l.outcome} (${l.tier})` : 'unknown'; }
function addCost(state, id, cost) { const t = state.task(id); if (!t) return; t.cost_usd = +((t.cost_usd || 0) + (cost || 0)).toFixed(4); state.saveTask(t); }
function escalate(state, id) {
  const t = state.task(id);
  t.escalations = Math.min((t.escalations || 0) + 1, 2);
  state.saveTask(t);
}
function runGates(ctx, dir) {
  const detected = gates.detect(dir, ctx.cfg.gates);
  return gates.run(dir, detected, ctx.cfg.gate_timeout_min * 60 * 1000);
}
function gatesHint(ctx, dir) {
  const g = gates.detect(dir, ctx.cfg.gates);
  const list = Object.entries(g).map(([k, v]) => `- ${k}: \`${v}\``).join('\n');
  return `\n# Gates the runner will execute after you finish\n${list || '- none detected yet (if you add a manifest with test/lint/typecheck scripts, they become gates)'}`;
}

module.exports = { Mission, tierFor, TERMINAL, overlaps, pushBase };
