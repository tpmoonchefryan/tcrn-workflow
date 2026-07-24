// SPDX-License-Identifier: Apache-2.0
//
// INIT-007 / S040 detector + S041 registration protocol. The load-bearing test is
// "the injected orphan is detected" — the red-proof behind guard-registry entry
// BR-01-orphan-pattern-detection. Verity's decomposition position made red-proof a
// hard acceptance condition precisely because a detector that never fires reads as
// green forever ("我自己的检测器也曾假绿"). The incident fixture below is the real
// 2026-07-24 shape: process groups whose bash leaders exited, leaving `yes` orphans
// reparented to init (ppid 1) burning ~20% cpu each.

import assert from "node:assert/strict";
import test from "node:test";

import {
  BackgroundResourceError,
  buildRegistrationLine,
  buildResidueReport,
  detectResidue,
  parseProcessTable,
  parseRegistrationLine,
  parseRegistry,
} from "../dist/build/packages/core/src/index.js";

const NOW = "2026-07-24T04:40:00Z";

// Reconstruct the incident: five groups, seven `yes` orphans each (ppid 1), plus
// two benign system processes that must never be flagged.
function incidentTable() {
  const groups = [74045, 74417, 74582, 74987, 75147];
  const lines = [
    "401 401 1 12.9 /System/Library/PrivateFrameworks/SkyLight.framework/WindowServer -daemon",
    "1093 1093 1 0.0 /usr/libexec/UsageTrackingAgent",
  ];
  let pid = 74048;
  for (const group of groups) {
    for (let index = 0; index < 7; index += 1) lines.push(`${pid++} ${group} 1 20.${index} yes`);
  }
  return { table: `${lines.join("\n")}\n`, groups, orphanCount: 35 };
}

test("BR: the injected orphan is detected via the registered process group", () => {
  const { table, groups, orphanCount } = incidentTable();
  const rows = parseProcessTable(table);
  const registrations = groups.map((pgid) => ({
    pgid,
    pattern: "yes",
    purpose: "cpu-stress:framerate-proof",
    spawnedAt: "2026-07-24T00:13:00Z",
  }));
  const report = detectResidue(registrations, rows, NOW);
  // The whole point: residue is PRESENT and every orphan is caught. If this ever
  // reads clean, the detector has been gutted, not the leak fixed.
  assert.equal(report.status, "residue-present");
  assert.equal(report.residueCount, orphanCount);
  assert.ok(report.residue.every((entry) => entry.reason === "registered-group-alive"));
  assert.ok(report.residue.every((entry) => entry.command === "yes"));
  // The two benign system processes are never residue.
  assert.ok(report.residue.every((entry) => entry.pid !== 401 && entry.pid !== 1093));
});

test("BR: the orphan-pattern backstop catches orphans whose group was never registered", () => {
  const { table, orphanCount } = incidentTable();
  const rows = parseProcessTable(table);
  // Only the command pattern is registered, under a pgid that appears nowhere in
  // the table — the leader already exited and its group is defunct.
  const registrations = [{ pgid: 999_999, pattern: "yes", purpose: "cpu-stress", spawnedAt: "2026-07-24T00:13:00Z" }];
  const report = detectResidue(registrations, rows, NOW);
  assert.equal(report.status, "residue-present");
  assert.equal(report.residueCount, orphanCount);
  assert.ok(report.residue.every((entry) => entry.reason === "orphaned-pattern-match" && entry.ppid === 1));
});

test("BR: a clean table after teardown reports clean (control for the red-proof)", () => {
  // Same registrations, but the orphans are gone (pkill succeeded) — only benign
  // processes remain. This is the negative control proving the assertion measures
  // the detector rather than a check that always passes.
  const rows = parseProcessTable(
    "401 401 1 12.9 /System/Library/PrivateFrameworks/SkyLight.framework/WindowServer -daemon\n" +
      "1093 1093 1 0.0 /usr/libexec/UsageTrackingAgent\n",
  );
  const registrations = [74045, 74417].map((pgid) => ({
    pgid,
    pattern: "yes",
    purpose: "cpu-stress",
    spawnedAt: "2026-07-24T00:13:00Z",
  }));
  const report = detectResidue(registrations, rows, NOW);
  assert.equal(report.status, "clean");
  assert.equal(report.residueCount, 0);
});

