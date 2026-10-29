# Hello ports

An example Terminal plugin: a screen listing every dev server on every box with
a button to open it, a sidebar item and a command that open that screen, a
worktree section (under the composer where work starts in a worktree) with
the ports open there, a Home widget with the same list (Home → Customize →
Add widget, under "Hello ports"), and a notification when a worktree is
created.

```sh
pnpm install && pnpm build
mkdir -p ~/.berth/plugins && ln -s "$PWD" ~/.berth/plugins/hello-ports
```

Then Settings → Plugins → Reload in the app.
