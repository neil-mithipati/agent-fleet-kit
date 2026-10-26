# agent-fleet-kit (AFK)

One sentence in; a tested, merged and deployed feature out. AFK plans the work,
builds it with parallel Claude agents, tests and reviews it, then merges,
deploys and writes the changelog while you're away from the keyboard.

- **Code runs the loop, not a model.** The runner runs the tests itself, so "done" means green.
- **Cheapest model that works.** Haiku, Sonnet or Opus by task size; retries stay on the same model.
- **Bounded.** Attempts, dollars and minutes are capped; stuck work comes back to you with the reason.

## How it works

Dashed: escalation or a question for you. Red gates or blocking findings send
the task back to the same builder (≤3 attempts); a stronger model joins only
on the last one.

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
  vercel("<b>Vercel</b><br/>deploys every push")
  supabase("<b>Supabase</b><br/>new migrations applied")
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
  merge --> vercel & publisher & supabase
  publisher --> changelog

  classDef human fill:#f0eee8,stroke:#8a8a85,color:#3a3a38
  classDef core fill:#eeeefc,stroke:#5b55c4,color:#3f3a9a
  classDef build fill:#e3f4ee,stroke:#2c7a5a,color:#0e4d36
  classDef gate fill:#ffffff,stroke:#9a9a95,color:#4a4a48,stroke-dasharray:6 4
  classDef skip fill:#f8ecd9,stroke:#a5762a,color:#6b4310
  classDef review fill:#f8ebe6,stroke:#b5553a,color:#7a2e18
  classDef ship fill:#e9f2df,stroke:#5d8a32,color:#2d5212
  classDef pub fill:#fbe8ef,stroke:#b23a68,color:#7a1f43
  class human,changelog,vercel,supabase human
  class runner,planner,plannerDeep core
  class light,builder,deep build
  class gates gate
  class noreview skip
  class reviewer,reviewerDeep review
  class merge ship
  class publisher pub
  linkStyle default stroke:#8a8a85,stroke-width:1.5px
```

## Install

Needs Node 18+, git and [Claude Code](https://claude.com/claude-code), signed in.

```bash
git clone https://github.com/neil-mithipati/agent-fleet-kit.git ~/agent-fleet-kit
cd ~/agent-fleet-kit && npm link
```

**Database + deploys (optional, once per machine).** `fleet connect` uses your
own Supabase and Vercel logins:

```bash
brew install supabase/tap/supabase && supabase login
npm i -g vercel && vercel login
```

Then run `fleet connect` once per app. It:

- creates and links a Supabase project (`--region`, default `us-east-1`; `--org <id>` if you have several orgs)
- links a Vercel project to the app's GitHub repo, so every push deploys
- writes the Supabase URL, public key and database password to `.env.local` (gitignored, never readable by agents) and sets the public ones on Vercel

From then on, merged migrations are applied to Supabase automatically
(`"db_push": "manual"` in `.fleet/config.json` turns that off).

## Use

**New app**

```bash
fleet init ~/code/habits && cd ~/code/habits
git remote add origin <empty GitHub repo url>   # auto-push + deploys
fleet connect                                   # creates Supabase + Vercel projects, writes .env.local
fleet do "Build a habit tracker: daily check-offs and streaks"
```

**Existing repo:** `cd my-app && fleet init && fleet do "..."` (adds `.fleet/` and `CHANGELOG.md` only).

New apps default to TypeScript, React + Vite, Supabase (+ Auth), Tailwind,
Vitest and ESLint on Vercel, unless your request names a stack.

| command | |
|---|---|
| `fleet do "<request>"` | plan, build, test, review, merge, deploy |
| `fleet do` | resume after a stop, crash or retry |
| `fleet status [id]` | what's running, shipped, or needs you |
| `fleet retry <id> "answer"` | unblock a task, then `fleet do` |
| `fleet connect` | link Supabase + Vercel (once per app) |
| `fleet stop` | pause; work resumes later |

Live view: http://127.0.0.1:4777. Settings: `.fleet/config.json`.
Design: [ARCHITECTURE.md](ARCHITECTURE.md).
