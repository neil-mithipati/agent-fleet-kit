'use strict';
// Dispatch one agent call with the role's model, limits and tools, keep the
// live agent roster current, and record usage. Every LLM call in the fleet
// goes through here.
const path = require('path');
const { runAgent } = require('./claude');
const { TOOLS, SCHEMAS, systemPrompt } = require('./agents');

let seq = 0;

async function callAgent(ctx, role, opts) {
  const { cfg, state, log } = ctx;
  const limits = cfg.limits[role] || {};
  const runId = `${Date.now().toString(36)}-${(seq++).toString(36)}`;
  const tools = TOOLS[role] || TOOLS.builder;
  const logFile = path.join(ctx.p.runs, ctx.missionId || 'adhoc', `${opts.task || role}-${opts.attempt || 0}-${role}.log`);
  const run = {
    id: runId, role, task: opts.task || null, attempt: opts.attempt || 0, cwd: opts.cwd,
    model: cfg.models[role], started: new Date().toISOString(), turns: 0, last_tool: null, log: logFile, label: opts.label || null,
  };
  state.agentStart(run);
  log.agent(role, `${opts.task ? opts.task + ' ' : ''}${opts.label || 'start'} ${log.dim(`(${cfg.models[role]}, ≤${limits.max_turns} turns, ≤${limits.timeout_min} min)`)}`);

  let lastUpdate = 0;
  const res = await runAgent({
    bin: cfg.claude_bin, cwd: opts.cwd, role,
    prompt: opts.prompt, systemPrompt: systemPrompt(ctx.root, role),
    model: cfg.models[role], effort: cfg.effort[role],
    maxTurns: limits.max_turns, budgetUsd: limits.budget_usd,
    timeoutMs: (limits.timeout_min || 20) * 60 * 1000,
    tools: tools.tools, disallowedTools: tools.disallowed,
    schema: opts.schema ? SCHEMAS[opts.schema] : null,
    settingsFile: ctx.p.settings, logFile,
    addDirs: opts.addDirs,
    onActivity: (a) => {
      const now = Date.now();
      if (now - lastUpdate < 700) return;
      lastUpdate = now;
      state.agentUpdate(runId, { turns: a.turns, last_tool: a.lastTool });
    },
  });
  state.agentEnd(runId, { status: res.status, cost_usd: res.cost_usd, cost_estimated: !!res.cost_estimated, duration_ms: res.duration_ms, turns: res.turns, error: res.error || null });
  state.addUsage(role, res.cost_usd, res.rate_limit);
  const mins = (res.duration_ms / 60000).toFixed(1);
  if (res.ok) log.agent(role, `${opts.task ? opts.task + ' ' : ''}finished ${log.dim(`${mins} min · $${(res.cost_usd || 0).toFixed(2)} · ${res.turns} turns`)}`);
  else log.warn(`[${role}] ${opts.task ? opts.task + ' ' : ''}${res.status}: ${res.error} ${log.dim(`(${mins} min · ${res.cost_estimated ? '≤' : ''}$${(res.cost_usd || 0).toFixed(2)}${res.cost_estimated ? ' assumed: no cost reported' : ''})`)}`);
  return res;
}

module.exports = { callAgent };
