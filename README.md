# agent-fleet-kit

A fleet of Claude agents that builds an app with minimal human oversight.
Describe what you want; the fleet plans it, builds it in parallel worktrees,
runs the tests, reviews what needs reviewing, merges, and writes a changelog
you can read at your own pace.

Drop it into any existing repo, or point it at an empty directory to start a
new one.

```bash
fleet init ~/code/my-app
cd ~/code/my-app
fleet do "Build a habit tracker: add habits, check them off daily, show streaks"
fleet do "Streaks should survive a missed weekend day"
```

Watch it work at `http://127.0.0.1:4777` (mission control). Read what shipped
in `CHANGELOG.md`.

## Install

Requirements: Node 18+, git, and the Claude Code CLI (`claude`) signed in.

```bash
git clone https://github.com/neil-mithipati/agent-fleet-kit.git ~/agent-fleet-kit
cd ~/agent-fleet-kit && npm link          # puts `fleet` on your PATH; or symlink bin/fleet yourself
fleet help
```

No npm install. The kit has no dependencies.

## Commands

| command | what it does |
|---|---|
| `fleet init [path]` | Make a repo fleet-ready. Empty directory → creates a git repo with a first commit. Existing repo → adds `.fleet/` and `CHANGELOG.md`, touches nothing else. |
| `fleet do "<request>"` | The main command. Plans the request into tasks, builds them in parallel worktrees, runs the gates, reviews medium and large tasks, merges into your branch, and writes a changelog release when a large task shipped. Returns when everything is merged or needs you. |
| `fleet do` | Resume. Continues unfinished tasks after a stop, a crash, or a `fleet retry`. |
| `fleet do --plan-only "<request>"` | Plan and queue tasks without building. Review them with `fleet status`, then `fleet do` to run. |
| `fleet status [id] [--all]` | One screen: mission, tasks, who is working, what needs a human. With a task id, everything recorded about that task. |
| `fleet dashboard` | Mission control in the browser. `fleet do` starts it in the background automatically. |
| `fleet release` | Write the next `CHANGELOG.md` section from all merged, unreleased tasks and tag it. Runs automatically after a mission that shipped a large task. |
| `fleet retry <id> ["note"]` | Re-queue a task that needs a human, with your answer or instruction. The note is also saved to `.fleet/HUMAN_NOTES.md` so future plans see it. Then `fleet do`. |
| `fleet stop [--abandon]` | Stop the running mission. In-flight tasks keep their worktrees and resume with `fleet do`. `--abandon` cancels queued tasks instead. |

Flags for `fleet do`: `--parallel N` (override `max_parallel`), `--release`
(release at the end regardless of size), `--no-release` (never release
automatically).

## What happens when you run `fleet do`

1. **Plan.** A fast planner (sonnet) reads the request and a glance at the
   repo. Small requests become one or two tasks in under a minute. Big ones
   escalate to a deep planner (opus) that surveys the repo and designs. Each
   task gets a size, a file scope, acceptance criteria and dependencies. The
   plan is validated as data before anything runs. Assumptions are printed.
2. **Build.** Each task gets its own git worktree and branch. Up to
   `max_parallel` builders run at once; tasks that share files are serialized
   automatically. Small → haiku, medium → sonnet, large → opus.
3. **Gates.** The runner, not the agent, runs your typecheck, lint and test
   commands in the worktree. Red gates send the task back with the output,
   on the same model. Lint and typecheck fixes go to haiku. A stronger model
   is only brought in for the final attempt.
4. **Review.** Small tasks ship on green gates alone, if their diff really was
   small (≤5 files, ≤200 lines, no sensitive paths); otherwise they are
   promoted and reviewed. Medium tasks get a correctness review. Large tasks
   get a correctness pass plus an adversarial pass. Only `high` findings
   block; the rest go in the changelog for you.
5. **Merge and push.** Passing branches merge into your current branch one
   at a time, then their worktrees are removed. Conflicts get one builder
   attempt, then wait for you. After each merge the runner pushes the branch
   to `origin` (if the repo has one). If someone else pushed in the meantime,
   their commits are merged in first; a conflict there is reported, never
   forced.
6. **Release.** When a large task shipped (or on `fleet release`), the
   publisher writes a `CHANGELOG.md` section: what was added, changed and
   fixed in user terms, what needs your attention, the assumptions the
   planner made, and a collapsed table of tasks with cost. The release is
   committed, tagged, and pushed with its tag.

Every loop has a hard bound. A task that fails three attempts, fails review
twice, blocks on an ambiguity, or runs the mission past its time or dollar
budget stops as `needs_human` with a one-line reason. The rest of the mission
continues. See [ARCHITECTURE.md](ARCHITECTURE.md) for the full list.

