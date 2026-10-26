'use strict';
// One agent call = one `claude -p` process. Stateless, bounded by turns, dollars
// and wall clock. Streams events so the dashboard can show what the agent is
// doing right now. Returns the structured output or a failure reason.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SLIM_FLAGS = [
  '--strict-mcp-config',          // no MCP servers from user config
  '--setting-sources', 'project', // ignore ~/.claude settings and plugins
  '--disable-slash-commands',     // no skills in context
  '--no-session-persistence',
  '--permission-prompts', 'none',
];

function summarizeToolUse(block) {
  const i = block.input || {};
  switch (block.name) {
    case 'Bash': return `$ ${(i.description || i.command || '').toString().slice(0, 80)}`;
    case 'Read': return `read ${rel(i.file_path)}`;
    case 'Edit': case 'MultiEdit': return `edit ${rel(i.file_path)}`;
    case 'Write': return `write ${rel(i.file_path)}`;
    case 'Grep': return `grep ${(i.pattern || '').slice(0, 40)}`;
    case 'Glob': return `glob ${(i.pattern || '').slice(0, 40)}`;
    case 'StructuredOutput': return 'writing result';
    default: return block.name;
  }
}
function rel(p) { if (!p) return ''; const parts = String(p).split('/'); return parts.slice(-2).join('/'); }

/**
 * @param {object} opts
 *  bin, cwd, prompt, systemPrompt, model, effort, maxTurns, budgetUsd, timeoutMs,
 *  tools (array|null), disallowedTools (array), schema (object|null), settingsFile,
 *  logFile, onActivity(fn), env
 */
function runAgent(opts) {
  return new Promise((resolve) => {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', ...SLIM_FLAGS];
    args.push('--permission-mode', opts.permissionMode || 'bypassPermissions');
    if (opts.model) args.push('--model', opts.model);
    if (opts.effort) args.push('--effort', opts.effort);
    if (opts.maxTurns) args.push('--max-turns', String(opts.maxTurns));
    if (opts.budgetUsd) args.push('--max-budget-usd', String(opts.budgetUsd));
    if (opts.tools) args.push('--tools', opts.tools.join(','));
    if (opts.disallowedTools && opts.disallowedTools.length) args.push('--disallowedTools', ...opts.disallowedTools);
    if (opts.settingsFile && fs.existsSync(opts.settingsFile)) args.push('--settings', opts.settingsFile);
    if (opts.systemPrompt) args.push('--append-system-prompt', opts.systemPrompt);
    if (opts.schema) args.push('--json-schema', JSON.stringify(opts.schema));
    for (const d of opts.addDirs || []) args.push('--add-dir', d);

    const env = { ...process.env, ...(opts.env || {}), CI: '1', FLEET_AGENT: opts.role || 'agent' };
    delete env.CLAUDECODE; // allow launching from inside another Claude Code session

    const started = Date.now();
    let log = null;
    if (opts.logFile) {
      fs.mkdirSync(path.dirname(opts.logFile), { recursive: true });
      log = fs.createWriteStream(opts.logFile, { flags: 'a' });
      log.write(`# ${new Date().toISOString()} ${opts.bin || 'claude'} ${args.map(a => (a.length > 120 ? a.slice(0, 117) + '...' : a)).join(' ')}\n`);
      log.write(`# cwd ${opts.cwd}\n# prompt:\n${opts.prompt}\n# --- stream ---\n`);
    }

    let child;
    try {
      child = spawn(opts.bin || 'claude', args, { cwd: opts.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    } catch (e) {
      return resolve({ ok: false, status: 'crashed', error: `could not start claude: ${e.message}`, cost_usd: 0, duration_ms: 0 });
    }

    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, opts.timeoutMs || 20 * 60 * 1000);
    const killer = () => killTree(child);
    process.on('exit', killer);

    let buf = '';
    let stderr = '';
    let result = null;
    let turns = 0;
    let lastTool = null;
    let costSoFar = 0;
    let rateLimit = null;
    const textOut = [];

    child.stdout.on('data', (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const lineStr = buf.slice(0, idx); buf = buf.slice(idx + 1);
        if (!lineStr.trim()) continue;
        if (log) log.write(lineStr + '\n');
        let ev; try { ev = JSON.parse(lineStr); } catch { continue; }
        handle(ev);
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 20000) stderr = stderr.slice(-20000); });

    function handle(ev) {
      if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
        turns++;
        for (const b of ev.message.content) {
          if (b.type === 'tool_use') { lastTool = summarizeToolUse(b); }
          else if (b.type === 'text' && b.text) textOut.push(b.text);
        }
        if (ev.message.usage) {
          // Rough running cost estimate isn't available per message; track turns only.
        }
        opts.onActivity && opts.onActivity({ turns, lastTool, text: textOut.slice(-1)[0] });
      } else if (ev.type === 'rate_limit_event' && ev.rate_limit_info) {
        rateLimit = ev.rate_limit_info;
      } else if (ev.type === 'result') {
        result = ev;
        costSoFar = ev.total_cost_usd || 0;
      }
    }

    child.stdin.end(opts.prompt || '');

    child.on('error', (e) => {
      clearTimeout(timer); process.removeListener('exit', killer);
      resolve({ ok: false, status: 'crashed', error: e.message, cost_usd: 0, duration_ms: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer); process.removeListener('exit', killer);
      if (log) { log.write(`# exit ${code}${timedOut ? ' (timeout)' : ''}\n`); log.end(); }
      const duration_ms = Date.now() - started;
      const base = { cost_usd: costSoFar, duration_ms, turns, rate_limit: rateLimit, text: textOut.join('\n').slice(-6000), stderr: stderr.slice(-3000) };
      if (timedOut) return resolve({ ok: false, status: 'timeout', error: `timed out after ${Math.round(duration_ms / 60000)} min`, ...base });
      if (!result) return resolve({ ok: false, status: 'crashed', error: `claude exited ${code} without a result${stderr ? ': ' + stderr.trim().split('\n').slice(-3).join(' | ') : ''}`, ...base });
      if (result.is_error || result.subtype !== 'success') {
        const sub = result.subtype || 'error';
        const status = /max_turns/.test(sub) ? 'max_turns' : /budget/.test(sub) ? 'budget' : 'error';
        return resolve({ ok: false, status, error: `${sub}${result.result ? ': ' + String(result.result).slice(0, 300) : ''}`, ...base });
      }
      let output = result.structured_output;
      if (output === undefined && opts.schema) output = extractJson(result.result);
      if (opts.schema && (output === undefined || output === null)) {
        return resolve({ ok: false, status: 'bad_output', error: 'agent finished without structured output', ...base });
      }
      resolve({ ok: true, status: 'ok', output, result_text: result.result, ...base });
    });
  });
}

function extractJson(text) {
  if (!text) return undefined;
  const fence = text.match(/```json\s*([\s\S]*?)```/);
  const candidates = [fence && fence[1], text];
  for (const c of candidates) {
    if (!c) continue;
    try { return JSON.parse(c.trim()); } catch {}
    const i = c.indexOf('{'), j = c.lastIndexOf('}');
    if (i >= 0 && j > i) { try { return JSON.parse(c.slice(i, j + 1)); } catch {} }
  }
  return undefined;
}

function killTree(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
  setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000).unref();
}

module.exports = { runAgent, extractJson, SLIM_FLAGS };
