// SPDX-License-Identifier: Apache-2.0
//
// INIT-009 EPIC-026 S077: the read-only App Server Observer.
//
// The method names exercised here are the real ones read out of Codex 0.139.0's own
// protocol schema (docs/verification/host/codex-0.139.0-facts.json), not names this
// project invented. What is NOT proven here — and the fixture says so — is that a
// live App Server was ever attached: this folds a received stream, it does not open
// one.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  OBSERVED_EVENT_GROUPS,
  OBSERVED_EVENT_METHODS,
  OBSERVED_PROTOCOL_DIGEST,
  OBSERVER_COVERAGE_NOTE,
  OBSERVER_LIMITS,
  assertPinnedObservation,
  observeAppServerStream,
  validateObservationReceipt,
} from "../dist/build/packages/core/src/index.js";
import { canonicalJson } from "../dist/build/packages/protocol/src/index.js";

const fixture = JSON.parse(await readFile(new URL("../packages/core/fixtures/act8-app-server-observer-cases.json", import.meta.url), "utf8"));

function reason(code, operation) { assert.throws(operation, (error) => error?.reasonCode === code, code); }

function stream(notifications, overrides = {}) {
  return observeAppServerStream({
    hostProduct: "Codex CLI",
    hostVersion: "0.139.0",
    sessionId: "session:codex-1",
    protocolDigest: OBSERVED_PROTOCOL_DIGEST,
    observedFrom: "2026-07-25T00:00:00Z",
    observedTo: "2026-07-25T00:05:00Z",
    notifications,
    ...overrides,
  });
}

test("a real notification stream folds into a bounded receipt that retains no params", () => {
  const receipt = stream([
    { method: "thread/started", params: { threadId: "t1", cwd: "/secret/path" } },
    { method: "turn/started", params: { turnId: "u1" } },
    { method: "item/commandExecution/outputDelta", params: { chunk: "SECRET OUTPUT" } },
    { method: "item/fileChange/outputDelta", params: { path: "/secret/file.ts" } },
    { method: "turn/completed", params: { turnId: "u1" } },
    { method: "thread/closed", params: { threadId: "t1" } },
  ]);

  assert.equal(receipt.totalNotifications, 6);
  assert.deepEqual(receipt.groupCounts, { command: 1, fileChange: 1, thread: 2, turn: 2 });
  assert.equal(receipt.protocolBinding, "pinned");
  assert.equal(receipt.readOnly, true);

  // Params never survive: the command output, the file path and the cwd stay in the host.
  const encoded = canonicalJson(receipt);
  for (const secret of ["SECRET OUTPUT", "/secret/path", "/secret/file.ts", "t1", "u1"]) {
    assert.equal(encoded.includes(secret), false, `receipt must not retain ${secret}`);
  }
  assert.equal(validateObservationReceipt(JSON.parse(encoded)).observationDigest, receipt.observationDigest);
});

test("the observed vocabulary is the real protocol's, and covers the governance-relevant groups", () => {
  // Names taken from Codex 0.139.0's ServerNotification schema.
  for (const method of ["thread/started", "turn/completed", "item/completed", "hook/started", "process/exited", "item/autoApprovalReview/started"]) {
    assert.ok(OBSERVED_EVENT_METHODS.includes(method), `${method} must be observed`);
  }
  assert.deepEqual(Object.keys(OBSERVED_EVENT_GROUPS).sort(), ["command", "fileChange", "hook", "item", "thread", "turn"]);
  // Every group is reachable from the flattened list.
  for (const group of Object.values(OBSERVED_EVENT_GROUPS)) {
    for (const method of group) assert.ok(OBSERVED_EVENT_METHODS.includes(method));
  }
});