test("BR: a registered group with a live non-orphan member is residue", () => {
  // A load still running under its original leader (ppid !== 1) — only the
  // registered-group branch can catch this; the orphan-pattern backstop cannot,
  // so this isolates the registered-group red-proof (guard BR-02).
  const rows = parseProcessTable("5555 5000 5000 40.0 dev-server --watch\n5000 5000 900 0.1 node leader\n");
  const registrations = [{ pgid: 5000, pattern: "dev-server", purpose: "dev-server", spawnedAt: "2026-07-24T00:13:00Z" }];
  const report = detectResidue(registrations, rows, NOW);
  assert.equal(report.status, "residue-present");
  assert.equal(report.residueCount, 2);
  assert.ok(report.residue.every((entry) => entry.reason === "registered-group-alive"));
});

test("BR: a non-matching orphan is not misattributed", () => {
  // An init-reparented process whose command matches no registered pattern must be
  // left alone — the detector reports the session's own leaks, not every orphan.
  const rows = parseProcessTable("2222 2222 1 99.0 some-unrelated-daemon --serve\n");
  const registrations = [{ pgid: 74045, pattern: "yes", purpose: "cpu-stress", spawnedAt: "2026-07-24T00:13:00Z" }];
  assert.equal(detectResidue(registrations, rows, NOW).status, "clean");
});

test("BR: detection is deterministic and canonical", () => {
  const { table, groups } = incidentTable();
  const rows = parseProcessTable(table);
  const registrations = groups.map((pgid) => ({ pgid, pattern: "yes", purpose: "p", spawnedAt: "2026-07-24T00:13:00Z" }));
  const first = detectResidue(registrations, rows, NOW);
  const second = detectResidue(registrations, rows, NOW);
  assert.equal(first.reportDigest, second.reportDigest);
  // The serialized report is canonical JSON: sorted keys, exactly one terminal LF.
  const serialized = buildResidueReport(first);
  assert.ok(serialized.endsWith("}\n"));
  assert.equal(serialized.indexOf("\n"), serialized.length - 1);
  // residue is sorted by pid ascending, deterministically.
  const pids = first.residue.map((entry) => entry.pid);
  assert.deepEqual(pids, [...pids].sort((left, right) => left - right));
});

test("BR: a malformed process-table row fails closed", () => {
  assert.throws(
    () => parseProcessTable("not a valid ps row at all\n"),
    (error) => error instanceof BackgroundResourceError && error.reasonCode === "BACKGROUND_RESOURCE_INPUT_INVALID",
  );
});

test("BR: registration round-trips through canonical JSONL", () => {
  const registration = { pgid: 74045, pattern: "yes", purpose: "cpu-stress:framerate-proof", spawnedAt: "2026-07-24T00:13:00Z" };
  const line = buildRegistrationLine(registration);
  assert.ok(line.endsWith("}\n"));
  const parsed = parseRegistrationLine(line);
  assert.deepEqual(parsed, registration);
  const registry = parseRegistry(line + line);
  assert.equal(registry.length, 2);
});

test("BR: a non-canonical or misshapen registration line fails closed", () => {
  assert.throws(
    () => parseRegistrationLine('{"pgid": 1, "pattern": "yes"}'),
    (error) => error instanceof BackgroundResourceError && error.reasonCode === "BACKGROUND_RESOURCE_REGISTRATION_INVALID",
  );
  // A zero/negative pgid is not a real process group.
  assert.throws(
    () => buildRegistrationLine({ pgid: 0, pattern: "yes", purpose: "p", spawnedAt: "2026-07-24T00:13:00Z" }),
    (error) => error instanceof BackgroundResourceError && error.reasonCode === "BACKGROUND_RESOURCE_REGISTRATION_INVALID",
  );
  // An empty pattern would match every command and flag the whole process table.
  assert.throws(
    () => buildRegistrationLine({ pgid: 10, pattern: "", purpose: "p", spawnedAt: "2026-07-24T00:13:00Z" }),
    (error) => error instanceof BackgroundResourceError && error.reasonCode === "BACKGROUND_RESOURCE_REGISTRATION_INVALID",
  );
});