## What a run looks like

Measured on the first real runs of this kit (opus for planning and large
work, sonnet for medium, haiku for small):

| request | plan | tasks | wall clock | cost |
|---|---|---|---|---|
| New repo: "Build a small command-line todo app in Node.js… with tests, README, lint" | deep planner, 80s, 9 assumptions | 1 large, 1 medium, 1 small | 4.3 min | $0.84 |
| Same repo, next day: "Add a --json flag to the list command, with a test and README mention" | fast planner, 10s | 1 small | 27 s | $0.01 |

The first produced a working CLI with 27 passing tests and a changelog whose
"Needs your attention" section listed three low-severity review findings and
the assumptions worth confirming. The second shipped on green gates with no
review, as designed for small work.

## Oversight knobs

You have four places to steer without babysitting:

- **The request.** Be specific about product decisions; the planner makes
  engineering decisions itself and records them as assumptions.
- **`.fleet/HUMAN_NOTES.md`.** Standing instructions every planner reads:
  conventions, things never to touch, how to run the app, decisions made.
- **`fleet retry <id> "note"`.** Answer a stuck task's question.
- **`CHANGELOG.md`.** Read it after each release. Correct anything wrong with
  a new `fleet do`.

For stricter control: `fleet do --plan-only` lets you read the plan before any
builder starts, and `fleet status <id>` shows a task's full record including
every attempt and review finding.

## Configuration

`.fleet/config.json` is written by `fleet init` with every knob at its default.
The ones that matter most:

```jsonc
{
  "max_parallel": 3,                       // builders at once
  "models": { "builder": "sonnet", "builder-deep": "opus", ... },
  "limits": { "builder": { "max_turns": 60, "timeout_min": 25, "budget_usd": 4 }, ... },
  "small": { "max_files": 5, "max_lines": 200, "sensitive": ["**/migrations/**", ...] },
  "retries": { "max_attempts": 3, "max_review_rounds": 2 },
  "escalation": "last_resort",             // or "eager": escalate on most failures
  "fix_tier": "builder-light",             // who fixes lint/typecheck failures; null = task's own tier
  "mission": { "budget_usd": 30, "timeout_min": 240 },
  "gates": { "lint": null },               // override or disable a detected gate
  "release": { "auto": "large" },          // "large" | "always" | "never"
  "push": { "auto": true, "remote": "origin" },   // runner pushes after each merge and release; false = you push
  "dashboard": { "port": 4777, "auto_start": true }
}
```

Gates are detected from your repo: `package.json` scripts (`typecheck`,
`lint`, `test`), `tsconfig.json`, `pyproject.toml` (ruff, pytest), `go.mod`,
`Cargo.toml`. Set a key to a command to override, or to `null` to skip.

To change what an agent is told, copy a card from the kit's `agents/` into
`.fleet/agents/` with the same filename. The repo copy wins.

## Files the fleet adds to your repo

```
.fleet/config.json      knobs (commit it)
.fleet/settings.json    guard rails passed to every agent run (commit it)
.fleet/HUMAN_NOTES.md   your standing instructions (commit it)
.fleet/agents/          optional prompt overrides
.fleet/state/           runtime state and agent logs (gitignored)
CHANGELOG.md            what shipped, written at each release
```

Worktrees are created beside the repo in `../.fleet-worktrees/<name>/` and
removed after merge.

## Safety

Agents cannot push, force-push, reset, rewrite history, publish packages,
deploy, run `sudo`, read `.env*` or key files, or edit `.fleet/`,
`CHANGELOG.md` or `.git/`. This is enforced by a permission deny list and a
hook on every tool call, not by the prompt. Planners, reviewers and the
publisher have no edit tools at all.

Pushing is done by the runner, not by any agent, and only ever as a plain
`git push` of your base branch and release tags: no force, no rebase. Set
`push.auto` to `false` to keep every push manual.

## Testing the kit itself

```bash
npm test                  # unit checks + every e2e scenario
test/e2e.sh gatefail      # one scenario; also: lintfix, reviewfail, reviewstuck, escalate, blocked, default, questions
```

These run the whole pipeline against a scripted stand-in for `claude -p`,
with no API calls. Each prints the resulting git graph, tags and changelog.

## Lineage

This is a from-scratch rebuild of an earlier kit. It keeps that kit's agent
graph (planner, three builder tiers, two reviewer tiers, publisher) and
replaces its orchestrator-in-a-chat-loop with a deterministic runner. See
[ARCHITECTURE.md](ARCHITECTURE.md).
