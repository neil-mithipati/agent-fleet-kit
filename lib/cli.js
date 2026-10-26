'use strict';
const fs = require('fs');
const path = require('path');
const cfgmod = require('./config');
const { State, pidAlive } = require('./state');
const git = require('./git');
const gates = require('./gates');
const log = require('./log');
const { plan } = require('./planner');
const { Mission, TERMINAL } = require('./scheduler');
const { release } = require('./release');
const dashboard = require('./dashboard');
const { init } = require('./init');
const status = require('./status');

const GLOSSARY = `
fleet init [path]            Make a repo fleet-ready. Empty dir → new repo. Existing repo → adds .fleet/ only.
fleet connect [--supabase|--vercel] [--org id] [--region r]
                             Create + link the Supabase and Vercel projects with your CLI logins; writes .env.local.
fleet do "<request>"         Plan, build, review, merge. Small tasks ship on green gates; medium and large are reviewed.
fleet do                     Resume unfinished tasks after a stop or crash.
fleet do --plan-only "<req>" Plan and queue tasks, build nothing. Then \`fleet do\` to run them.
fleet status [id] [--all]    One-screen status; with an id, everything about that task.
fleet dashboard              Mission control web page (http://127.0.0.1:4777).
fleet release                Write the next CHANGELOG.md section from merged tasks and tag it.
fleet retry <id> ["note"]    Re-queue a task that needs a human, with your answer or instruction.
fleet stop [--abandon]       Stop the running mission; in-flight tasks resume later. --abandon cancels queued tasks.
`.trim();

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) args.flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--') && ['port', 'version', 'name', 'branch', 'parallel', 'root', 'org', 'region'].includes(k)) args.flags[k] = argv[++i];
      else args.flags[k] = true;
    } else args._.push(a);
  }
  return args;
}

function requireRoot(flags) {
  const start = flags.root || process.env.FLEET_ROOT || process.cwd();
  const root = cfgmod.findRepoRoot(start);
  if (!root) throw new Error(`no .fleet/config.json found from ${start}. Run \`fleet init\` first.`);
  return root;
}

/** Keep .fleet/settings.json pointing at this kit's guard hook unless the user marked it custom. */
function refreshSettings(root) {
  const { settingsFor } = require('./init');
  const file = path.join(root, '.fleet', 'settings.json');
  let cur = null; try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (cur && cur.custom) return;
  const next = settingsFor();
  if (JSON.stringify(cur) !== JSON.stringify(next)) fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
}

function makeCtx(root, missionId) {
  const cfg = cfgmod.load(root);
  const state = new State(root);
  const base = cfg.base_branch || git.currentBranch(root);
  return { root, cfg, state, log, p: state.p, base, missionId, gates: gates.detect(root, cfg.gates) };
}

