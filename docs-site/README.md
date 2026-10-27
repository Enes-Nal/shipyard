# Terminal docs site

The documentation at [docs.berthd.app](https://docs.berthd.app), built with
[Fumadocs](https://fumadocs.dev) on Next.js.

## Where the content lives

Not here. The pages are the repository's own [`docs/`](../docs) folder, next
to the code they describe, so a change to Terminal and its docs land in one
commit:

```text
docs/
  index.mdx              the home page (/)
  meta.json              sidebar order and section labels
  getting-started/       install, add a box, first project, first agent
  concepts/              how Terminal works, boxes, projects, sessions, security
  guides/                orchestration, automations, hooks, kits, plugins, …
  reference/             CLI, berthd, config, events, app API, plugin SDK
```

- Each page is MDX with `title` and `description` frontmatter. The file's
  path is its URL: `docs/guides/kits.mdx` is `/guides/kits`.
- Each folder's `meta.json` orders its pages; the root one lists the sections.
- Link between pages by URL (`/guides/hooks#gates`).
- Components available in pages without importing: `Callout`
  (`type="warn"` for the amber one), `Cards`/`Card`, `Steps`/`Step`,
  `Tabs`/`Tab`, `Scene` (a harbour drawing; use sparingly) and `Stage`
  (the home page's panel: a title, its content, and a scene beside it),
  and `Shot` (a screenshot of the app; see below).
  `Card` takes an `icon`; `BookOpen`, `Compass`, `FileCode` and `Terminal`
  are available for it. `<Cards className="berth-path">` numbers its cards,
  for a sequence of steps.
- A page's section (its folder's `meta.json` title) shows above its title.
- Braces and angle brackets in prose are MDX: put `{{variables}}` and
  `<placeholders>` in backticks.

## Run it

```sh
pnpm install
pnpm dev       # http://localhost:3333, reloads as you edit docs/
pnpm build     # what CI and Vercel run
pnpm start     # serve the build on :3333
```

Node 22 and pnpm 11. `pnpm build` fails on a page with broken MDX or
frontmatter, so CI (the `docs-site` job in `.github/workflows/ci.yml`)
catches those.

## Screenshots

`<Shot name="themes" alt="…" />` shows a screenshot of the app, the light or
the dark one by the docs' theme, at most as wide as it was taken (a click
opens it full size). `caption` adds a line under it. Write `alt` as what the
picture shows, for someone who can't see it.

The pictures are `public/shots/<name>-light.webp` and `<name>-dark.webp`, and
`lib/shots.json` has each one's size in CSS pixels, which `Shot` gives the
image so the page doesn't move when it loads. Both come from
`scripts/docs-shots/capture.mjs`, which stages each scene in the app's mock
mode (made-up boxes and agents) by clicking through the real UI:

```sh
pnpm -C app install                                              # once
npm install --prefix scripts/docs-shots --no-save playwright-core # once, or set PLAYWRIGHT_CORE
node scripts/docs-shots/capture.mjs                    # every scene, light and dark
node scripts/docs-shots/capture.mjs --only tab-groups  # one scene
node scripts/docs-shots/capture.mjs --list             # the scenes and the page each is on
```

Run it from the repository's root when the UI a page shows changes, and look
at the pictures before committing. A scene is a few lines in the script: what
to click, and the area to keep. The script's header lists its options.

## How it's put together

| File | What it does |
| --- | --- |
| `lib/source.ts` | Reads `../docs` with `fumadocs-mdx`, at the site's root URL |
| `next.config.mjs` | Sets the build's root to the repository, so `../docs` and the fonts in `../site/assets/fonts` are inside it |
| `app/(docs)/` | The docs layout and the page route |
| `app/not-found.tsx` | The 404 page |
| `app/api/search/route.ts` | Built-in search (Orama) |
| `app/global.css` | The brand: colours, type, callouts, code, tables |
| `lib/code-themes.ts` | The quiet code themes, light and dark |
| `components/art/` | The harbour scenes, copied from `app/src/components/art/` |
| `components/search.tsx` | The search dialog: labelled suggestions, results with their section, at most two passages a page, an empty state |
| `components/callout.tsx` | Callouts without coloured side stripes |
| `components/stage.tsx` | The home page's stage panel |
| `components/shot.tsx`, `lib/shots.json`, `public/shots/` | Screenshots of the app, light and dark (see above) |
| `lib/sections.ts` | A page's section name, for the label above its title |
| `lib/rehype-nowrap-tokens.ts` | Keeps inline code from breaking after a flag's hyphens |
| `lib/rehype-reference.ts` | Makes reference tables linkable: "Command" tables become a list with an id per command (`#berth-task-new`); "Field", "Event" and "Gate" rows get ids (`#setup`) |
| `components/site-header.tsx` | The product header (lockup, berthd.app, GitHub) above the docs on wider screens, and the labelled links in the phone's header and menu |

The look follows the landing page (`site/`) and the brand board
(`design/brand/`): Inter and JetBrains Mono (ligatures off), cool neutrals,
amber only for the logo's dot, the one lamp in a drawing, or a warning;
sentence-case labels; no coloured stripes down the side of anything. The
theme follows the system, light or dark.

When the app's scenes change, copy `app/src/components/art/scenes.tsx` and
`scenes.css` here again, keeping this copy's imports.

## Deploying

Vercel, with the project's root directory set to `docs-site` (and files
outside it included in the build, which is Vercel's default). The site's URL
is set in `lib/shared.ts`.
