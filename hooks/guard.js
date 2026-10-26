#!/usr/bin/env node
// PreToolUse hook for every fleet agent. Denies irreversible or out-of-lane
// actions. Exit 2 + stderr = deny. Anything it cannot parse passes through,
// because the permissions.deny list in .fleet/settings.json is the second wall.
'use strict';
const fs = require('fs');
const path = require('path');

// Real path of the deepest existing ancestor, so /tmp vs /private/tmp compare equal.
function realish(p) {
  let cur = path.resolve(p); const rest = [];
  while (!fs.existsSync(cur)) { rest.unshift(path.basename(cur)); const up = path.dirname(cur); if (up === cur) break; cur = up; }
  try { cur = fs.realpathSync(cur); } catch {}
  return path.join(cur, ...rest);
}
function insideCwd(f) {
  const cwd = realish(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const target = realish(f);
  return target === cwd || target.startsWith(cwd + path.sep);
}

let input = '';
process.stdin.on('data', d => (input += d));
process.stdin.on('end', () => {
  let ev; try { ev = JSON.parse(input); } catch { process.exit(0); }
  const tool = ev.tool_name || '';
  const ti = ev.tool_input || {};
  const deny = (why) => { process.stderr.write(`fleet guard: ${why}\n`); process.exit(2); };

  if (tool === 'Bash') {
    const cmd = String(ti.command || '');
    const rules = [
      [/\bgit\s+push\b/, 'agents never push; the human pushes'],
      [/\bgit\s+(reset\s+--hard|checkout\s+--\s*\.|restore\s+(--staged\s+)?\.)/, 'no discarding work'],
      [/\bgit\s+clean\b/, 'no git clean'],
      [/\bgit\s+(filter-branch|filter-repo|reflog\s+expire)\b/, 'no history rewriting'],
      [/\bgit\s+rebase\s+(-i|--interactive)\b/, 'no interactive rebase'],
      [/\bgit\s+branch\s+(-D|-d|--delete)\b/, 'the runner owns branches'],
      [/\bgit\s+worktree\b/, 'the runner owns worktrees'],
      [/\bgit\s+tag\b/, 'the runner owns tags'],
      [/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)[a-zA-Z]*\s+(\/|~|\$HOME|\.\.|\.git\b|\*)/, 'no recursive delete of roots'],
      [/\brm\s+-rf\s+\.\s*$/, 'no rm -rf .'],
      [/\bsudo\b/, 'no sudo'],
      [/\b(mkfs|dd\s+if=|shutdown|reboot|killall|pkill\s+-9\s+node)\b/, 'no system commands'],
      [/\bcurl\b.*\|\s*(ba)?sh\b/, 'no piping downloads into a shell'],
      [/\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bgh\s+(release|pr\s+merge)\b|\bvercel\s+(--prod|deploy)\b/, 'no publishing or deploying'],
      [/\bsupabase\s+(db\s+(push|reset)|link|projects|secrets|functions\s+deploy|login)\b/, 'the runner and the human own the live Supabase project'],
      [/(^|[;&|(])\s*(npx\s+|bunx\s+|pnpm\s+dlx\s+)?vercel(\s|$)/, 'the runner and the human own Vercel'],
      [/\.fleet\/(state|config\.json|settings\.json)/, '.fleet state belongs to the runner'],
      [/>\s*(?<!\w)\.env\b|(?<!\w)\.env\.(local|production)\b.*(cat|echo|printf)|\bcat\s+[^|<]*(?<![\w.])\.env\b/, 'secrets stay out of agent context'],
    ];
    for (const [re, why] of rules) if (re.test(cmd)) deny(why);
    process.exit(0);
  }

  if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
    const f = String(ti.file_path || ti.notebook_path || '');
    if (path.isAbsolute(f) && !insideCwd(f)) deny(`write outside your working directory (${f}); use paths relative to it`);
    if (/(^|\/)\.fleet\/(state|config\.json|settings\.json|agents\/)/.test(f)) deny('.fleet belongs to the runner and the human');
    if (/(^|\/)\.env(\.|$)/.test(f)) deny('secrets are the human\'s to edit');
    if (/(^|\/)CHANGELOG\.md$/.test(f) && process.env.FLEET_AGENT !== 'publisher') deny('the changelog is written at release time');
    if (/(^|\/)\.git\//.test(f)) deny('no direct .git edits');
    process.exit(0);
  }
  process.exit(0);
});
