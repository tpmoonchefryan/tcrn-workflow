// SPDX-License-Identifier: Apache-2.0
// User-facing notification (TCRN-CROSS-STORY-119).
//
// The point of this surface is the failure mode from 2026-07-31: a run stopped and
// nobody knew for five and a half hours. Every legitimate stop (completed / blocked /
// expired) and every escalation release emits a local macOS notification, so a stop —
// even a correct one — reaches the owner at once rather than sitting silent. No
// network: osascript only, so this works offline and sends nothing anywhere.
//
// The composed AppleScript string is built so the message cannot break out of the
// string literal or inject further AppleScript: quotes and backslashes are escaped,
// control characters stripped. Failure to notify is swallowed — a notifier that threw
// could take down a Stop hook, and a missing toast must never be able to do that.

import { spawnSync } from "node:child_process";

export function osascriptArgs(title, message) {
  const clean = (value) => String(value)
    .replace(/[\u0000-\u001f\u007f]/gu, " ") // no control bytes into the script
    .replace(/\\/gu, "\\\\")
    .replace(/"/gu, '\\"');
  const script = `display notification "${clean(message)}" with title "${clean(title)}"`;
  return ["-e", script];
}

export function notify(level, message, { runner = defaultRunner } = {}) {
  // An escape hatch so tests (and headless/CI runs) do not fire real desktop
  // notifications. Real sessions never set this.
  if (process.env.TCRN_STOP_PACT_NO_NOTIFY === "1") return false;
  const title = level === "loud" ? "TCRN stop-pact (!)" : "TCRN stop-pact";
  try {
    return runner(osascriptArgs(title, message));
  } catch {
    return false; // a notification must never be able to fail a stop
  }
}

function defaultRunner(args) {
  // macOS only; on any other platform osascript is absent and spawnSync reports an
  // error, which we treat as "no notification available" rather than a failure.
  const result = spawnSync("/usr/bin/osascript", args, { timeout: 4000 });
  return result.status === 0;
}
