# Prompt library

Saved prompts for coding agents, with `{{variables}}`.

- **Library** (sidebar → More → Prompts): search, filter by tag, and edit a
  prompt in a sheet with a live preview of what an agent will get. Prompts
  can be offered everywhere or only in one project.
- **Send one**: ⌘K → "Send a saved prompt…", a session's ⋯ menu ("Send a
  saved prompt…"), or "Saved prompts…" in the Send prompt dialog. Pick, fill
  in its variables, send.
- **Send to several**: from the Agent Dashboard (Select, or ⌘-click cards →
  "Send to N agents…"), the Worktrees view (select rows → "Prompt agents…"),
  ⌘K, or a prompt's "Send to several…". Each agent gets the prompt filled in
  for it, one after another; optionally Terminal waits for each turn to end and
  shows the last thing each agent said.

## Variables

Built-ins fill in from the session a prompt goes to:

| Variable | Is |
| --- | --- |
| `{{worktree.name}}`, `{{worktree.path}}` | The worktree |
| `{{branch}}` | Its branch |
| `{{base}}` | The branch new worktrees start from (the repo's default, else `main`) |
| `{{project}}` | owner/name, or the project's name |
| `{{location}}`, `{{box}}`, `{{agent}}` | Where it runs, and which agent |

Anything else (`{{check}}`, `{{package}}`) is asked for when sending, with
the label and default set in the editor.

## Where it lives

One JSON document on the laptop, `GET`/`PUT /v1/app/prompts`
(`~/.berth/app/prompts.json`): `{ "version": 1, "prompts": [...] }`. Until
it exists the app offers eight starter prompts. Other plugins reach the same
library, picker and broadcast through `berth.prompts`.
