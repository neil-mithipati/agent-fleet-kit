# Architecture

This document explains how the fleet works and why it is shaped this way. The
companion [README](README.md) covers usage.

## The one idea

The previous kit put an LLM in charge of the loop: an orchestrator agent decided
what to dispatch, when to retry, when to stop, and a `Stop` hook pushed it back
into the loop when it tried to end early. Every failure mode the kit had —
endless loops, misdirected tasks, work marked done on a builder's say-so, slow
turns — traces back to that choice.

This fleet inverts it. **A small deterministic runner owns the loop. Models do
one job per call and return data.**

```
                          human
                            │  fleet do "..."
                            ▼
                     ┌─────────────┐
                     │   runner    │  (node, no LLM)
                     │  scheduler  │  bounds: attempts, review rounds, time, dollars, parallelism
                     └──┬───────┬──┘
          plan JSON     │       │  result JSON
   ┌────────────────────┘       └────────────────────────┐
   ▼                                                      ▼
planner ──escalate──▶ planner-deep         builder-light ──▶ (gates only) ──▶ merge
                                           builder       ──▶ reviewer      ──▶ merge
                                           builder-deep  ──▶ reviewer-deep ──▶ merge
                                                               ▲    │
                                                  escalate ────┘    └── fail → builder (bounded)
                                                                                │
                                                                   publisher ◀──┘ (at release)
```

The node names come from the agent graph in the original kit: a planner that
decomposes, three builder tiers, two reviewer tiers, a publisher. The edges are
the same too (escalation between tiers, reviewer → reviewer-deep, publisher at
the end). What changed is who follows the edges.

## Agents are stateless processes

Every agent call is one `claude -p` process:

- started in the task's own git worktree,
- given a role card as the system prompt and the task as the user prompt,
- limited by `--max-turns`, `--max-budget-usd`, and a wall-clock timeout the
  runner enforces by killing the process group,
- required to return JSON matching a schema (`--json-schema`), so the runner
  parses a verdict or a plan instead of prose,
- run with user-level MCP servers, plugins and skills stripped out
  (`--strict-mcp-config --setting-sources project --disable-slash-commands`).
  On a typical developer machine this cuts the per-call context from ~225K
  tokens to ~4K and the start-up latency from ~8s to ~2.5s. It is the single
  biggest speed and cost win in the kit.

Agents never talk to each other. The runner carries artifacts between them:
the task record, the diff, the runner's own gate output, review findings.

## Where loops can and cannot happen

Every loop is in `lib/scheduler.js`, and every loop has a counter:

| loop | bound | then |
|---|---|---|
| build attempts per task | `retries.max_attempts` (3) | `needs_human` |
| review rounds per task | `retries.max_review_rounds` (2) | `needs_human` |
| tier escalation (`escalation: last_resort`) | only before the final attempt, only for `failed`, `no_changes` or a failing test gate | escalate one tier |
| agent turns | per-role `limits.max_turns` | the call fails, counts as an attempt |
| agent wall clock | per-role `limits.timeout_min` | killed, counts as an attempt, charged its `budget_usd` cap |
| agent dollars | per-role `limits.budget_usd` | the call fails, counts as an attempt |
| mission wall clock | `mission.timeout_min` | remaining tasks → `needs_human` |
| mission dollars | `mission.budget_usd` | remaining tasks → `needs_human` |
| planner hops | 3 (fast → deep → validator retry) | planning fails, nothing dispatched |

A `blocked` report from a builder ends the task immediately (`needs_human`) with
the builder's question attached, except from `builder-light`, where it means
"this needs a stronger tier" and is treated as an escalation. Blocked tasks are
never retried automatically; retrying a question with a different model does
not answer it.

## Why work is trusted

Nothing an agent says about its own work is trusted:

- **Gates are run by the runner** after the builder exits (`lib/gates.js`).
  They are detected from the repo (`package.json` scripts, `tsconfig.json`,
  `pyproject.toml`, `go.mod`, `Cargo.toml`) and can be overridden in
  `.fleet/config.json`. Output goes verbatim into the next attempt's prompt.
- **The small-task boundary is checked against the real diff**
  (`lib/boundary.js`). Small tasks skip review by design; if the diff has too
  many files or lines, or touches a sensitive path (migrations, auth,
  manifests, CI, `.env`, `.fleet/`), the task is promoted and reviewed.
- **Reviewers run the gates again** and return per-criterion verdicts. Only
  `high` findings block; medium and low are kept and surface in the changelog
  so the human sees them without the fleet stalling on them.
