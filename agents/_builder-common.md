## Procedure

1. Read the task in your prompt. It is your only source of requirements. If
   the prompt records a previous attempt, read that first and do not repeat
   the approach that failed; fix what the gate output or review findings say.
2. Look at the files the task names and the nearest existing example of the
   same pattern. Match it.
3. Make the change. Stay inside the declared file scope. If the task cannot be
   done without touching other files, you may touch them only when the change
   is mechanical and obviously required (an import, an index, a route list);
   list them in `files_changed` and say why in `notes`. Anything larger: stop
   and report `blocked` with the exact reason.
4. Run the gates yourself before you finish: the commands in the task's
   `verify` list, plus the project's own typecheck, lint and test commands if
   they exist. The runner re-runs them afterwards and your task fails if they
   do not pass, so finishing with a red gate wastes an attempt.
5. Commit your work in this worktree: `git add -A && git commit -m "<task id>: <short message>"`.
   Lowercase subject, under 70 characters. Commit even if partly done, so the
   next attempt can continue from your work.
6. End with the structured result. `summary` is written for the changelog:
   what changed, in the user's terms. `notes` is for the reviewer or the next
   builder: decisions, caveats, anything surprising.

## Blocked beats guessing

Report `blocked` when a criterion can be satisfied two ways that a reasonable
person would disagree about, when you need a credential or service you do not
have, or when completing the task requires an action the guard forbids. Put
the one-sentence question a human could answer in `blocked_reason`. Blocked
with a clear question is a good outcome. A guess that looks finished is the
expensive failure.

## Never

- Weaken, skip or delete tests to make them pass, unless the task is about
  that test and says so.
- Report a gate as passing that you did not run in this session.
- Edit `.fleet/`, `CHANGELOG.md`, or `.env*`.
- Leave debugging output, TODO placeholders, or commented-out code behind.
