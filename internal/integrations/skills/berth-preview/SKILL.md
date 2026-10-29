---
name: berth-preview
description: Run a worktree's dev server on its own port and show the page to the user in their Terminal app — start the app on $BERTH_PORT, check it answers, and open it as a browser tab next to your terminal with `berthd preview`. Use when you change UI or anything with a page, when the user asks to see, preview, open or check something in the browser, or when you want them to look at your work.
---

# Previewing with berth

Every worktree has its own ports (`$BERTH_PORT`, `$BERTH_PORT_1`, …). The
user's Terminal app reaches whatever listens in that block at the worktree's own
address, e.g. `http://fix-login.shop.devl.localhost:1377/`. No forwarding or
tunnels are needed.

## 1. Run it on the worktree's port

If the repository defines a service (see `berthd service list
$BERTH_LOCATION/$BERTH_WORKTREE_NAME`), start it:

```sh
berthd service start "$BERTH_LOCATION/$BERTH_WORKTREE_NAME" web
```

Otherwise start the dev server yourself in a terminal the user can see, bound
to the worktree's port:

```sh
berthd session new "$BERTH_LOCATION/$BERTH_WORKTREE_NAME" -- pnpm dev --port $BERTH_PORT
```

Most frameworks take a port flag (`--port`, `-p`) or read `PORT`. Listen on
`127.0.0.1` or `0.0.0.0`, not a fixed port like 3000, which another worktree
may already use.

## 2. Check it answers

```sh
curl -sf -o /dev/null -w '%{http_code}\n' http://127.0.0.1:$BERTH_PORT/
berthd services --json        # the port should be listed under this worktree
```

If it is not up, read the server's output (`berthd session screen NAME` or
`berthd service log …`) and fix that first.

## 3. Show it to the user

```sh
berthd preview                         # this worktree's port, its home page
berthd preview $BERTH_PORT --path /account/orders
```

This opens the page as a browser tab in the user's Terminal app, in this
worktree's workspace, beside your terminal. It does nothing visible when the
app is closed, so also tell the user what to look at and where. From a laptop:
`berth preview BOX/LOC/WORKTREE [PORT] [--path /x]`.

Do not use `berthd share` to show work: it makes the page public on the
internet. Only share when the user explicitly asks for a public link.
