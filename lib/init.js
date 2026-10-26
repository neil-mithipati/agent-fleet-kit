'use strict';
// `fleet init`: make a repo fleet-ready. Works on an empty directory (creates
// the repo) or an existing repo (adds .fleet/ and CHANGELOG.md, touches nothing else).
const fs = require('fs');
const path = require('path');
const git = require('./git');
const { KIT_ROOT, DEFAULTS, paths } = require('./config');

function settingsFor() {
  const guard = `node "${path.join(KIT_ROOT, 'hooks', 'guard.js')}"`;
  return {
    permissions: {
      deny: [
        'Bash(git push:*)', 'Bash(git push)', 'Bash(git reset --hard:*)', 'Bash(git clean:*)', 'Bash(git filter-branch:*)',
        'Bash(git rebase -i:*)', 'Bash(git worktree:*)', 'Bash(git tag:*)', 'Bash(sudo:*)',
        'Bash(npm publish:*)', 'Bash(pnpm publish:*)', 'Bash(yarn publish:*)', 'Bash(cargo publish:*)',
        'Read(.env)', 'Read(.env.*)', 'Read(**/.env)', 'Read(**/.env.*)', 'Read(**/*.pem)', 'Read(**/id_rsa*)', 'Read(**/*.key)',
        'Edit(.env*)', 'Write(.env*)', 'Edit(.fleet/**)', 'Write(.fleet/**)',
      ],
    },
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: guard }] },
        { matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: guard }] },
      ],
    },
  };
}

const GITIGNORE_LINES = ['# agent fleet', '.fleet/state/', '.fleet/*.pid'];

function init(target, opts = {}) {
  const root = path.resolve(target || process.cwd());
  const out = [];
  fs.mkdirSync(root, { recursive: true });
  const p = paths(root);
  const fresh = !git.isRepo(root);
  const branch = opts.branch || 'main';
  if (fresh) { git.init(root, branch); out.push(`created git repository on ${branch}`); }

  // .gitignore
  const gi = path.join(root, '.gitignore');
  let gitext = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  if (!/\.fleet\/state\//.test(gitext)) {
    gitext = gitext.replace(/\s*$/, '') + (gitext ? '\n\n' : '') + GITIGNORE_LINES.join('\n') + '\n';
    fs.writeFileSync(gi, gitext); out.push('.gitignore: added .fleet/state/');
  }

  // config
  fs.mkdirSync(p.fleet, { recursive: true });
  fs.mkdirSync(p.state, { recursive: true });
  if (!fs.existsSync(p.config) || opts.force) {
    const cfg = JSON.parse(JSON.stringify(DEFAULTS));
    cfg.name = opts.name || path.basename(root);
    delete cfg.worktree_root;
    fs.writeFileSync(p.config, JSON.stringify(cfg, null, 2) + '\n');
    out.push('.fleet/config.json written');
  } else out.push('.fleet/config.json kept');
  fs.writeFileSync(p.settings, JSON.stringify(settingsFor(), null, 2) + '\n');
  out.push('.fleet/settings.json written (guard rails for agent runs)');

  fs.mkdirSync(p.agents, { recursive: true });
  const agentsReadme = path.join(p.agents, 'README.md');
  if (!fs.existsSync(agentsReadme)) {
    fs.writeFileSync(agentsReadme, `# Agent cards\n\nThe fleet's prompts live in the kit at ${path.join(KIT_ROOT, 'agents')}.\nTo customise one for this repo, copy it here with the same filename (for\nexample \`builder.md\`); a file in this directory replaces the kit's version.\n`);
  }
  const notes = path.join(p.fleet, 'HUMAN_NOTES.md');
  if (!fs.existsSync(notes)) {
    fs.writeFileSync(notes, `# Human notes\n\nThe planners read this file before planning. Put standing instructions here:\nconventions to follow, things never to touch, how to run the app, decisions\nyou have already made. Keep it short; it is loaded into every plan.\n`);
    out.push('.fleet/HUMAN_NOTES.md created');
  }

  const changelog = path.join(root, 'CHANGELOG.md');
  if (!fs.existsSync(changelog)) {
    fs.writeFileSync(changelog, '# Changelog\n\nWritten by the agent fleet at each release. Newest first.\n');
    out.push('CHANGELOG.md created');
  }
  if (fresh || !git.hasCommits(root)) {
    const readme = path.join(root, 'README.md');
    if (!fs.existsSync(readme)) fs.writeFileSync(readme, `# ${opts.name || path.basename(root)}\n\nBuilt with an agent fleet. Describe what to build with \`fleet do "..."\`.\n`);
    git.ensureIdentity(root);
    git.commitAll(root, 'fleet: init');
    out.push('initial commit made');
  }
  return { root, fresh, out };
}

module.exports = { init, settingsFor };
