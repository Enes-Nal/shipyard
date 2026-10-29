import assert from "node:assert/strict";
import test from "node:test";

import { forgeOf } from "./forge.ts";

test("recognizes GitLab HTTPS, SSH and self-hosted remotes", () => {
  assert.equal(forgeOf("https://gitlab.com/acme/shop.git").kind, "gitlab");
  assert.equal(forgeOf("git@gitlab.com:acme/shop.git").kind, "gitlab");
  assert.equal(forgeOf("ssh://git@gitlab.acme.test/acme/shop.git").label, "GitLab");
});

test("keeps other remotes useful without pretending they are GitLab", () => {
  assert.equal(forgeOf("https://github.com/acme/shop.git").label, "GitHub");
  assert.equal(forgeOf("git@git.acme.test:acme/shop.git").label, "git.acme.test");
  assert.equal(forgeOf(undefined).label, "Git");
});
