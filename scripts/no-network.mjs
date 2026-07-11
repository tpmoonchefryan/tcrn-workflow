// SPDX-License-Identifier: Apache-2.0

import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

function blocked() {
  const error = new Error("OFFLINE_NETWORK_BLOCKED");
  error.code = "OFFLINE_NETWORK_BLOCKED";
  throw error;
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
}

installNoNetworkGuard();