async function cmdDo(args) {
  const root = requireRoot(args.flags);
  const state = new State(root);
  if (pidAlive(state.runnerPid())) throw new Error(`a mission is already running (pid ${state.runnerPid()}). Use \`fleet stop\` first, or watch it at the dashboard.`);
  if (!git.isRepo(root) || !git.hasCommits(root)) throw new Error('the repo has no commits yet; run `fleet init` here first.');
  refreshSettings(root);
  const ctx = makeCtx(root);
  if (args.flags.parallel) ctx.cfg.max_parallel = parseInt(args.flags.parallel, 10) || ctx.cfg.max_parallel;
  if (git.currentBranch(root) !== ctx.base) throw new Error(`checkout is on ${git.currentBranch(root)} but base_branch is ${ctx.base}; check out ${ctx.base} or change .fleet/config.json`);
  const dirty = git.dirtyFiles(root).filter(f => !f.startsWith('.fleet/'));
  if (dirty.length) log.warn(`uncommitted changes in the main checkout (${dirty.length} files). Merges that touch them will fail; commit or stash first if you can.`);

  const request = args._.slice(1).join(' ').trim();
  let mission = state.mission();
  const unfinished = state.tasks(t => !TERMINAL.has(t.state));

  if (!request) {
    if (!unfinished.length) { log.info('nothing to resume. Give me a request: fleet do "..."'); return; }
    if (!mission || mission.status === 'done') mission = { id: state.nextId('M'), request: '(resume)', started: new Date().toISOString(), status: 'running', assumptions: [] };
    else { mission.first_started = mission.first_started || mission.started; mission.started = new Date().toISOString(); delete mission.ended; }
    log.info(`resuming ${unfinished.length} unfinished task${unfinished.length > 1 ? 's' : ''}`);
  } else {
    mission = { id: state.nextId('M'), request, started: new Date().toISOString(), status: 'planning', assumptions: [], summary: null, cost_usd: 0 };
    state.saveMission(mission);
    state.event({ kind: 'mission', mission: mission.id, state: 'planning', note: request.slice(0, 160) });
  }
  ctx.missionId = mission.id;
  // adopt leftovers from earlier missions so nothing is orphaned
  for (const t of unfinished) { if (t.mission !== mission.id) { t.mission = mission.id; state.saveTask(t); } if (!['queued'].includes(t.state)) state.setTask(t.id, { state: 'queued', interrupted: true }, 'requeued after interruption'); }

  if (ctx.cfg.dashboard.auto_start) { try { log.info(`mission control: ${dashboard.ensureRunning(root, ctx.cfg)}`); } catch (e) { log.warn(`dashboard did not start: ${e.message}`); } }

  if (request) {
    log.info(`planning: "${request.slice(0, 120)}${request.length > 120 ? '…' : ''}"`);
    const r = await plan(ctx, request);
    if (!r.ok) { mission.status = 'failed'; state.saveMission(mission); throw new Error(`planning failed: ${r.error}`); }
    mission.assumptions = r.plan.assumptions || [];
    mission.summary = r.plan.summary;
    mission.stack = r.plan.stack || null;
    mission.planner = r.role;
    if (r.mode === 'questions') {
      mission.status = 'needs_human'; mission.questions = r.plan.questions; state.saveMission(mission);
      log.warn('the planner needs answers before it can plan:');
      for (const q of r.plan.questions || []) log.raw(`  ? ${q}`);
      log.raw(log.dim('\nAnswer by re-running with more detail, e.g.  fleet do "<your request> — <answers>"\nor put standing decisions in .fleet/HUMAN_NOTES.md'));
      return;
    }
    if (r.mode === 'nothing') { mission.status = 'done'; state.saveMission(mission); state.archiveMission(mission); log.ok(`nothing to do: ${r.plan.summary}`); return; }
    log.ok(`plan (${r.role}): ${r.plan.summary}`);
    for (const a of mission.assumptions) log.raw(log.dim(`  assumed: ${a}`));
    for (const t of r.tasks) log.task(t.id, `${t.size.padEnd(6)} ${t.title}${t.depends_on.length ? log.dim(` ← ${t.depends_on.join(', ')}`) : ''}`);
    if (args.flags['plan-only']) { mission.status = 'planned'; state.saveMission(mission); log.info('planned only. Run `fleet do` to build.'); return; }
  }

  mission.status = 'running'; state.saveMission(mission);
  state.writePid();
  const run = new Mission(ctx, mission);
  const onSignal = () => { log.warn('stopping… (in-flight agents are being terminated; `fleet do` resumes later)'); state.requestStop(); setTimeout(() => process.exit(130), 1500); };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  let summary;
  try { summary = await run.run(); }
  finally { state.clearPid(); state.clearAgents(); }
  const stopped = state.stopRequested();
  state.clearStop();
  mission.status = stopped ? 'stopped' : summary.needs_human.length ? 'partial' : 'done';
  mission.cost_usd = summary.cost_usd; mission.minutes = summary.minutes; mission.ended = new Date().toISOString();
  mission.result = { merged: summary.merged.map(t => t.id), needs_human: summary.needs_human.map(t => t.id) };
  state.saveMission(mission); state.archiveMission(mission);
  state.event({ kind: 'mission', mission: mission.id, state: mission.status, note: `${summary.merged.length} merged, ${summary.needs_human.length} need a human, $${summary.cost_usd}` });

  log.raw('');
  log.raw(log.bold(`mission ${mission.id} ${mission.status}`) + log.dim(` · ${summary.minutes} min · $${summary.cost_usd}`));
  for (const t of summary.merged) log.raw(`  ${log.green('merged')}  ${t.id} ${t.title}`);
  for (const t of summary.needs_human) log.raw(`  ${log.red('human ')}  ${t.id} ${t.title}\n          ${t.reason}\n          → fleet retry ${t.id} "..."`);
  for (const t of summary.open) log.raw(`  ${log.yellow('open  ')}  ${t.id} ${t.title} (fleet do to resume)`);

  if (!stopped && summary.merged.length && !args.flags['no-release']) {
    const auto = ctx.cfg.release.auto;
    const large = summary.merged.some(t => t.size === 'large' || t.promoted);
    if (args.flags.release || auto === 'always' || (auto === 'large' && large)) await release(ctx, {});
    else log.raw(log.dim(`\n${summary.merged.length} merged task(s) await the next release → fleet release`));
  }
}

async function cmdConnect(args) {
  const root = requireRoot(args.flags);
  refreshSettings(root);
  const ctx = makeCtx(root, 'connect');
  if (pidAlive(ctx.state.runnerPid())) throw new Error('a mission is running; connect after it finishes');
  await require('./connect').connect(ctx, { supabase: !!args.flags.supabase, vercel: !!args.flags.vercel, org: args.flags.org, region: args.flags.region, name: args.flags.name });
  log.raw(log.dim('\nnext: fleet do "describe what to build"'));
}

