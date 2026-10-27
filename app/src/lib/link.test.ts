// node --experimental-strip-types --test src/lib/link.test.ts (pnpm test)
import assert from "node:assert/strict";
import { test } from "node:test";

import { latencyText, relayNote, slowNote } from "./link.ts";

test("a relayed box names the relay's city, and this computer's nearest when it differs", () => {
  assert.equal(relayNote({ via: "relay", relay: "nyc", relay_name: "New York", nearest: "London" }), "Relayed through Tailscale's New York server: no direct connection (this computer's nearest is London)");
  assert.equal(relayNote({ via: "relay", relay: "nyc", relay_name: "New York", nearest: "New York" }), "Relayed through Tailscale's New York server: no direct connection");
  assert.equal(relayNote({ via: "relay", relay: "xyz" }), "Relayed through Tailscale's XYZ server: no direct connection");
  assert.equal(relayNote({ via: "peer-relay", endpoint: "198.51.100.2:40000:7" }), "Relayed through a Tailscale peer relay: no direct connection");
  assert.equal(relayNote({ via: "direct", endpoint: "203.0.113.4:41641" }), undefined);
  assert.equal(relayNote(undefined), undefined);
});

test("a slow box says why, and that it is still connected", () => {
  assert.equal(slowNote({ slow: true, reason: "health check took 1.9s" }), "Slow: health check took 1.9s. Shipkit stays connected, and requests still go through.");
  assert.equal(slowNote({ slow: false, reason: "health check took 80ms" }), undefined);
  assert.equal(slowNote(undefined), undefined);
});

test("latency shows how high it went lately only when that is well above it", () => {
  assert.equal(latencyText(80, { max_ms: 1900 }), "80 ms · up to 1,900 ms");
  assert.equal(latencyText(80, { max_ms: 120 }), "80 ms");
  assert.equal(latencyText(80, undefined), "80 ms");
  assert.equal(latencyText(undefined, { max_ms: 1900 }), undefined);
});
