# hello

A tiny project for trying Terminal: a web server with one page and a test,
in plain Node.js with no dependencies.

```sh
npm start    # serves on $PORT (Terminal sets one per worktree), or 3000
npm test     # node --test
```

`greet.js` makes the greeting, `server.js` serves it, and
`greet.test.js` checks it. Ask an agent for something small, such as a
`/health` endpoint that returns `{"ok": true}` with a test, and watch it
work in its own worktree.
