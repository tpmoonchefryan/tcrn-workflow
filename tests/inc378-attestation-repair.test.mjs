// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-INC-378 R4: attestation-verify, attestation-migrate --mode repair and
// attestation-migrate --mode restore, driven through the CLI against scratch workspaces
// and scratch attestation stores. Every store here is built the way the live ones were --
// attested writes, then one migration -- or, for the one-MiB edge, byte for byte as
// v1.1.2 left cross-project after event 8249.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { appendFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { deleteLegacyAttestations, initializeWorkspace, migrateAttestationDirectory, reportAttestationDirectory } from "../dist/build/packages/core/src/index.js";
import { canonicalJson, canonicalSha256, PROTOCOL_LIMITS } from "../dist/build/packages/protocol/src/index.js";

const instant = (second) => `2026-09-23T00:${String(Math.floor(second / 60)).padStart(2, "0")}:${String(second % 60).padStart(2, "0")}Z`;
const OBSERVED = "2026-09-23T01:00:00Z";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-inc378-repair-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    await mkdir(join(base, kind));
    roots.push({ kind, path: join(base, kind) });
  }
  await initializeWorkspace({ roots, externalKey: "WORKSPACE-INC378", createdAt: instant(0), segmentEventLimit: 64 });
  return { base, workspace: join(base, "workspace"), attestDir: join(base, "attestations"), version: 0 };
}

async function cli(argv) {
  let output = "";
  try {
    await runCli(argv, { write: (value) => { output += value; }, clock: () => OBSERVED });
    return { ok: true, value: JSON.parse(output) };
  } catch (error) {
    return { ok: false, reasonCode: error?.reasonCode, message: String(error?.message ?? error) };
  }
}

// One project-create, attested unless told otherwise; returns the new head event hash.
async function write(fx, key, attested = true) {
  const result = await cli(["project-create", "--workspace", fx.workspace, "--expected-version", String(fx.version), "--at", instant(fx.version + 1),
    "--external-key", key, "--name", key, ...(attested ? ["--attest-dir", fx.attestDir] : [])]);
  assert.equal(result.ok, true, JSON.stringify(result));
  fx.version += 1;
  fx.head = result.value.headEventHash;
  return fx.head;
}

async function segmentedStore(fx, count, segmentBytes) {
  for (let index = 0; index < count; index += 1) await write(fx, `PROJECT-S${index}`);
  const baseline = await reportAttestationDirectory(fx.attestDir);
  await migrateAttestationDirectory(fx.attestDir, segmentBytes);
  await deleteLegacyAttestations(fx.attestDir, baseline);
}

// The shape event 8249 left, at small scale: one more attested write, then the manifest
// from before it put back, so the segment holds a record the manifest never counted.
async function sortedInsertShape(fx, key) {
  const manifest = await readFile(join(fx.attestDir, "manifest.json"));
  const head = await write(fx, key);
  await writeFile(join(fx.attestDir, "manifest.json"), manifest);
  return head;
}

async function digests(directory) {
  const result = {};
  for (const name of (await readdir(directory)).sort()) result[name] = sha256(await readFile(join(directory, name)));
  return result;
}

async function absent(path) {
  return readdir(path).then(() => false, (error) => error.code === "ENOENT");
}

const verify = (fx) => cli(["attestation-verify", "--attest-dir", fx.attestDir, "--workspace", fx.workspace]);
const repair = (fx, extras, backupDir) => cli(["attestation-migrate", "--root", fx.attestDir, "--mode", "repair", "--workspace", fx.workspace,
  "--expect-extra", extras.join(","), "--backup-dir", backupDir]);
const restore = (fx, backupDir) => cli(["attestation-migrate", "--root", fx.attestDir, "--mode", "restore", "--backup-dir", backupDir]);

function receiptLine(eventHash, occurredAt, observedAt = OBSERVED) {
  return canonicalJson({ schemaVersion: "tcrn.time-attestation.v1", eventHash, observedAt, occurredAt });
}

