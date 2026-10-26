'use strict';
// Config, paths and defaults. Everything the fleet writes lives under <repo>/.fleet/.
const fs = require('fs');
const path = require('path');
const os = require('os');

const KIT_ROOT = path.resolve(__dirname, '..');

const DEFAULTS = {
  name: null,
  base_branch: null,             // null = branch checked out when `fleet do` runs
  max_parallel: 3,
  models: {
    planner: 'sonnet',
    'planner-deep': 'opus',
    'builder-light': 'haiku',
    builder: 'sonnet',
    'builder-deep': 'opus',
    reviewer: 'sonnet',
    'reviewer-deep': 'opus',
    publisher: 'sonnet',
  },
  effort: {
    planner: 'medium',
    'planner-deep': 'high',
    'builder-light': 'low',
    builder: 'medium',
    'builder-deep': 'high',
    reviewer: 'medium',
    'reviewer-deep': 'high',
    publisher: 'medium',
  },
  // Hard bounds per agent call. The runner kills the process at timeout_min.
  limits: {
    planner:         { max_turns: 25,  timeout_min: 8,  budget_usd: 1.5 },
    'planner-deep':  { max_turns: 50,  timeout_min: 15, budget_usd: 4.0 },
    'builder-light': { max_turns: 25,  timeout_min: 10, budget_usd: 1.0 },
    builder:         { max_turns: 60,  timeout_min: 25, budget_usd: 4.0 },
    'builder-deep':  { max_turns: 120, timeout_min: 50, budget_usd: 10.0 },
    reviewer:        { max_turns: 30,  timeout_min: 12, budget_usd: 1.5 },
    'reviewer-deep': { max_turns: 50,  timeout_min: 20, budget_usd: 4.0 },
    publisher:       { max_turns: 20,  timeout_min: 8,  budget_usd: 1.5 },
  },
  // A "small" task ships without review. These bounds are checked against the
  // real diff; a small task that escapes them is promoted and reviewed.
  small: {
    max_files: 5,
    max_lines: 200,
    sensitive: [
      '**/migrations/**', 'supabase/**', 'prisma/**', '**/schema.*',
      '**/auth/**', '**/*auth*', '**/*session*', '**/*payment*', '**/*billing*',
      'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb',
      'requirements*.txt', 'pyproject.toml', 'go.mod', 'Cargo.toml',
      '.github/**', 'Dockerfile', 'docker-compose*', '.env*', '.fleet/**', 'CHANGELOG.md',
    ],
  },
  retries: { max_attempts: 3, max_review_rounds: 2 },
  // "last_resort": retry on the same tier; escalate only for capability failures
  // on the final attempt. "eager": escalate on most failures (slower, pricier).
  escalation: 'last_resort',
  fix_tier: 'builder-light',      // lint/typecheck failures are fixed by this tier; null = task's own tier
  mission: { budget_usd: 30, timeout_min: 240 },
  gates: {},                      // { typecheck: "cmd" | null, lint: ..., test: ... } overrides
  gate_timeout_min: 10,
  release: { auto: 'large', tag_prefix: 'v', changelog: 'CHANGELOG.md' },
  push: { auto: true, remote: 'origin' },   // runner pushes the base branch after each merge and release (if the remote exists)
  dashboard: { port: 4777, auto_start: true },
  worktree_root: null,            // null = ../.fleet-worktrees/<name>
  claude_bin: 'claude',
};

function deepMerge(base, over) {
  if (Array.isArray(base) || Array.isArray(over) || typeof base !== 'object' || base === null) {
    return over === undefined ? base : over;
  }
  const out = { ...base };
  for (const k of Object.keys(over || {})) {
    out[k] = (typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k]) && typeof over[k] === 'object' && over[k] !== null && !Array.isArray(over[k]))
      ? deepMerge(base[k], over[k]) : over[k];
  }
  return out;
}

function findRepoRoot(start) {
  let dir = path.resolve(start || process.cwd());
  for (;;) {
    if (fs.existsSync(path.join(dir, '.fleet', 'config.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function paths(root) {
  const fleet = path.join(root, '.fleet');
  const state = path.join(fleet, 'state');
  return {
    root, fleet, state,
    config: path.join(fleet, 'config.json'),
    settings: path.join(fleet, 'settings.json'),
    agents: path.join(fleet, 'agents'),
    tasks: path.join(state, 'tasks'),
    runs: path.join(state, 'runs'),
    mission: path.join(state, 'mission.json'),
    missions: path.join(state, 'missions.jsonl'),
    agentsLive: path.join(state, 'agents.json'),
    events: path.join(state, 'events.jsonl'),
    releases: path.join(state, 'releases.json'),
    usage: path.join(state, 'usage.json'),
    counter: path.join(state, 'counter.json'),
    pid: path.join(state, 'fleet.pid'),
    dashboardPid: path.join(state, 'dashboard.pid'),
    stopFlag: path.join(state, 'STOP'),
  };
}

function load(root) {
  const p = paths(root);
  let user = {};
  if (fs.existsSync(p.config)) {
    try { user = JSON.parse(fs.readFileSync(p.config, 'utf8')); }
    catch (e) { throw new Error(`.fleet/config.json is not valid JSON: ${e.message}`); }
  }
  const cfg = deepMerge(DEFAULTS, user);
  if (!cfg.name) cfg.name = path.basename(root);
  if (!cfg.worktree_root) cfg.worktree_root = path.join(path.dirname(root), '.fleet-worktrees', cfg.name);
  cfg.worktree_root = path.resolve(root, cfg.worktree_root);
  return cfg;
}

function ensureDirs(root) {
  const p = paths(root);
  for (const d of [p.fleet, p.state, p.tasks, p.runs, p.agents]) fs.mkdirSync(d, { recursive: true });
  return p;
}

module.exports = { KIT_ROOT, DEFAULTS, deepMerge, findRepoRoot, paths, load, ensureDirs, homedir: os.homedir };