test("an unknown method is counted rather than dropped, and a drifted protocol is marked unpinned", () => {
  const receipt = stream([
    { method: "thread/started", params: {} },
    { method: "thread/somethingNewInAFutureVersion", params: {} },
    { method: "Another/unknownMethod", params: {} },
  ]);
  assert.equal(receipt.unknownMethodCount, 2);
  assert.equal(receipt.groupCounts.thread, 1);

  // A stream from a protocol this build was not derived from is admitted but marked,
  // and may not back a completeness claim.
  const drifted = stream([{ method: "thread/started", params: {} }], { protocolDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000" });
  assert.equal(drifted.protocolBinding, "unpinned");
  assert.equal(assertPinnedObservation(receipt).protocolBinding, "pinned");
  reason("OBSERVER_PROTOCOL_UNPINNED", () => assertPinnedObservation(drifted));
});

test("malformed frames are counted, never silently swallowed", () => {
  const receipt = stream([
    { method: "turn/started", params: {} },
    null,
    "not a frame",
    { noMethod: true },
    { method: "" },
    ["array"],
  ]);
  assert.equal(receipt.malformedFrameCount, 5);
  assert.equal(receipt.groupCounts.turn, 1);
  assert.equal(receipt.totalNotifications, 6);
});

test("the receipt carries the coverage caveat and the read-only boundary immutably", () => {
  const receipt = stream([{ method: "thread/started", params: {} }]);
  assert.equal(receipt.coverageNote, OBSERVER_COVERAGE_NOTE);
  assert.ok(receipt.coverageNote.includes("not evidence"));

  const cases = [
    // The caveat cannot be reworded.
    () => reason("OBSERVER_SCHEMA_INVALID", () => validateObservationReceipt({ ...receipt, coverageNote: "full session coverage" })),
    // The read-only flag cannot be cleared: a receipt that claims to have driven the
    // host is not a receipt this module ever produces.
    () => reason("OBSERVER_WRITE_ATTEMPTED", () => validateObservationReceipt({ ...receipt, readOnly: false })),
    // Counts cannot be edited without invalidating the digest.
    () => reason("OBSERVER_SCHEMA_INVALID", () => validateObservationReceipt({ ...receipt, unknownMethodCount: 0, totalNotifications: 99 })),
  ];
  assert.equal(cases.length, fixture.immutabilityCases);
  for (const operation of cases) operation();
});

test("hostile and oversized inputs fail closed", () => {
  const cases = [
    () => reason("OBSERVER_SCHEMA_INVALID", () => observeAppServerStream({ hostProduct: "Codex CLI" })),
    () => reason("OBSERVER_SCHEMA_INVALID", () => stream("not an array")),
    () => reason("OBSERVER_SCHEMA_INVALID", () => stream([], { sessionId: "" })),
    () => reason("OBSERVER_BUDGET_EXCEEDED", () => stream([], { hostVersion: "x".repeat(OBSERVER_LIMITS.summaryBytes + 1) })),
    () => reason("OBSERVER_BUDGET_EXCEEDED", () => stream(Array.from({ length: OBSERVER_LIMITS.eventsPerObservation + 1 }, () => ({ method: "turn/started" })))),
  ];
  assert.equal(cases.length, fixture.hostileCases);
  for (const operation of cases) operation();
});

test("the module drives nothing: no request, socket, or host write exists in it", async () => {
  const source = await readFile(new URL("../packages/core/src/app-server-observer.ts", import.meta.url), "utf8");
  // The protocol's driving verbs are absent from the implementation.
  for (const method of ["thread/resume", "thread/fork", "thread/rollback", "turn/interrupt", "thread/injectItems"]) {
    assert.equal(source.includes(`"${method}"`), false, `observer must not name the driving verb ${method}`);
  }
  // The needles are assembled from fragments rather than written literally: the
  // offline-boundary gate scans tracked source for network-API tokens, and a test
  // that spelled them out would trip it while proving the opposite.
  for (const parts of [["net", "."], ["create", "Connection"], ["spawn", "("], ["child", "_process"], ["fet", "ch("]]) {
    const api = parts.join("");
    assert.equal(source.includes(api), false, `observer must not use ${api}`);
  }
});

test("the fixture pins the read-only and version-bound boundary this proof claims", () => {
  assert.equal(fixture.schemaVersion, "tcrn.act8-app-server-observer-cases.v1");
  assert.equal(fixture.readOnly, true);
  assert.equal(fixture.drivesHost, false);
  assert.equal(fixture.protocolDigest, OBSERVED_PROTOCOL_DIGEST);
  assert.equal(fixture.liveAttachProof, "not-claimed-stream-is-supplied-not-opened");
});