test("INC-378 verify reports a consistent store without taking the lock or writing a byte", async (context) => {
  const fx = await fixture(context);
  await segmentedStore(fx, 4);
  const before = await digests(fx.attestDir);
  const result = await verify(fx);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.schemaVersion, "tcrn.attestation-verify.v1");
  assert.equal(result.value.consistent, true);
  assert.deepEqual(result.value.problems, []);
  assert.equal(result.value.computed.count, 4);
  assert.equal(result.value.computed.recordsDigest, result.value.manifest.document.recordsDigest);
  assert.deepEqual(result.value.chainHead, { version: 4, headEventHash: fx.head, receiptPresent: true });
  assert.equal(result.value.lock, null);
  assert.deepEqual(result.value.temporaryFiles, []);
  assert.deepEqual(await digests(fx.attestDir), before, "no file was added, removed or changed");

  // A store locked by a live writer is still read at once: verify neither waits for the
  // lock nor takes it, and reports it as it finds it.
  const holder = spawn(process.execPath, ["--eval", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  context.after(() => holder.kill("SIGKILL"));
  await writeFile(join(fx.attestDir, "attestation.lock"), `${holder.pid}\n`, "utf8");
  const locked = await digests(fx.attestDir);
  const started = Date.now();
  const read = await verify(fx);
  assert.equal(read.ok, true, JSON.stringify(read));
  assert.ok(Date.now() - started < 5_000, "verify did not wait for the lock");
  assert.equal(read.value.lock, String(holder.pid));
  assert.deepEqual(await digests(fx.attestDir), locked, "the lock was left exactly as it was");
  holder.kill("SIGKILL");
  await once(holder, "exit");
});

test("INC-378 repair puts back the record a sorted write left outside its manifest, and restore undoes it", async (context) => {
  const fx = await fixture(context);
  await segmentedStore(fx, 6);
  const extra = await sortedInsertShape(fx, "PROJECT-Z");
  const before = await digests(fx.attestDir);
  const segmentBefore = await readFile(join(fx.attestDir, "000001.ndjson"));

  const found = await verify(fx);
  assert.equal(found.value.consistent, false);
  assert.equal(found.value.extraRecords.status, "resolved");
  const [record] = found.value.extraRecords.records;
  assert.equal(record.eventHash, extra);
  assert.equal(record.segment, "000001.ndjson");
  assert.ok(record.line > 1 && record.line < 7, `the record sits inside the segment (line ${record.line} of 7), not at an end`);
  assert.equal(record.offset, segmentBefore.indexOf(extra) - '{"eventHash":"'.length, "the offset is where its line starts");
  assert.deepEqual(record.chainEvent, { sequence: 7, occurredAt: instant(7), occurredAtMatches: true });

  const backupDir = join(fx.base, "backup");
  const repaired = await repair(fx, [extra], backupDir);
  assert.equal(repaired.ok, true, JSON.stringify(repaired));
  assert.equal(repaired.value.after.manifest.count, repaired.value.before.manifest.count + 1);
  assert.equal(repaired.value.before.concatenatedSha256, sha256(segmentBefore));
  assert.equal(repaired.value.after.concatenatedSha256, sha256(segmentBefore), "no record byte moved");
  assert.deepEqual(repaired.value.extraRecords.map((entry) => entry.chainEvent), [{ sequence: 7, occurredAt: instant(7) }]);
  const backupManifest = JSON.parse(await readFile(join(backupDir, "backup-manifest.json"), "utf8"));
  assert.equal(repaired.value.backup.manifestSha256, sha256(await readFile(join(backupDir, "backup-manifest.json"))));
  for (const entry of backupManifest.files) {
    assert.equal(entry.copied, true);
    assert.equal(sha256(await readFile(join(backupDir, entry.name))), before[entry.name], `${entry.name} is backed up byte for byte`);
  }
  assert.deepEqual(backupManifest.files.map((entry) => entry.name).sort(), Object.keys(before));
  const after = await verify(fx);
  assert.equal(after.value.consistent, true, JSON.stringify(after.value.problems));
  assert.equal(after.value.chainHead.receiptPresent, true);

  const restored = await restore(fx, backupDir);
  assert.equal(restored.ok, true, JSON.stringify(restored));
  assert.deepEqual(await digests(fx.attestDir), before, "every store file is back as it was before the repair");
});

// The live incident at full scale: v1.1.2 wrote every receipt into one 000001 segment that
// crossed one MiB, and its manifest still describes the store before that receipt.
async function edgeShape(fx) {
  const lineBytes = Buffer.byteLength(receiptLine("0".repeat(64), instant(1)), "utf8");
  const count = Math.floor((PROTOCOL_LIMITS.maxCanonicalBytes - 2) / lineBytes);
  const filler = Array.from({ length: count }, (_, index) => receiptLine(sha256(`filler:${index}`), instant(1)));
  const head = await write(fx, "PROJECT-EDGE", false);
  const all = [...filler, receiptLine(head, instant(fx.version))].sort();
  const offsets = {};
  let offset = 0;
  for (const line of all) {
    offsets[JSON.parse(line).eventHash] = { segment: "000001.ndjson", offset, length: Buffer.byteLength(line, "utf8") };
    offset += Buffer.byteLength(line, "utf8");
  }
  const old = [...filler].sort().join("");
  await mkdir(fx.attestDir, { recursive: true });
  await writeFile(join(fx.attestDir, "000001.ndjson"), all.join(""), "utf8");
  await writeFile(join(fx.attestDir, "000001.idx"), canonicalJson({ schemaVersion: "tcrn.attestation-index.v1", entries: offsets }), "utf8");
  await writeFile(join(fx.attestDir, "manifest.json"), canonicalJson({
    schemaVersion: "tcrn.attestation-manifest.v1",
    segments: [{ name: "000001.ndjson", bytes: Buffer.byteLength(old, "utf8"), records: count, sha256: sha256(old) }],
    count,
    recordsDigest: canonicalSha256([...filler].sort().map((line) => JSON.parse(line))),
  }), "utf8");
  return { head, count };
}

test("INC-378 repair at the one-MiB edge splits the store in two, and restore removes the second segment again", async (context) => {
  const fx = await fixture(context);
  const { head, count } = await edgeShape(fx);
  const before = await digests(fx.attestDir);
  const found = await verify(fx);
  assert.equal(found.value.extraRecords.status, "resolved", "every line is the same length, so each one was tried");
  assert.equal(found.value.extraRecords.records[0].eventHash, head);
  assert.equal(found.value.extraRecords.records[0].chainEvent.occurredAtMatches, true);

  const backupDir = join(fx.base, "backup");
  const repaired = await repair(fx, [head], backupDir);
  assert.equal(repaired.ok, true, JSON.stringify(repaired));
  assert.deepEqual(repaired.value.after.manifest.segments.map((segment) => segment.records), [count, 1]);
  assert.equal(repaired.value.after.concatenatedSha256, repaired.value.before.concatenatedSha256);
  assert.deepEqual((await readdir(fx.attestDir)).sort(), ["000001.idx", "000001.ndjson", "000002.idx", "000002.ndjson", "manifest.json"]);
  assert.equal((await verify(fx)).value.consistent, true);

  const restored = await restore(fx, backupDir);
  assert.equal(restored.ok, true, JSON.stringify(restored));
  assert.deepEqual([...restored.value.removed].sort(), ["000002.idx", "000002.ndjson"]);
  assert.deepEqual(await digests(fx.attestDir), before);
});

test("INC-378 repair takes back a record appended after the last segment and keeps the store in eventHash order", async (context) => {
  const fx = await fixture(context);
  await segmentedStore(fx, 45, 4096);
  assert.deepEqual(JSON.parse(await readFile(join(fx.attestDir, "manifest.json"), "utf8")).segments.map((segment) => segment.records), [20, 20, 5]);
  const head = await write(fx, "PROJECT-TAIL", false);
  const tail = receiptLine(head, instant(fx.version));
  await appendFile(join(fx.attestDir, "000003.ndjson"), tail, "utf8");
  const found = await verify(fx);
  assert.deepEqual([found.value.extraRecords.status, found.value.extraRecords.records[0].segment, found.value.extraRecords.records[0].line], ["resolved", "000003.ndjson", 6]);

  const repaired = await repair(fx, [head], join(fx.base, "backup"));
  assert.equal(repaired.ok, true, JSON.stringify(repaired));
  const verdict = await verify(fx);
  assert.equal(verdict.value.consistent, true, JSON.stringify(verdict.value.problems));
  const lines = (await readFile(join(fx.attestDir, "000001.ndjson"), "utf8")).split("\n").slice(0, -1);
  const hashes = lines.map((line) => JSON.parse(line).eventHash);
  assert.equal(lines.length, 46);
  assert.ok(lines.includes(tail.slice(0, -1)), "the appended receipt is kept");
  assert.deepEqual(hashes, [...hashes].sort(), "and the store is in eventHash order again");
  assert.deepEqual((await readdir(fx.attestDir)).sort(), ["000001.idx", "000001.ndjson", "manifest.json"]);
});

// A refused repair changes no byte in the store and leaves no backup behind.
async function assertRefused(fx, extras, backupDir, pattern) {
  const before = await digests(fx.attestDir);
  const backupBefore = await absent(backupDir) ? null : await digests(backupDir);
  const result = await repair(fx, extras, backupDir);
  assert.equal(result.reasonCode, "ATTESTATION_REPAIR_REFUSED", JSON.stringify(result));
  assert.match(result.message, pattern);
  assert.deepEqual(await digests(fx.attestDir), before, "the store is unchanged");
  if (backupBefore === null) assert.equal(await absent(backupDir), true, "no backup was created");
  else assert.deepEqual(await digests(backupDir), backupBefore, "the backup directory is unchanged");
}

test("INC-378 repair refuses an expected record that is not in the store", async (context) => {
  const fx = await fixture(context);
  await segmentedStore(fx, 6);
  await sortedInsertShape(fx, "PROJECT-Z");
  await assertRefused(fx, [sha256("absent")], join(fx.base, "backup"), /0 times/u);
});

test("INC-378 repair refuses a named record whose removal does not leave the manifest store", async (context) => {
  const fx = await fixture(context);
  await segmentedStore(fx, 6);
  await sortedInsertShape(fx, "PROJECT-Z");
  const counted = JSON.parse((await readFile(join(fx.attestDir, "000001.ndjson"), "utf8")).split("\n")[0]).eventHash;
  await assertRefused(fx, [counted], join(fx.base, "backup"), /not the store the manifest describes/u);
});

test("INC-378 repair refuses a record for an event the chain does not have", async (context) => {
  const fx = await fixture(context);
  await segmentedStore(fx, 6);
  await appendFile(join(fx.attestDir, "000001.ndjson"), receiptLine(sha256("no such event"), instant(9)), "utf8");
  assert.equal((await verify(fx)).value.extraRecords.records[0].chainEvent, null);
  await assertRefused(fx, [sha256("no such event")], join(fx.base, "backup"), /not an event on the chain/u);
});

test("INC-378 repair refuses a record whose occurredAt is not its event time", async (context) => {
  const fx = await fixture(context);
  await segmentedStore(fx, 6);
  const head = await write(fx, "PROJECT-LATE", false);
  await appendFile(join(fx.attestDir, "000001.ndjson"), receiptLine(head, instant(59)), "utf8");
  assert.equal((await verify(fx)).value.extraRecords.records[0].chainEvent.occurredAtMatches, false);
  await assertRefused(fx, [head], join(fx.base, "backup"), /occurredAt/u);
});

test("INC-378 repair refuses a backup directory inside the store or the workspace, or one that is not empty", async (context) => {
  const fx = await fixture(context);
  await segmentedStore(fx, 6);
  const extra = await sortedInsertShape(fx, "PROJECT-Z");
  await assertRefused(fx, [extra], join(fx.attestDir, "backup"), /outside the attestation directory/u);
  await assertRefused(fx, [extra], join(fx.workspace, "backup"), /outside the attestation directory and the workspace root/u);
  const occupied = join(fx.base, "occupied");
  await mkdir(occupied);
  await writeFile(join(occupied, "keep.txt"), "kept\n", "utf8");
  await assertRefused(fx, [extra], occupied, /must not exist or must be empty/u);
});

test("INC-378 restore refuses a backup that changed by one byte", async (context) => {
  const fx = await fixture(context);
  await segmentedStore(fx, 6);
  const extra = await sortedInsertShape(fx, "PROJECT-Z");
  const backupDir = join(fx.base, "backup");
  assert.equal((await repair(fx, [extra], backupDir)).ok, true);
  const copy = join(backupDir, "000001.ndjson");
  const bytes = await readFile(copy);
  bytes[10] = bytes[10] === 0x61 ? 0x62 : 0x61;
  await writeFile(copy, bytes);
  const repaired = await digests(fx.attestDir);
  const result = await restore(fx, backupDir);
  assert.equal(result.reasonCode, "ATTESTATION_RESTORE_REFUSED", JSON.stringify(result));
  assert.deepEqual(await digests(fx.attestDir), repaired, "the store is unchanged");
});

test("INC-378 restore refuses when the store holds a receipt the backup does not", async (context) => {
  const fx = await fixture(context);
  await segmentedStore(fx, 6);
  const extra = await sortedInsertShape(fx, "PROJECT-Z");
  const backupDir = join(fx.base, "backup");
  assert.equal((await repair(fx, [extra], backupDir)).ok, true);
  await write(fx, "PROJECT-NEWER");
  const current = await digests(fx.attestDir);
  const result = await restore(fx, backupDir);
  assert.equal(result.reasonCode, "ATTESTATION_RESTORE_REFUSED", JSON.stringify(result));
  assert.match(result.message, /1 receipt\(s\) the backup does not/u);
  assert.deepEqual(await digests(fx.attestDir), current, "the store is unchanged");
});

test("INC-378 a relocation receipt in the directory is listed by verify and left alone by repair and restore", async (context) => {
  const fx = await fixture(context);
  await segmentedStore(fx, 6);
  const extra = await sortedInsertShape(fx, "PROJECT-Z");
  const name = `${sha256("relocation").slice(0, 24)}-adopt.json`;
  const bytes = canonicalJson({ schemaVersion: "tcrn.relocation-attestation.v1", hop: 1 });
  await writeFile(join(fx.attestDir, name), bytes, "utf8");
  const found = await verify(fx);
  assert.deepEqual(found.value.otherFiles, [{ name, bytes: Buffer.byteLength(bytes, "utf8"), sha256: sha256(bytes) }]);

  const backupDir = join(fx.base, "backup");
  assert.equal((await repair(fx, [extra], backupDir)).ok, true);
  assert.equal(await readFile(join(fx.attestDir, name), "utf8"), bytes);
  const backupManifest = JSON.parse(await readFile(join(backupDir, "backup-manifest.json"), "utf8"));
  assert.deepEqual(backupManifest.files.find((entry) => entry.name === name), { name, bytes: Buffer.byteLength(bytes, "utf8"), sha256: sha256(bytes), copied: false });
  assert.equal((await readdir(backupDir)).includes(name), false, "it is named in the backup, not copied");
  assert.equal((await restore(fx, backupDir)).ok, true);
  assert.equal(await readFile(join(fx.attestDir, name), "utf8"), bytes);
  assert.deepEqual((await verify(fx)).value.otherFiles.map((file) => file.name), [name]);
});
