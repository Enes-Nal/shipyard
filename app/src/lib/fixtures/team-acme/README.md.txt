# Acme team setup for Shipkit (example)

An example of a [team setup](../../../docs/guides/team-setup.mdx) for Acme,
a made-up org. Its one repository, `acme/shop`, is a Node app with
Postgres and Redis, a database migration and a seed: the shape most web
teams have. Copy the folder and change the names to make your own.

It sets a new engineer's box up the way the team's boxes are, in one go:
the box's system software, Docker with Postgres and Redis, Node and Yarn,
then `acme/shop` cloned, migrated and seeded, with the shop's kit giving
every worktree its own database, `.env` and ports.

Shipkit reads an org's team setup from `<org>/.berth/team.json`, so an org
publishes one like this by copying the folder's contents to the root of its
`.berth` repository. Every script here also runs by hand.

```text
team.json                       the team setup (schema berth.team/v1)
box/setup.sh                    the box steps, one subcommand each; run by you, in a terminal on the box
box/init-shop.sh                the main shop checkout's one-time setup
```

## What it sets up

**On the box, once** (`box/setup.sh`). Steps marked sudo ask for your password.

| Step | | |
| --- | --- | --- |
| `update` | sudo | `apt-get update` and `apt-get upgrade`; counts as done for 24 hours |
| `packages` | sudo | git, curl, jq, unzip, build tools, python3, openssl, and `psql`/`pg_dump` of the Postgres version, from the PostgreSQL apt repository (the kit's worktree copies need a `pg_dump` at least as new as the server) |
| `docker` | sudo | Docker Engine from Docker's apt repository, started at boot, and you in the `docker` group |
| `cli` | sudo | `gh` and the 1Password CLI `op`, from their own apt repositories |
| `node` | | fnm in `~/.local/share/fnm`, and the Node version the shop names, on the PATH of login shells |
| `yarn` | | `corepack enable`; the shop's `packageManager` picks the Yarn version |
| `postgres` | | `shop-postgres`, Postgres 18, on `127.0.0.1:5433`, database `shop`, data in the `shop-postgres-data` volume |
| `redis` | | `shop-redis`, Redis 8, on `127.0.0.1:6379`, data in the `shop-redis-data` volume |

**Versions** live in one place, `box.settings` in `team.json`
(`SHOP_POSTGRES_VERSION`, `SHOP_REDIS_VERSION`), so a bump is a one-line
change. Shipkit passes them to `box/setup.sh` as `BERTH_SETTING_SHOP_POSTGRES_VERSION`
and `BERTH_SETTING_SHOP_REDIS_VERSION`; run by hand, it reads them from
`team.json`, and the environment can override them. After a bump, Redis
moves to the new image with its data; Postgres does not, since a new major
cannot read the old one's data: the step says so and how to move it, and
leaves the old container running.

Both containers restart unless you stop them, so they come back after a
reboot, and listen on localhost only. Postgres takes the user `postgres`
with no password, as the shop's `.env.example` expects.

Then Shipkit's own steps. **Claude Code and Codex on the box**, from
`"agents"` in `team.json`: `berthd agents install --integrations claude
codex`, into `~/.local/bin` without sudo (Claude Code with its native
installer, Codex from its pinned release, sha256 checked), then their hooks
and skills; each asks you to sign in the first time it starts. **GitHub on
the box**: `gh auth login` on the box, with a device code you enter on your
laptop. The box clones with a credential of its own, which you can revoke
on its own; your laptop's token never goes to the box. **1Password on the
box**, since the shared keys are `op://` references: op signs in, in the
box's terminal, so Shipkit can read those keys when a worktree needs them,
without ever asking in a service's terminal.

**The docker group.** The `docker` step adds you to the `docker` group. A
process only gets a new group at a new login, so Shipkit starts what comes
after it (the remaining steps, `init-shop.sh`, terminals, services) with
the group, through `sg`; nothing needs restarting.

**The node version** is read when the step runs, not written here: the
shop's `.nvmrc` or `.node-version`, else `engines.node` in its
`package.json`, else 22. `box/setup.sh node-version` prints which, and from
where. `init-shop.sh` reads it again from the checkout itself.

**The repo.** `acme/shop` is cloned to `~/code/shop`, then:

1. Its setup comes from its own committed `.berth/config.json` when it has
   one; otherwise from the shop kit (`acme/berth-kit-shop`), pinned to a
   commit in `team.json`; then whatever you add in Project settings on your
   box.
2. `box/init-shop.sh` runs once in the main checkout, which the kit leaves
   alone (it sets up worktrees): Node through fnm; `.env` from
   `.env.example` with `DATABASE_URL` at the Docker Postgres and
   `REDIS_URL` at the Docker Redis, and a `SESSION_SECRET` made on the box;
   `yarn install`; `yarn db:migrate`; and `yarn db:seed`. A value you
   changed in `.env` is kept.
3. Every worktree after that is the kit's: a copy of this database, its own
   `.env`, ports and URL.

## Using it

### With Shipkit

Where Shipkit asks for an org (**Add a box → Set this box up for a team**),
type `acme`, or open `berth://team?org=acme`. Before it is published in
`acme/.berth`, paste a link to the folder on a branch instead, such as
`github.com/<you>/<repo>/tree/<branch>/<folder>`; `berth team show <link>`
and `berth team setup <link> <box>` take the same.

The page lists every step and command before anything runs. Steps run in a
terminal on the box that you can see; type your password there when sudo
asks.

### By hand

On the box, as yourself (not root), with this folder at `~/acme-berth`:

```sh
~/acme-berth/box/setup.sh plan        # what it will do
~/acme-berth/box/setup.sh all         # every step, then gh auth login
gh repo clone acme/shop ~/code/shop
cd ~/code/shop && ~/acme-berth/box/init-shop.sh
```

Other subcommands:

```sh
box/setup.sh check postgres    # exit 0 when that step has nothing left to do
box/setup.sh docker            # one step
box/setup.sh github            # just the GitHub sign-in
box/setup.sh node-version      # the Node version the shop asks for, and where that came from
```

Settings, all optional: `SHOP_PG_PORT` (5433), `SHOP_REDIS_PORT` (6379),
`SHOP_REPO` (`acme/shop`), `SHOP_DIR` (`~/code/shop`), `SHOP_NODE`
(a Node version, over what the shop names), `SHOP_SKIP_GITHUB=1`,
`SHOP_UPDATE_EVERY_HOURS` (24), and for `init-shop.sh`, `SHOP_SKIP_SEED=1`.

## Safe to run again

Every step checks first and skips what is done, so running it again changes
nothing. Running `all` twice, or Shipkit's **Retry from**, starts where it got
to.

## Your password and your keys

- **sudo.** The four sudo steps call `sudo` themselves, in the terminal in
  front of you. The first asks for your password once, with a plain message
  saying why; sudo remembers it in that terminal for a few minutes, so the
  others don't ask again. Nothing stores it, Shipkit never sees it, and the
  scripts refuse to run as root.
- **No secrets in git.** `team.json` lists keys, never values:
  - *shared* keys (Stripe test keys, a maps API key) are 1Password
    references, `op://vault/item/field`, read on the box with your own
    1Password when a worktree needs them;
  - *asked* keys (`MAIL_API_KEY`) are yours alone: Shipkit asks once and
    keeps them on your box, in the project's own config.
- **Env stays light.** Shipkit sets ports, URLs and databases; every other
  value stays as the shop's `.env.example` has it.

## Updates

When this changes in `acme/.berth`, Shipkit shows **Acme's setup changed ·
Review update** with what changed. It never runs by itself; reviewing and
pressing **Update** runs it, and steps whose checks pass are skipped.

## Supported systems

- **Ubuntu 22.04 and 24.04, Debian 12**: supported.
- **macOS 14+**: best effort. Homebrew installs the packages, gh, op and fnm;
  Docker is whatever already answers (OrbStack, Docker Desktop), else
  OrbStack if installed, else Colima. `update` runs `brew update` only.

## Placeholders

Acme is made up, and so is everything named after it:

- **Repositories.** `acme/shop` and its kit, `acme/berth-kit-shop`, are
  placeholders for your own.
- **The project's id** is `shop`: it names the project on the box and is
  part of every worktree's URL (`<worktree>.shop.<box>.localhost`), so
  Shipkit refuses an id with a dot (for a repo named like `acme.com`, use
  another id and keep the folder with `path`).
- **1Password names.** The vault (`dev`) and item names in `keys` are
  placeholders, as is the `contact` channel.
- **Scripts.** `yarn db:migrate` and `yarn db:seed` stand for whatever your
  repository's own scripts are called.
