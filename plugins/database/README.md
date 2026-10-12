# Database

A worktree's own development database, as a tab on the worktree: browse its
tables, edit rows and run SQL, read-only until unlocked. Not built in: it is
in the listing (Settings → Plugins → Browse), and off until you allow it.
The guide is [docs/guides/database.mdx](../../docs/guides/database.mdx).

- **Database**: a worktree panel. Tables by schema with row estimates; a
  table as a grid (sort, filters, paging, NULL told from the empty string,
  long values in a sheet, foreign keys that jump) or as its structure;
  edits that are staged, reviewed as old → new and applied as one; a lock
  on writes that lasts 15 minutes; and a SQL console with a history.
- **Database**: a screen with every box and what it has of the helper, the
  switch for each, and which databases show up.

It is its own plugin with its own helper. It doesn't need Leadline, and
imports nothing from it.

## The helper

The data comes from `berth-database`, a program the plugin's manifest
carries under `box.helper`. The laptop agent installs it on a box when the
person turns Database on there, and the box runs it; the plugin reads its
API through the box with `berth.helper.request`, so a real box sees
`helpers/database/api/api/db/…`. `src/api.ts` types the six routes:

| Route (from the helper's `/api/`) | What it is |
| --- | --- |
| `GET db/connections?source=S` | The worktree's databases, each with its engine's `capabilities` |
| `GET db/{conn}/schema` | Schemas, tables, columns, keys, indexes |
| `POST db/{conn}/rows` | A page of a table, ordered and filtered |
| `POST db/{conn}/query` | One statement |
| `POST db/{conn}/edit` | Staged changes, all or nothing |
| `POST db/{conn}/writes` | The lock |

A worktree's `source` is `<project>/<worktree>`, or the project alone for
its main checkout: the same rule as Leadline's helper, copied into
`src/source.ts` and tested on its own.

## Engines

Postgres is the only engine for now, and nothing outside `src/engines/`
names it. Most of what differs between engines arrives with a connection,
as its `capabilities`, and the panel is built from that:

| Capability | What it decides |
| --- | --- |
| `dialect` | The console's highlighting and completion |
| `schemas` | Whether the list of tables has a schema level |
| `operators` | The comparisons a filter offers |
| `kinds` | The kinds of relation there are |
| `writes` | Whether the lock and the edit controls show at all |
| `transactions` | What Review says about applying |

What the helper can't say is in `src/engines/`: an engine's name and icon,
how its type names fall into families (`families.ts` decides how each
family is shown and typed in), how it quotes a name, and how it explains a
statement. To add one, write `src/engines/<id>.ts` after `postgres.ts`, add
it to `ENGINES` in `src/engines/index.ts`, and add its cases to
`app/src/lib/database.test.ts`.

An engine with no entry still shows: every value as the text the helper
sent, nothing editable in the grid, and a console that runs what you type.
Mock mode has one ("driftdb", on shop / checkout-fix's second connection)
to keep that true.

## Where things are

| File | What is in it |
| --- | --- |
| `src/panel.tsx` | The panel: the helper's state, the connections, the lock, and the states with nothing to show |
| `src/browser.tsx` | The table list, a table's rows and structure, staging and Review |
| `src/grid.tsx` | The grid, shared with the console. Only the rows near the view are in the page |
| `src/console.tsx` | The console, on the app's `SqlEditor` |
| `src/staged.ts`, `src/filters.ts`, `src/statements.ts`, `src/rules.ts` | The rules, with no React in them: staged changes, filters and order, which statement Run means, what may be edited |

## Working on it

```sh
pnpm -C app typecheck:plugins
pnpm -C app build:marketplace     # site/plugins/database/, which is committed
pnpm -C app test                  # src/lib/database.test.ts
cd app && pnpm build && E2E_PORT=1427 npx playwright test e2e/database.spec.ts
```

Mock mode (`?mock=1`) runs the listing's own bundle, installed and allowed,
so rebuild the listing to see a change there. Its helper is
`app/src/lib/mock-database.ts`: a made-up "acme" shop kept in memory, with
filters, paging, edits, conflicts, the lock and a console that runs a small
set of statements. `?db=none`, `?db=refused` and `?db=old` are the states
with nothing to show.

Raise `version` in `berth-plugin.json` when the code changes. The
manifest's `assets` are empty here: the listing's build fills in each
platform's download and checksum.
