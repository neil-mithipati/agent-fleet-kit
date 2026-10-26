# agent-fleet-kit (AFK)

Describe a feature in one sentence. A fleet of Claude agents plans it, builds
it in parallel, tests it, reviews it, merges it and writes the changelog,
while you're away from the keyboard.

- **Trust comes from the runner, not the agent.** Plain code runs the loop and
  the tests, so "done" means the gates actually passed.
- **The right model for each task.** Haiku for small fixes, Sonnet for
  features, Opus only for large or stuck work.
- **Bounded by design.** Every retry, dollar and minute has a cap. No endless
  loops; anything stuck comes back to you with the reason.

## How it works

solid: main path · dashed: escalation or a question for you · red gates or
blocking review findings go back to the **same** builder (≤3 attempts); a
stronger tier only on the last one; lint/typecheck fixes go to haiku.

```mermaid
%%{init: {"flowchart": {"wrappingWidth": 420, "nodeSpacing": 40, "rankSpacing": 55, "curve": "linear"}}}%%
flowchart TD
  human("<b>you</b><br/>fleet do #quot;add streaks#quot;")
  planner("<b>planner</b><br/>sonnet · med · 25 turns<br/>request → task graph")
  plannerDeep("<b>planner-deep</b><br/>opus · high · 50 turns<br/>new apps + big requests")
  runner("<b>runner</b><br/>plain code · no LLM · owns every loop<br/>≤3 attempts · $ and time caps")

  light("<b>builder-light</b><br/>haiku · low · 25 turns<br/>small: copy, config, fixes")
  builder("<b>builder</b><br/>sonnet · med · 60 turns<br/>medium: regular features")
  deep("<b>builder-deep</b><br/>opus · high · 120 turns<br/>large: scaffold, data, auth")

  gates("<b>gates</b> · typecheck · lint · test<br/>run by the runner, not the agent")

  noreview("<b>no review</b><br/>diff-checked: ≤5 files · no data/auth")
  reviewer("<b>reviewer</b><br/>sonnet · med · 30 turns<br/>correctness")
  reviewerDeep("<b>reviewer-deep</b><br/>opus · high · 50 turns<br/>correctness + adversarial")

  merge("<b>merge + push</b><br/>one at a time · synced with main")
  publisher("<b>publisher</b><br/>sonnet · med · 20 turns<br/>merged work → release notes")
  changelog("<b>CHANGELOG.md</b><br/>what shipped · what needs you")

  human --> planner
  planner -. escalate .-> plannerDeep
  planner --> runner
  plannerDeep -.-> runner
  runner -. needs you .-> human
  runner --> light & builder & deep
  light & builder & deep --> gates
  gates --> noreview & reviewer & reviewerDeep
  noreview & reviewer & reviewerDeep --> merge
  merge --> publisher --> changelog

  classDef human fill:#f0eee8,stroke:#8a8a85,color:#3a3a38
  classDef core fill:#eeeefc,stroke:#5b55c4,color:#3f3a9a
  classDef build fill:#e3f4ee,stroke:#2c7a5a,color:#0e4d36
  classDef gate fill:#ffffff,stroke:#9a9a95,color:#4a4a48,stroke-dasharray:6 4
  classDef skip fill:#f8ecd9,stroke:#a5762a,color:#6b4310
  classDef review fill:#f8ebe6,stroke:#b5553a,color:#7a2e18
  classDef ship fill:#e9f2df,stroke:#5d8a32,color:#2d5212
  classDef pub fill:#fbe8ef,stroke:#b23a68,color:#7a1f43
  class human,changelog human
  class runner,planner,plannerDeep core
  class light,builder,deep build
  class gates gate
  class noreview skip
  class reviewer,reviewerDeep review
  class merge ship
  class publisher pub
  linkStyle default stroke:#8a8a85,stroke-width:1.5px
```

Every agent is a single `claude -p` call that returns JSON; the runner decides
what happens next. Agents never push, rewrite history or read secrets.
Details: [ARCHITECTURE.md](ARCHITECTURE.md).

## Install and use

Requires Node 18+, git and the [Claude Code](https://claude.com/claude-code) CLI, signed in.

```bash
git clone https://github.com/neil-mithipati/agent-fleet-kit.git ~/agent-fleet-kit
cd ~/agent-fleet-kit && npm link        # puts `fleet` on your PATH, no dependencies
```

**New app**

```bash
fleet init ~/code/habit-tracker && cd ~/code/habit-tracker
fleet do "Build a habit tracker: add habits, check them off daily, show streaks"
```

**Existing repo** (adds `.fleet/` and `CHANGELOG.md`, touches nothing else)

```bash
cd ~/code/my-app && fleet init
fleet do "Streaks should survive a missed weekend day"
```

Watch it live at http://127.0.0.1:4777. Read what shipped in `CHANGELOG.md`.

| command | what it does |
|---|---|
| `fleet do "<request>"` | Plan, build, test, review, merge, push |
| `fleet do` | Resume after a stop, crash or retry |
| `fleet status [id]` | What's running, what shipped, what needs you |
| `fleet retry <id> "answer"` | Unblock a task, then `fleet do` |
| `fleet stop` | Pause; in-flight work resumes later |

New apps default to **TypeScript, React + Vite, Supabase (+ Auth), Tailwind,
Vitest and ESLint, deployed on Vercel**, unless your request names another
stack. Change the default, models, limits, parallelism and auto-push in
`.fleet/config.json`.
