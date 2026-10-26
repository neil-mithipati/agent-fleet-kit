'use strict';
// `fleet connect`: create and link the app's Supabase project and Vercel
// project with the human's own CLI logins. Runs in the runner, never in an
// agent: agents get no credentials, and the secrets land in .env.local, which
// agents are denied from reading.
//
// Also exports dbPush(), which the runner calls after a merge that adds
// Supabase migrations when db_push is "auto".
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const git = require('./git');
const { run, parseJson } = require('./sh');

const ENV_FILE = '.env.local';
const PUBLIC_VARS = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'];

// ---- .env.local ------------------------------------------------------------
function readEnv(root) {
  const env = {};
  try {
    for (const l of fs.readFileSync(path.join(root, ENV_FILE), 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(l);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
  return env;
}
function writeEnv(root, patch) {
  const file = path.join(root, ENV_FILE);
  let lines = []; try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch {}
  const left = { ...patch };
  lines = lines.map(l => { const m = /^\s*([A-Z0-9_]+)\s*=/.exec(l); if (m && m[1] in left) { const v = left[m[1]]; delete left[m[1]]; return `${m[1]}=${v}`; } return l; });
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const [k, v] of Object.entries(left)) lines.push(`${k}=${v}`);
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
}
function ensureIgnored(root) {
  const gi = path.join(root, '.gitignore');
  let s = ''; try { s = fs.readFileSync(gi, 'utf8'); } catch {}
  const need = ['.env*.local', '.vercel', 'supabase/.temp/'].filter(p => !s.split('\n').some(l => l.trim() === p || (p === '.env*.local' && /^\.env\*?(\.local)?$/.test(l.trim()))));
  if (need.length) fs.writeFileSync(gi, s.replace(/\s*$/, '') + (s ? '\n\n' : '') + '# secrets and local links (fleet connect)\n' + need.join('\n') + '\n');
}

// ---- small helpers -----------------------------------------------------------
function readRaw(root) { try { return JSON.parse(fs.readFileSync(path.join(root, '.fleet', 'config.json'), 'utf8')); } catch { return {}; } }
function saveRaw(root, patch) {
  const c = readRaw(root);
  for (const [k, v] of Object.entries(patch)) c[k] = { ...(c[k] || {}), ...v };
  fs.writeFileSync(path.join(root, '.fleet', 'config.json'), JSON.stringify(c, null, 2) + '\n');
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const lastLine = (r) => (r.err || r.out || '').split('\n').filter(Boolean).slice(-2).join(' | ') || `exit ${r.code}`;

/** Pick the browser-safe key: publishable if present, else anon. Never service_role / secret. */
function pickPublicKey(keys) {
  if (!Array.isArray(keys)) return null;
  const k = (e) => e.api_key || e.key || e.value;
  const pub = keys.find(e => e.type === 'publishable' || /^sb_publishable_/.test(k(e) || ''));
  const anon = keys.find(e => e.name === 'anon');
  const chosen = pub || anon;
  return chosen ? k(chosen) : null;
}

// ---- supabase ---------------------------------------------------------------
async function connectSupabase(ctx, opts) {
  const { root, cfg, log } = ctx;
  const sb = cfg.connect.supabase_bin;
  const sbEnv = (pw) => ({ SUPABASE_DB_PASSWORD: pw });
  const raw = readRaw(root);
  let ref = (raw.supabase && raw.supabase.project_ref) || null;
  const env = readEnv(root);
  let pw = env.SUPABASE_DB_PASSWORD;

  const who = await run(sb, ['projects', 'list', '-o', 'json'], { cwd: root, timeoutMs: 60000 });
  if (who.missing) throw new Error('supabase CLI not found. Install it (brew install supabase/tap/supabase), run `supabase login`, then retry.');
  if (who.code !== 0) throw new Error(`supabase CLI is not signed in (${lastLine(who)}). Run \`supabase login\`, then retry.`);

  if (!fs.existsSync(path.join(root, 'supabase', 'config.toml'))) {
    const r = await run(sb, ['init'], { cwd: root, timeoutMs: 60000 });
    if (r.code !== 0) throw new Error(`supabase init failed: ${lastLine(r)}`);
    log.ok('supabase: initialised supabase/');
  }

  if (ref) log.info(`supabase: project ${ref} already connected; refreshing keys`);
  else {
    let org = opts.org || cfg.connect.org_id;
    if (!org) {
      const orgs = parseJson((await run(sb, ['orgs', 'list', '-o', 'json'], { cwd: root, timeoutMs: 60000 })).out) || [];
      if (orgs.length === 1) org = orgs[0].id || orgs[0].slug;
      else if (!orgs.length) throw new Error('no Supabase organization found; create one at supabase.com first');
      else throw new Error(`you belong to ${orgs.length} Supabase orgs; pick one: fleet connect --org <id>\n${orgs.map(o => `  ${o.id || o.slug}  ${o.name}`).join('\n')}`);
    }
    pw = pw || crypto.randomBytes(24).toString('base64url');
    const name = opts.name || cfg.name;
    const region = opts.region || cfg.connect.region;
    log.info(`supabase: creating project "${name}" in ${region}…`);
    const c = await run(sb, ['projects', 'create', name, '--org-id', org, '--db-password', pw, '--region', region, '-o', 'json'], { cwd: root, timeoutMs: 180000 });
    if (c.code !== 0) throw new Error(`supabase projects create failed: ${lastLine(c)}`);
    const p = parseJson(c.out) || {};
    ref = p.id || p.ref || (/\b([a-z]{20})\b/.exec(c.out) || [])[1];
    if (!ref) throw new Error(`could not read the new project's ref from: ${c.out.slice(0, 300)}`);
    writeEnv(root, { SUPABASE_DB_PASSWORD: pw }); // saved before anything else can fail
    saveRaw(root, { supabase: { project_ref: ref } });
    log.ok(`supabase: created project ${ref}`);
  }
  if (!pw) throw new Error(`SUPABASE_DB_PASSWORD is missing from ${ENV_FILE}; add it (Supabase dashboard → Database settings) and retry`);

  // a new project takes a minute or two to come up; link retries until it does
  let linked = false;
  for (let i = 0; i < (opts.linkTries || 24) && !linked; i++) {
    const l = await run(sb, ['link', '--project-ref', ref], { cwd: root, env: sbEnv(pw), timeoutMs: 120000 });
    if (l.code === 0) linked = true;
    else { if (i === 0) log.info('supabase: waiting for the project to come up…'); await sleep(opts.linkWaitMs ?? 15000); }
  }
  if (!linked) throw new Error(`supabase link to ${ref} kept failing; the project may still be provisioning. Re-run \`fleet connect\` in a minute.`);
  log.ok(`supabase: linked ${ref}`);

  const k = await run(sb, ['projects', 'api-keys', '--project-ref', ref, '-o', 'json'], { cwd: root, timeoutMs: 60000 });
  const key = pickPublicKey(parseJson(k.out));
  if (!key) throw new Error(`could not read the project's publishable/anon key: ${lastLine(k)}`);
  writeEnv(root, { VITE_SUPABASE_URL: `https://${ref}.supabase.co`, VITE_SUPABASE_ANON_KEY: key });
  log.ok(`supabase: URL and publishable key written to ${ENV_FILE}`);
  return { ref };
}

// ---- vercel -----------------------------------------------------------------
async function connectVercel(ctx, opts) {
  const { root, cfg, log } = ctx;
  const vc = cfg.connect.vercel_bin;
  const who = await run(vc, ['whoami'], { cwd: root, timeoutMs: 60000 });
  if (who.missing) throw new Error('vercel CLI not found. Install it (npm i -g vercel), run `vercel login`, then retry.');
  if (who.code !== 0) throw new Error(`vercel CLI is not signed in (${lastLine(who)}). Run \`vercel login\`, then retry.`);

  const name = opts.name || cfg.name;
  const l = await run(vc, ['link', '--yes', '--project', name], { cwd: root, timeoutMs: 120000 });
  if (l.code !== 0) throw new Error(`vercel link failed: ${lastLine(l)}`);
  log.ok(`vercel: linked project ${name}`);

  if (git.hasRemote(root, cfg.push.remote)) {
    const g = await run(vc, ['git', 'connect', '--yes'], { cwd: root, timeoutMs: 120000 });
    if (g.code === 0 || /already connected/i.test(g.err + g.out)) log.ok('vercel: connected to the GitHub repo; every push to main deploys');
    else log.warn(`vercel git connect failed (${lastLine(g)}). Connect the repo in the Vercel dashboard so pushes deploy.`);
  } else log.warn(`no "${cfg.push.remote}" remote yet: add one (git remote add origin <url>), then re-run \`fleet connect --vercel\` so pushes deploy`);

  const env = readEnv(root);
  const vars = PUBLIC_VARS.filter(v => env[v]);
  for (const v of vars) for (const target of ['production', 'preview', 'development']) {
    const r = await run(vc, ['env', 'add', v, target, '--value', env[v], '--no-sensitive', '--yes', '--force'], { cwd: root, timeoutMs: 60000 });
    if (r.code !== 0) log.warn(`vercel env add ${v} ${target} failed: ${lastLine(r)}`);
  }
  if (vars.length) log.ok(`vercel: set ${vars.join(', ')} for production, preview, development`);
  else log.warn('vercel: no Supabase env vars to set yet (connect Supabase first)');
}

// ---- db push ---------------------------------------------------------------
/** Files under supabase/migrations/ changed between two commits. */
function migrationsBetween(root, from, to) {
  if (!from) return [];
  const r = git.git(root, ['diff', '--name-only', `${from}..${to}`, '--', 'supabase/migrations'], { allowFail: true });
  return r.stdout.split('\n').filter(Boolean);
}

/** Apply pending migrations to the linked Supabase project. Never throws. */
async function dbPush(ctx, why) {
  const { root, cfg, log, state } = ctx;
  const ref = (readRaw(root).supabase || {}).project_ref;
  if (!ref) { log.info('migrations merged, but no Supabase project is connected (fleet connect); skipping db push'); return { ok: false, skipped: true }; }
  const pw = readEnv(root).SUPABASE_DB_PASSWORD;
  if (!pw) { log.warn(`db push skipped: SUPABASE_DB_PASSWORD missing from ${ENV_FILE}`); return { ok: false, skipped: true }; }
  const sb = cfg.connect.supabase_bin;
  const env = { SUPABASE_DB_PASSWORD: pw };
  if (!fs.existsSync(path.join(root, 'supabase', '.temp', 'project-ref'))) await run(sb, ['link', '--project-ref', ref], { cwd: root, env, timeoutMs: 120000 });
  const r = await run(sb, ['db', 'push', '--linked', '--yes'], { cwd: root, env, timeoutMs: 10 * 60 * 1000 });
  const ok = r.code === 0;
  if (ok) log.ok(`db push: migrations applied to ${ref}`);
  else log.warn(`db push to ${ref} FAILED: ${lastLine(r)}`);
  if (state) state.event({ kind: 'db_push', ref, note: ok ? why : `FAILED after ${why}: ${lastLine(r)}`, failed: !ok });
  return { ok, error: ok ? null : lastLine(r) };
}

// ---- command ----------------------------------------------------------------
async function connect(ctx, opts = {}) {
  const { root, cfg, log } = ctx;
  const doSb = !opts.vercel || opts.supabase, doVc = !opts.supabase || opts.vercel;
  ensureIgnored(root);
  if (doSb) await connectSupabase(ctx, opts);
  if (doVc) await connectVercel(ctx, opts);
  ensureIgnored(root); // the CLIs may have rewritten .gitignore

  git.git(root, ['add', '--', '.gitignore', '.fleet/config.json', ...(fs.existsSync(path.join(root, 'supabase')) ? ['supabase'] : [])], { allowFail: true });
  const staged = git.git(root, ['diff', '--cached', '--name-only'], { allowFail: true }).stdout;
  if (staged) {
    git.ensureIdentity(root);
    git.git(root, ['commit', '-q', '-m', 'fleet: connect supabase + vercel']);
    log.ok('committed supabase/ and config (secrets stay in .env.local, gitignored)');
    if (cfg.push.auto && git.hasRemote(root, cfg.push.remote)) {
      const p = git.push(root, cfg.push.remote, git.currentBranch(root));
      p.ok ? log.ok(`pushed to ${cfg.push.remote}`) : log.warn(`push failed: ${p.error}`);
    }
  }
  if (doSb && cfg.db_push === 'auto') {
    const dir = path.join(root, 'supabase', 'migrations');
    if (fs.existsSync(dir) && fs.readdirSync(dir).some(f => f.endsWith('.sql'))) await dbPush(ctx, 'fleet connect');
  }
}

module.exports = { connect, dbPush, migrationsBetween, readEnv, writeEnv, pickPublicKey, ensureIgnored, ENV_FILE };
