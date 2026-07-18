// SPDX-License-Identifier: Apache-2.0

import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";

function blocked() {
  const error = new Error("OFFLINE_NETWORK_BLOCKED");
  error.code = "OFFLINE_NETWORK_BLOCKED";
  throw error;
}

async function blockedAsync() {
  blocked();
}

export function installNoNetworkGuard() {
  if (globalThis.__TCRN_OFFLINE_GUARD__ === true) {
    return;
  }
  Object.defineProperty(globalThis, "__TCRN_OFFLINE_GUARD__", {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  globalThis.fetch = async function guardedFetch() {
    blocked();
  };
  http.request = blocked;
  http.get = blocked;
  https.request = blocked;
  https.get = blocked;
  net.connect = blocked;
  net.createConnection = blocked;
  tls.connect = blocked;
  dns.lookup = blocked;
  dns.resolve = blocked;
  dns.resolve4 = blocked;
  dns.resolve6 = blocked;

  // The transport a socket actually uses. Patching net.connect only replaces the
  // convenience factory; `new net.Socket().connect(...)` reaches the wire untouched,
  // and so does everything layered on it (http.Agent, undici, raw client code).
  net.Socket.prototype.connect = blocked;
  tls.TLSSocket.prototype.connect = blocked;

  // The promise-shaped resolvers are separate function objects from the callback ones,
  // and node:dns/promises is a separate module namespace again. Both resolve names for
  // real while dns.lookup is blocked.
  for (const surface of [dns.promises, dnsPromises]) {
    surface.lookup = blockedAsync;
    surface.resolve = blockedAsync;
    surface.resolve4 = blockedAsync;
    surface.resolve6 = blockedAsync;
  }
  dns.Resolver.prototype.resolve = blocked;
  dns.Resolver.prototype.resolve4 = blocked;
  dns.Resolver.prototype.resolve6 = blocked;

  // A third transport with its own connect, unreachable from the http/https patches.
  http2.connect = blocked;

  // Every patch above mutates the CommonJS module object. ESM named imports
  // (`import { connect } from "node:net"`) bind to the original function and keep
  // working unless the builtin's export bindings are re-synchronized, which makes the
  // whole guard bypassable by import style alone.
  syncBuiltinESMExports();
}

installNoNetworkGuard();