async function cmdRelease(args) {
  const root = requireRoot(args.flags);
  const ctx = makeCtx(root, 'release');
  const state = ctx.state;
  if (pidAlive(state.runnerPid())) throw new Error('a mission is running; release after it finishes');
  const r = await release(ctx, { version: args.flags.version, force: !!args.flags.force });
  if (!r) log.info('no merged tasks since the last release');
}

function cmdStop(args) {
  const root = requireRoot(args.flags);
  const state = new State(root);
  const pid = state.runnerPid();
  state.requestStop();
  if (pidAlive(pid)) { try { process.kill(pid, 'SIGTERM'); } catch {} log.ok(`stop requested (runner pid ${pid})`); }
  else { log.info('no runner is active'); state.clearStop(); }
  if (args.flags.abandon) {
    for (const t of state.tasks(t => t.state === 'queued')) state.setTask(t.id, { state: 'cancelled', reason: 'abandoned by human' }, 'abandoned');
    log.ok('queued tasks cancelled');
  }
}

function cmdRetry(args) {
  const root = requireRoot(args.flags);
  const state = new State(root);
  const id = args._[1];
  const note = args._.slice(2).join(' ').trim();
  const t = id && state.task(id);
  if (!t) throw new Error(`usage: fleet retry <task-id> ["note"]`);
  if (!['needs_human', 'cancelled'].includes(t.state)) throw new Error(`${id} is ${t.state}; only needs_human or cancelled tasks can be retried`);
  const patch = { state: 'queued', attempts: 0, review_rounds: 0, gate_failures: 0, escalations: Math.max(0, (t.escalations || 0)), reason: null, human_note: note || t.human_note || null };
  state.setTask(id, patch, `retried by human${note ? ': ' + note.slice(0, 80) : ''}`);
  const cascade = state.tasks(x => x.state === 'needs_human' && typeof x.reason === 'string' && /^(depends on|unschedulable)/.test(x.reason));
  for (const d of cascade) state.setTask(d.id, { state: 'queued', reason: null }, `requeued with ${id}`);
  if (cascade.length) log.info(`also re-queued ${cascade.map(d => d.id).join(', ')} (were waiting on a dependency)`);
  if (note) {
    const notes = path.join(root, '.fleet', 'HUMAN_NOTES.md');
    fs.appendFileSync(notes, `\n- ${new Date().toISOString().slice(0, 10)} on ${id} (${t.title}): ${note}\n`);
  }
  log.ok(`${id} re-queued${note ? ' with your note' : ''}. Run \`fleet do\` to continue.`);
}

async function cmdDashboard(args) {
  const root = requireRoot(args.flags);
  const cfg = cfgmod.load(root);
  const port = parseInt(args.flags.port, 10) || cfg.dashboard.port;
  const state = new State(root);
  if (!args.flags.detached) {
    let pid = null; try { pid = parseInt(fs.readFileSync(state.p.dashboardPid, 'utf8'), 10); } catch {}
    if (pidAlive(pid)) { log.info(`mission control is already running at http://127.0.0.1:${port}`); return; }
  }
  fs.writeFileSync(state.p.dashboardPid, String(process.pid));
  dashboard.serve(root, port, (url) => { if (!args.flags.detached) log.ok(`mission control: ${url}  (ctrl-c to stop)`); });
  await new Promise(() => {});
}

function cmdInit(args) {
  const r = init(args._[1], { name: args.flags.name, branch: args.flags.branch, force: !!args.flags.force });
  for (const l of r.out) log.ok(l);
  const { spawnSync } = require('child_process');
  const v = spawnSync(cfgmod.load(r.root).claude_bin, ['--version'], { encoding: 'utf8' });
  if (v.status === 0) log.ok(`claude cli ${v.stdout.trim()}`);
  else log.warn('claude cli not found on PATH; install Claude Code and sign in before `fleet do`');
  log.raw('');
  log.raw(log.bold('commands'));
  log.raw(GLOSSARY);
  log.raw('');
  log.raw(log.dim(`next: cd ${r.root} && fleet connect   (Supabase + Vercel; optional)\n      fleet do "describe what to build"`));
}

async function main(argv) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  switch (cmd) {
    case 'init': return cmdInit(args);
    case 'do': return cmdDo(args);
    case 'connect': return cmdConnect(args);
    case 'status': return status.print(requireRoot(args.flags), { id: args._[1], all: !!args.flags.all });
    case 'dashboard': return cmdDashboard(args);
    case 'release': return cmdRelease(args);
    case 'retry': return cmdRetry(args);
    case 'stop': return cmdStop(args);
    case 'help': case undefined: case '--help': case '-h':
      log.raw(log.bold('fleet') + ' — an agent fleet that builds your app\n');
      log.raw(GLOSSARY); return;
    default: throw new Error(`unknown command "${cmd}". Try: fleet help`);
  }
}

module.exports = { main, GLOSSARY, parseArgs };
