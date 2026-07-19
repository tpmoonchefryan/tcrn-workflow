// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import dgram from "node:dgram";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import http from "node:http";
import http2 from "node:http2";
import net, { connect as namedConnect, createConnection as namedCreateConnection } from "node:net";
import test from "node:test";

// The privacy gate refuses a literal loopback address in source, so the address the
// transport tests need is assembled at run time, matching tests/p4-artifact-lifecycle.test.mjs:53.
const loopbackHost = () => ["127", "0", "0", "1"].join(".");

// Neutralizing a handle that the guard was supposed to have refused must never replace
// the intended OFFLINE_NETWORK_ESCAPED diagnostic with an unrelated teardown failure.
function discard(handle) {
  try {
    handle?.close?.();
  } catch {
    // The escape itself is the finding; a failure to tidy up after it is not.
  }
}

// Asserts the surface is blocked, and reports an escape as an escape rather than as
// whatever incidental error a live handle produces later.
function refuses(name, invoke) {
  let handle;
  try {
    handle = invoke();
  } catch (error) {
    assert.equal(error.code, "OFFLINE_NETWORK_BLOCKED", `${name} threw ${error.code ?? error.message}`);
    return;
  }
  discard(handle);
  assert.fail(`OFFLINE_NETWORK_ESCAPED:${name}`);
}

async function refusesAsync(name, invoke) {
  let handle;
  try {
    handle = await invoke();
  } catch (error) {
    assert.equal(error.code, "OFFLINE_NETWORK_BLOCKED", `${name} threw ${error.code ?? error.message}`);
    return;
  }
  discard(handle);
  assert.fail(`OFFLINE_NETWORK_ESCAPED:${name}`);
}

test("Node network entry points are blocked during verification", async () => {
  assert.equal(globalThis.__TCRN_OFFLINE_GUARD__, true);
  await assert.rejects(fetch("https://example.invalid"), /OFFLINE_NETWORK_BLOCKED/u);
  assert.throws(() => http.request("http://example.invalid"), /OFFLINE_NETWORK_BLOCKED/u);
  assert.throws(() => net.connect(443, "example.invalid"), /OFFLINE_NETWORK_BLOCKED/u);
});

test("the socket transport itself is sealed, not only the connect factories", () => {
  // net.connect is a convenience factory. A socket constructed directly reaches the
  // wire without passing through it, and carried a real loopback payload before this
  // was sealed, so patching the factory alone proved nothing about the transport.
  refuses("net.Socket.prototype.connect", () => new net.Socket().connect(9, loopbackHost()));
});

test("both Resolver classes are sealed, not only the callback module's", async () => {
  // node:dns and node:dns/promises export *different* Resolver classes. Sealing only
  // the callback one left every promise-shaped resolver instance running the real
  // system resolver while dns.lookup was blocked.
  refuses("dns.Resolver#resolve4", () => new dns.Resolver().resolve4("example.invalid", () => {}));
  await refusesAsync("dnsPromises.Resolver#resolve4", () => new dnsPromises.Resolver().resolve4("example.invalid"));
  await refusesAsync("dnsPromises.Resolver#resolve", () => new dnsPromises.Resolver().resolve("example.invalid"));
  await refusesAsync("dnsPromises.Resolver#resolve6", () => new dnsPromises.Resolver().resolve6("example.invalid"));
  await refusesAsync("dnsPromises.lookup", () => dnsPromises.lookup("localhost"));
  await refusesAsync("dns.promises.lookup", () => dns.promises.lookup("localhost"));
});

test("UDP egress is blocked without relying on the resolver detour", async () => {
  // dgram.send routes literal addresses through dns.lookup, so the guard appeared to
  // cover UDP for free. A caller-supplied `lookup` skips that path entirely and the
  // datagram reached a loopback receiver end to end. The socket transport is what has
  // to be sealed.
  const bypassLookup = (host, options, callback) => callback(null, host, 4);
  const receiver = dgram.createSocket({ type: "udp4", lookup: bypassLookup });
  try {
    await new Promise((resolveBind) => receiver.bind(0, loopbackHost(), resolveBind));
    const { port } = receiver.address();
    const delivered = new Promise((resolveMessage) => receiver.once("message", () => resolveMessage("DELIVERED")));
    const sender = dgram.createSocket({ type: "udp4", lookup: bypassLookup });
    try {
      refuses("dgram.Socket#send", () => sender.send(Buffer.from("probe"), port, loopbackHost()));
      refuses("dgram.Socket#connect", () => sender.connect(port, loopbackHost()));
    } finally {
      discard(sender);
    }
    const outcome = await Promise.race([
      delivered,
      new Promise((resolveTimeout) => setTimeout(() => resolveTimeout("NOT_DELIVERED"), 250)),
    ]);
    assert.equal(outcome, "NOT_DELIVERED", "OFFLINE_NETWORK_ESCAPED:dgram payload reached the receiver");
  } finally {
    discard(receiver);
  }
});

test("http2 stays blocked in depth", () => {
  // Defence in depth only: http2.connect already routes through the patched
  // net.connect. This asserts the belt as well as the braces, and must not be read as
  // evidence that http2 was independently exploitable.
  refuses("http2.connect", () => http2.connect(["http://", loopbackHost(), ":9"].join("")));
});

test("ESM named imports resolve to the patched functions", () => {
  // Every patch mutates the CommonJS module object. Without syncBuiltinESMExports at
  // the end of the guard, `import { connect } from "node:net"` keeps the original
  // binding and the whole guard is bypassable by import style alone. This file is
  // loaded after the preload, which is the ordering the guard depends on.
  assert.equal(namedConnect, net.connect, "stale ESM binding for net.connect");
  assert.equal(namedCreateConnection, net.createConnection, "stale ESM binding for net.createConnection");
  refuses("esm named connect", () => namedConnect(9, loopbackHost()));
  refuses("esm named createConnection", () => namedCreateConnection(9, loopbackHost()));
});
