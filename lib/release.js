'use strict';
// Release: publisher agent → CHANGELOG.md section → commit → tag. The human
// reads CHANGELOG.md to see what the fleet did and what needs their attention.
const fs = require('fs');
const path = require('path');
const git = require('./git');
const { callAgent } = require('./dispatch');

function bumpVersion(last, bump) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(last || '');
  let [maj, min, pat] = m ? [+m[1], +m[2], +m[3]] : [0, 0, 0];
  if (!m) return bump === 'major' ? '1.0.0' : bump === 'minor' ? '0.1.0' : '0.0.1';
  if (bump === 'major') { maj++; min = 0; pat = 0; } else if (bump === 'minor') { min++; pat = 0; } else pat++;
  return `${maj}.${min}.${pat}`;
}

function unreleasedTasks(state) {
  return state.tasks(t => t.state === 'merged' && !t.released);
}

function renderSection(version, date, out, tasks, missions, extraAttention) {
  const L = [];
  L.push(`## ${version} — ${date}`);
  L.push('');
  L.push(out.headline);
  L.push('');
  const sec = (name, items) => { if (items && items.length) { L.push(`### ${name}`); for (const i of items) L.push(`- ${i}`); L.push(''); } };
  sec('Added', out.added); sec('Changed', out.changed); sec('Fixed', out.fixed); sec('Removed', out.removed); sec('Internal', out.internal);
  const attention = [...(out.attention || []), ...extraAttention];
  if (attention.length) { L.push('### Needs your attention'); for (const a of attention) L.push(`- ${a}`); L.push(''); }
  if (missions.length) {
    L.push('### Requests in this release');
    for (const m of missions) {
      L.push(`- "${(m.request || '').replace(/\s+/g, ' ').trim().slice(0, 200)}"`);
      for (const a of m.assumptions || []) L.push(`  - assumed: ${a}`);
    }
    L.push('');
  }
  L.push('<details><summary>Tasks</summary>');
  L.push('');
  L.push('| id | size | title | builder | review | attempts | cost |');
  L.push('|---|---|---|---|---|---|---|');
  for (const t of tasks) {
    L.push(`| ${t.id} | ${t.size}${t.promoted ? '↑' : ''} | ${t.title.replace(/\|/g, '/')} | ${t.tier || ''} | ${t.review_verdict || (t.size === 'small' && !t.promoted ? 'gates only' : '')} | ${t.attempts} | $${(t.cost_usd || 0).toFixed(2)} |`);
  }
  L.push('');
  L.push('</details>');
  L.push('');
  return L.join('\n');
}

async function release(ctx, opts = {}) {
  const { cfg, state, log } = ctx;
  const tasks = unreleasedTasks(state);
  if (!tasks.length && !opts.force) { log.info('nothing to release'); return null; }
  const prefix = cfg.release.tag_prefix;
  const last = git.lastTag(ctx.root, prefix);
  const range = last ? `${last}..HEAD` : 'HEAD';
  const commits = git.log(ctx.root, range, 300);
  const stat = git.git(ctx.root, ['diff', '--stat', last ? `${last}..HEAD` : git.git(ctx.root, ['rev-list', '--max-parents=0', 'HEAD']).stdout.split('\n')[0]], { allowFail: true }).stdout.slice(-4000);
  const missionIds = [...new Set(tasks.map(t => t.mission).filter(Boolean))];
  const missions = state.missionHistory(50).filter(m => missionIds.includes(m.id));
  const cur = state.mission(); if (cur && missionIds.includes(cur.id) && !missions.find(m => m.id === cur.id)) missions.push(cur);

  const prompt = [
    `# Release notes request\n\nLast release: ${last || 'none'}. Base branch: ${ctx.base}.`,
    `# Merged tasks\n\n${tasks.map(t => `## ${t.id} (${t.size}${t.promoted ? ', promoted' : ''}) ${t.title}\n${t.summary || t.description}\n${t.findings && t.findings.length ? 'Review findings kept for the human:\n' + t.findings.map(f => `- [${f.severity}] ${f.title}: ${f.detail}`).join('\n') : ''}\n${t.notes ? 'Builder notes: ' + t.notes : ''}`).join('\n\n')}`,
    `# Requests and assumptions\n\n${missions.map(m => `- "${m.request}"\n${(m.assumptions || []).map(a => `  - assumed: ${a}`).join('\n')}`).join('\n') || 'n/a'}`,
    `# Commits\n\n${commits || 'n/a'}`,
    `# Diff stat\n\n${stat || 'n/a'}`,
    `# Output\n\nReturn the structured release notes.`,
  ].join('\n\n');

  const res = await callAgent(ctx, 'publisher', { cwd: ctx.root, prompt, schema: 'release', label: 'release notes', task: 'RELEASE' });
  let out = res.ok ? res.output : null;
  if (!out) {
    log.warn(`publisher failed (${res.error}); writing a plain changelog from task records`);
    out = { bump: tasks.some(t => t.size === 'large') ? 'minor' : 'patch', headline: `${tasks.length} change${tasks.length === 1 ? '' : 's'} merged by the fleet`, added: [], changed: tasks.map(t => t.title), fixed: [], removed: [], internal: [], attention: [] };
  }
  const version = opts.version || `${prefix}${bumpVersion(last, out.bump)}`;
  const date = new Date().toISOString().slice(0, 10);
  const stuck = state.tasks(t => t.state === 'needs_human').map(t => `${t.id} needs a decision: ${t.reason}`);
  const section = renderSection(version, date, out, tasks, missions, stuck);

  const file = path.join(ctx.root, cfg.release.changelog);
  let existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '# Changelog\n\nWritten by the agent fleet at each release. Newest first.\n\n';
  const marker = existing.indexOf('\n## ');
  const head = marker >= 0 ? existing.slice(0, marker + 1) : existing.replace(/\s*$/, '\n\n');
  const tail = marker >= 0 ? existing.slice(marker + 1) : '';
  fs.writeFileSync(file, head + section + '\n' + tail);

  // commit only the changelog, tag
  git.ensureIdentity(ctx.root);
  git.git(ctx.root, ['add', cfg.release.changelog]);
  const committed = git.git(ctx.root, ['commit', '-q', '-m', `release ${version}`, '--', cfg.release.changelog], { allowFail: true }).code === 0;
  try { git.tag(ctx.root, version, out.headline); } catch (e) { log.warn(`tag failed: ${e.message}`); }

  const { pushBase } = require('./scheduler');
  pushBase(ctx, `release ${version}`, [version]);
  for (const t of tasks) { t.released = version; state.saveTask(t); }
  const rec = { version, date, headline: out.headline, tasks: tasks.map(t => t.id), missions: missionIds, cost_usd: res.cost_usd || 0, committed };
  state.addRelease(rec);
  state.event({ kind: 'release', version, note: out.headline });
  log.ok(`release ${version}: ${out.headline} ${log.dim(`→ ${cfg.release.changelog}`)}`);
  return rec;
}

module.exports = { release, bumpVersion, unreleasedTasks, renderSection };
