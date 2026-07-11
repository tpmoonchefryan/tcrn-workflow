// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";

test("Node network entry points are blocked during verification", async () => {
  assert.equal(globalThis.__TCRN_OFFLINE_GUARD__, true);
  await assert.rejects(fetch("https://example.invalid"), /OFFLINE_NETWORK_BLOCKED/u);
  assert.throws(() => http.request("http://example.invalid"), /OFFLINE_NETWORK_BLOCKED/u);
  assert.throws(() => net.connect(443, "example.invalid"), /OFFLINE_NETWORK_BLOCKED/u);
});