- **Merges happen in the main checkout, serialized**, after the branch is
  synced with the base. A conflict gets one builder attempt at resolution, then
  `needs_human`. Each successful merge is pushed (see Safety).

## Routing

Size is chosen by the planner and enforced by code:

| size | builder | review | typical |
|---|---|---|---|
| small | builder-light (haiku) | none; gates + boundary | copy, styling, config, one-file fix |
| medium | builder (sonnet) | reviewer (sonnet) | a feature following an existing pattern |
| large | builder-deep (opus) | reviewer-deep (opus), two passes | scaffold, data model, auth, cross-cutting |

Retries continue from the same worktree, with the previous attempt's notes and
the gate output or findings in its prompt. The default policy
(`escalation: "last_resort"`) retries on the same tier: most failures are
fixed by the context in the prompt, not by a bigger model. A tier escalation
happens only before the final attempt, and only for capability failures
(`failed`, no changes, a failing test gate). Timeouts and turn limits never
escalate, since stronger models are slower; the retry picks up the committed
work in progress. A lint or typecheck failure is mechanical, so its fix goes
to `fix_tier` (haiku) for one attempt, then back to the task's own tier.
`escalation: "eager"` restores escalate-on-most-failures. A reviewer that discovers a medium task actually touches auth or
data escalates to the deep reviewer rather than improvising an adversarial
pass.

## Planning

Two planners mirror the tiers. The fast planner (sonnet) handles most requests
in one short call and may return `escalate`; the deep planner (opus) surveys
the repo and designs. Both return the same schema and both are validated as
data before anything runs: unique ids, non-empty acceptance criteria, known
dependencies, no cycles, ≤20 tasks. Tasks that touch the same files are
automatically serialized by adding a dependency edge.

Planners are told to prefer a recorded assumption over a question. Assumptions
are printed at plan time and written into the changelog so the human can
correct them later. A plan with `questions` dispatches nothing.

An empty repository always goes to the deep planner and starts with a scaffold
task.

## State

Everything lives on disk under `.fleet/state/` (gitignored):

```
mission.json          the current or last mission
missions.jsonl        history
tasks/T-001.json      one record per task: spec, state, attempts, findings, cost
agents.json           live agent processes and the last 50 finished runs
events.jsonl          append-only log, feeds the dashboard and `fleet status`
usage.json            spend by role, last rate-limit reading
releases.json         releases written
runs/<mission>/       raw stream-json log of every agent call
fleet.pid             runner pid; `fleet do` refuses to double-run
```

Because state is on disk and agents are stateless, a crash or `fleet stop`
loses nothing: `fleet do` with no request requeues in-flight tasks and
continues from their worktrees.

Worktrees live outside the repo (`../.fleet-worktrees/<name>/<task>`) so test
runners and linters in the main checkout never see them. `node_modules`,
`.venv` and `vendor` are symlinked from the main checkout.

## Safety

Three layers, all independent of the model's goodwill:

1. `permissions.deny` in `.fleet/settings.json` (passed with `--settings`):
   no push, no hard reset, no history rewrite, no publish, no reading `.env*`
   or keys.
2. `hooks/guard.js` as a `PreToolUse` hook on Bash and file edits, with the
   same rules plus: agents cannot touch `.fleet/`, `CHANGELOG.md` or `.git/`.
3. Tool grants per role (`lib/agents.js`): planners, reviewers and the
   publisher cannot edit files at all.

Agents never push. The runner does, after each merge and each release
(`push.auto`, on by default): a plain `git push` of the base branch and
release tags. If the remote moved, the runner fast-forwards or merges the
remote commits in first; on conflict it aborts and reports. It never forces
and never rebases.

## Dashboard

`lib/dashboard.js` is a dependency-free HTTP server: one static page and
`/api/state`, which is a JSON snapshot of the files above. The page polls every
two seconds. It is started detached by `fleet do` when
`dashboard.auto_start` is true, or by `fleet dashboard`.

## Testing without spending

`test/fake-claude.js` imitates `claude -p` (same flags, same stream-json) and
plays scripted roles; `test/e2e.sh <scenario>` runs the whole pipeline against
it: `gatefail`, `lintfix` (lint fix runs on the fix tier, no escalation),
`reviewfail`, `reviewstuck` (asserts no build after the last
review round), `escalate`, `blocked` (then `fleet retry` and resume), `default`
(fast planner), `questions`. `test/unit.js` covers what the scenarios can't
observe: the escalation policy table, gates not blocking the event loop, timeout process-tree kills, and
cost accounting for calls that never report a cost. `npm test` runs all of it. Point `claude_bin` in
`.fleet/config.json` at the fake to reproduce.
