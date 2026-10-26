'use strict';
// Git plumbing: worktrees, merges, diff stats. Shell-free (spawnSync with arg arrays).
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function git(cwd, args, opts = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' } });
  const out = { code: r.status, stdout: opts.raw ? (r.stdout || '') : (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
  if (r.status !== 0 && !opts.allowFail) {
    const e = new Error(`git ${args.join(' ')} failed (${r.status}): ${out.stderr || out.stdout}`);
    e.git = out; throw e;
  }
  return out;
}

const isRepo = (cwd) => git(cwd, ['rev-parse', '--is-inside-work-tree'], { allowFail: true }).code === 0;
const hasCommits = (cwd) => git(cwd, ['rev-parse', '--verify', 'HEAD'], { allowFail: true }).code === 0;
const currentBranch = (cwd) => git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout;
const headSha = (cwd) => git(cwd, ['rev-parse', '--short', 'HEAD']).stdout;
const isDirty = (cwd) => git(cwd, ['status', '--porcelain', '--untracked-files=no']).stdout.length > 0;
const dirtyFiles = (cwd) => git(cwd, ['status', '--porcelain'], { raw: true }).stdout.split('\n').filter(Boolean).map(l => l.slice(3).replace(/^"|"$/g, ''));

function init(cwd, branch = 'main') {
  fs.mkdirSync(cwd, { recursive: true });
  if (!isRepo(cwd)) {
    const r = git(cwd, ['init', '-b', branch], { allowFail: true });
    if (r.code !== 0) { git(cwd, ['init']); git(cwd, ['checkout', '-b', branch], { allowFail: true }); }
  }
}

function ensureIdentity(cwd) {
  const name = git(cwd, ['config', 'user.name'], { allowFail: true }).stdout;
  const email = git(cwd, ['config', 'user.email'], { allowFail: true }).stdout;
  if (!name) git(cwd, ['config', 'user.name', 'fleet']);
  if (!email) git(cwd, ['config', 'user.email', 'fleet@localhost']);
}

function commitAll(cwd, message) {
  git(cwd, ['add', '-A']);
  if (!git(cwd, ['status', '--porcelain']).stdout) return null;
  ensureIdentity(cwd);
  git(cwd, ['commit', '-q', '-m', message]);
  return headSha(cwd);
}

function branchExists(cwd, name) {
  return git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { allowFail: true }).code === 0;
}

function worktreeList(cwd) {
  const out = git(cwd, ['worktree', 'list', '--porcelain']).stdout;
  const list = []; let cur = null;
  for (const l of out.split('\n')) {
    if (l.startsWith('worktree ')) { cur = { path: l.slice(9) }; list.push(cur); }
    else if (cur && l.startsWith('branch ')) cur.branch = l.slice(7).replace('refs/heads/', '');
  }
  return list;
}

/** Create (or reuse) a worktree for a task branch off base. Returns the path. */
function ensureWorktree(root, wtRoot, id, base) {
  const dir = path.join(wtRoot, id);
  const branch = `fleet/${id}`;
  const real = (x) => { try { return fs.realpathSync(x); } catch { return path.resolve(x); } };
  const existing = worktreeList(root).find(w => real(w.path) === real(dir));
  if (existing && fs.existsSync(dir)) return { dir, branch, reused: true };
  if (existing) git(root, ['worktree', 'remove', '--force', dir], { allowFail: true });
  git(root, ['worktree', 'prune'], { allowFail: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  if (branchExists(root, branch)) git(root, ['worktree', 'add', dir, branch]);
  else git(root, ['worktree', 'add', '-b', branch, dir, base]);
  shareDeps(root, dir);
  return { dir, branch, reused: false };
}

/** Symlink dependency dirs from the main checkout so a worktree can run gates without reinstalling. */
function shareDeps(root, dir) {
  for (const dep of ['node_modules', '.venv', 'vendor']) {
    const src = path.join(root, dep), dst = path.join(dir, dep);
    if (fs.existsSync(src) && !fs.existsSync(dst)) { try { fs.symlinkSync(src, dst, 'dir'); } catch {} }
  }
}

function removeWorktree(root, dir, branch) {
  git(root, ['worktree', 'remove', '--force', dir], { allowFail: true });
  git(root, ['worktree', 'prune'], { allowFail: true });
  if (branch) git(root, ['branch', '-D', branch], { allowFail: true });
}

/** Diff stats of branch vs base: files, insertions, deletions. */
function diffStat(cwd, base) {
  const files = git(cwd, ['diff', '--name-only', `${base}...HEAD`], { allowFail: true }).stdout.split('\n').filter(Boolean);
  const num = git(cwd, ['diff', '--numstat', `${base}...HEAD`], { allowFail: true }).stdout.split('\n').filter(Boolean);
  let ins = 0, del = 0;
  for (const l of num) { const [a, b] = l.split('\t'); ins += parseInt(a, 10) || 0; del += parseInt(b, 10) || 0; }
  return { files, insertions: ins, deletions: del, lines: ins + del };
}

function diffText(cwd, base, maxChars = 60000) {
  const d = git(cwd, ['diff', `${base}...HEAD`], { allowFail: true }).stdout;
  return d.length > maxChars ? d.slice(0, maxChars) + `\n... (diff truncated, ${d.length - maxChars} more chars)` : d;
}

function aheadCount(cwd, base) {
  return parseInt(git(cwd, ['rev-list', '--count', `${base}..HEAD`], { allowFail: true }).stdout, 10) || 0;
}

/** Merge a task branch into the base branch in the main checkout. */
function mergeBranch(root, branch, base, message) {
  if (currentBranch(root) !== base) throw new Error(`main checkout is on ${currentBranch(root)}, expected ${base}`);
  ensureIdentity(root);
  const r = git(root, ['merge', '--no-ff', '--no-edit', '-m', message, branch], { allowFail: true });
  if (r.code === 0) return { ok: true, sha: headSha(root) };
  git(root, ['merge', '--abort'], { allowFail: true });
  const conflict = /CONFLICT|conflict/i.test(r.stdout + r.stderr);
  return { ok: false, conflict, error: (r.stderr || r.stdout).slice(-2000) };
}

/** Bring a task branch up to date with base (merge base into it, inside the worktree). */
function syncWithBase(wt, base) {
  const r = git(wt, ['merge', '--no-edit', base], { allowFail: true });
  if (r.code === 0) return { ok: true };
  git(wt, ['merge', '--abort'], { allowFail: true });
  return { ok: false, conflict: /CONFLICT/i.test(r.stdout + r.stderr), error: (r.stderr || r.stdout).slice(-2000) };
}

function log(cwd, range, max = 200) {
  return git(cwd, ['log', '--no-merges', `--max-count=${max}`, '--pretty=format:%h %s', range], { allowFail: true }).stdout;
}
function lastTag(cwd, prefix) {
  const r = git(cwd, ['describe', '--tags', '--abbrev=0', '--match', `${prefix}*`], { allowFail: true });
  return r.code === 0 ? r.stdout : null;
}
function tag(cwd, name, message) { git(cwd, ['tag', '-a', name, '-m', message]); }
function hasRemote(cwd, name) {
  const remotes = git(cwd, ['remote'], { allowFail: true }).stdout.split('\n').filter(Boolean);
  return name ? remotes.includes(name) : remotes.length > 0;
}

/** Push branch (and optional tags) to remote. Fast-forwards from the remote first if it moved. Never forces. */
function push(cwd, remote, branch, tags = []) {
  const attempt = () => git(cwd, ['push', '-u', remote, branch], { allowFail: true });
  let r = attempt();
  if (r.code !== 0 && /rejected|fetch first|non-fast-forward/i.test(r.stderr + r.stdout)) {
    git(cwd, ['fetch', remote, branch], { allowFail: true });
    let ff = git(cwd, ['merge', '--ff-only', `${remote}/${branch}`], { allowFail: true });
    if (ff.code !== 0) {
      // someone else pushed too: merge their commits in (never rebase, never force)
      ensureIdentity(cwd);
      ff = git(cwd, ['merge', '--no-edit', '-m', `merge ${remote}/${branch}`, `${remote}/${branch}`], { allowFail: true });
      if (ff.code !== 0) { git(cwd, ['merge', '--abort'], { allowFail: true }); return { ok: false, error: `remote ${remote}/${branch} conflicts with local ${branch}; merge it yourself, then push` }; }
    }
    r = attempt();
  }
  if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout).split('\n').slice(-2).join(' ') };
  for (const t of tags) {
    const tr = git(cwd, ['push', remote, `refs/tags/${t}`], { allowFail: true });
    if (tr.code !== 0) return { ok: true, tagError: (tr.stderr || tr.stdout).split('\n').slice(-1)[0] };
  }
  return { ok: true };
}

module.exports = {
  git, isRepo, hasCommits, currentBranch, headSha, isDirty, dirtyFiles, init, ensureIdentity, commitAll,
  branchExists, worktreeList, ensureWorktree, removeWorktree, diffStat, diffText, aheadCount, mergeBranch,
  syncWithBase, log, lastTag, tag, hasRemote, push, shareDeps,
};
