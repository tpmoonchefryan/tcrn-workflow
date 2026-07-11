// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import {
  ARTIFACT_LIMITS,
  ARTIFACT_REASON_CODES,
  ArtifactLifecycleError,
  acquireWorkspaceLease,
  applyArtifactArchive,
  artifactArchiveDryRun,
  artifactCompactDryRun,
  artifactDoctor,
  artifactSizeReport,
  assertArtifactRelativePath,
  classifyArtifact,
  createProject,
  exportWorkspace,
  initializeArtifactStore,
  initializeWorkspace,
  redactArtifactReference,
  restoreArtifactArchive,
} from "../dist/build/packages/core/src/index.js";
import {
  canonicalJson,
  canonicalSha256,
  deriveStableId,
} from "../dist/build/packages/protocol/src/index.js";

const instant = (second) => `2026-07-11T12:00:${String(second).padStart(2, "0")}Z`;
const authenticatedReference = (path) => ["https://", "user", ":", "secret", "@", "example.test", path].join("");
const ftpAuthenticatedReference = (path) => ["ftp://", "user", ":", "secret", "@", "example.test", path].join("");
const schemeRelativeAuthenticatedReference = (path) => ["//", "user", ":", "secret", "@", "example.test", path].join("");
const loopbackReferenceHost = () => ["127", "0", "0", "1"].join(".");
const loopbackReference = (path) => ["//", loopbackReferenceHost(), path].join("");
const leadingSpaceAuthenticatedReference = (path) => [" ", "//", "alice", ":", "supersecret", "@", loopbackReferenceHost(), path].join("");
const trailingSpaceAuthenticatedReference = (path) => ["//", "alice", ":", "supersecret", "@", loopbackReferenceHost(), path, " "].join("");
const unsupportedAuthenticatedReference = (path) => ["file://", "user", ":", "secret", "@", "example.test", path].join("");
const privateMachinePath = () => ["/", "Users", "/private/source.json"].join("");
const privateIdentifierReference = () => ["evidence://public/", "user", "@", "example.test/item"].join("");
const fineGrainedTokenReference = () => ["evidence://public/", "github", "_pat_", "abcdefghijklmnopqrstuvwxyz123456"].join("");

async function artifactFixture({ disposable = true, externalKey } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-p4-artifact-")));
  const kinds = ["framework", "workspace", "transient", "evidence-locator", "release-trust"];
  const roots = [];
  for (const kind of kinds) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  const workspace = join(base, "workspace");
  await initializeWorkspace({
    roots,
    externalKey: externalKey ?? (disposable ? "FIXTURE-ARTIFACT-LIFECYCLE" : "LIVE-LIKE-ARTIFACT-LIFECYCLE"),
    createdAt: instant(0),
    segmentEventLimit: 64,
  });
  const lease = await acquireWorkspaceLease(workspace, { now: instant(1) });
  let state;
  try {
    state = await createProject(workspace, lease, {
      expectedVersion: 0,
      occurredAt: instant(1),
      externalKey: "FIXTURE-ARTIFACT-PROJECT",
      name: "Artifact Fixture",
    });
  } finally {
    await lease.release();
  }
  const marker = await initializeArtifactStore(workspace, { disposable });
  const store = join(workspace, ".tcrn-workflow", "artifacts");
  return {
    base,
    workspace,
    store,
    state,
    marker,
    async close() {
      await rm(base, { recursive: true, force: true });
    },
  };
}

function artifactRecord(marker, key, kind, options = {}) {
  const terminal = ["terminal-state", "decision", "gate", "acceptance"].includes(kind);
  return {
    schemaVersion: "tcrn.artifact-record.v1",
    id: deriveStableId("artifact", key),
    kind,
    state: options.state ?? (terminal ? "terminal" : "active"),
    reference: options.reference ?? `evidence://fixture/${key.toLowerCase()}`,
    byteSize: options.byteSize ?? 128,
    sha256: canonicalSha256({ key, payload: "fixture-reference-only" }),
    createdAt: options.createdAt ?? instant(2),
    eventHighWaterDigest: marker.eventHighWaterDigest,
  };
}

async function writeRecord(fixture, record) {
  const path = join(fixture.store, "records", `${record.id}.json`);
  await writeFile(path, canonicalJson(record), { flag: "wx", mode: 0o600 });
  return path;
}

async function seedLifecycle(fixture) {
  const definitions = [
    ["ARTIFACT-ACTIVE", "artifact", { byteSize: 256 }],
    ["TERMINAL-STATE", "terminal-state", { byteSize: 64 }],
    ["DECISION", "decision", { byteSize: 32 }],
    ["GATE", "gate", { byteSize: 32 }],
    ["ACCEPTANCE", "acceptance", { byteSize: 32 }],
    ["EVIDENCE-REFERENCE", "evidence-reference", { byteSize: 128 }],
    ["RECEIPT-RECORD", "receipt", { byteSize: 16 }],
    ["CACHE-RECORD", "cache", { byteSize: 16 }],
  ];
  const records = [];
  for (const [key, kind, options] of definitions) {
    const record = artifactRecord(fixture.marker, key, kind, options);
    await writeRecord(fixture, record);
    records.push(record);
  }
  await writeFile(join(fixture.store, "transient", "receipts", "command.receipt"), "receipt\n", { flag: "wx" });
  await writeFile(join(fixture.store, "transient", "cache", "projection.cache"), "cache\n", { flag: "wx" });
  return records;
}

async function expectReason(reasonCode, operation) {
  await assert.rejects(operation, (error) => error?.reasonCode === reasonCode, reasonCode);
}

function settle(operation) {
  return operation.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
}

async function recordSnapshot(fixture) {
  const root = join(fixture.store, "records");
  const names = (await readdir(root)).sort();
  const entries = [];
  for (const name of names) {
    const bytes = await readFile(join(root, name));
    entries.push({ name, bytes: bytes.toString("base64"), sha256: canonicalSha256(bytes.toString("base64")) });
  }
  return { names, entries, digest: canonicalSha256(entries) };
}

test("artifact lifecycle classification and reference redaction are closed and deterministic", () => {
  assert.ok(ARTIFACT_REASON_CODES.includes("ARTIFACT_INPUT_INVALID"));
  assert.equal(classifyArtifact("artifact"), "authoritative-artifact");
  assert.equal(classifyArtifact("receipt"), "transient-receipt");
  assert.equal(classifyArtifact("cache"), "transient-cache");
  assert.equal(
    redactArtifactReference(authenticatedReference("/evidence?id=private#token")),
    "https://example.test/evidence",
  );
  assert.equal(redactArtifactReference(ftpAuthenticatedReference("/evidence?id=private#token")), "ftp://example.test/evidence");
  assert.equal(redactArtifactReference(schemeRelativeAuthenticatedReference("/evidence?id=private#token")), "//example.test/evidence");
  assert.equal(redactArtifactReference(leadingSpaceAuthenticatedReference("/path")), loopbackReference("/path"));
  assert.equal(redactArtifactReference(trailingSpaceAuthenticatedReference("/path")), loopbackReference("/path"));
  for (const whitespace of ["\t", "\n", "\r", "\f", "\v"]) {
    assert.throws(() => redactArtifactReference(`${whitespace}${schemeRelativeAuthenticatedReference("/path")}`),
      (error) => error?.reasonCode === "ARTIFACT_INPUT_INVALID");
  }
  assert.throws(() => redactArtifactReference(unsupportedAuthenticatedReference("/evidence")),
    (error) => error?.reasonCode === "ARTIFACT_INPUT_INVALID");
  assert.equal(redactArtifactReference("evidence://public/item?credential=secret#fragment"), "evidence://public/item");
  assert.equal(redactArtifactReference(privateMachinePath()), "[redacted-private-path]");
  assert.equal(redactArtifactReference(privateIdentifierReference()), "evidence://public/[redacted-private-identifier]/item");
  assert.equal(redactArtifactReference(fineGrainedTokenReference()), "evidence://public/[redacted-credential]");
  assert.throws(() => classifyArtifact("knowledge-body"), (error) => error?.reasonCode === "ARTIFACT_INPUT_INVALID");
  assert.throws(() => assertArtifactRelativePath("../escape"), (error) => error?.reasonCode === "ARTIFACT_PATH_INVALID");
  assert.throws(() => assertArtifactRelativePath("a\\b"), (error) => error?.reasonCode === "ARTIFACT_PATH_INVALID");
});

test("closed schema, size report, doctor budgets, and compact projection preserve durable records without mutation", async () => {
  const fixture = await artifactFixture();
  try {
    const schema = JSON.parse(await readFile(new URL("../packages/core/schema/artifact-lifecycle-v1.schema.json", import.meta.url), "utf8"));
    const ajv = new Ajv2020({ strict: true, validateFormats: false });
    ajv.addKeyword({ keyword: "x-tcrn-storageLimits", schemaType: "object" });
    assert.deepEqual(schema["x-tcrn-storageLimits"], ARTIFACT_LIMITS);
    const records = await seedLifecycle(fixture);
    for (const record of records) {
      assert.equal(ajv.validate(schema, record), true, JSON.stringify(ajv.errors));
    }
    const before = await recordSnapshot(fixture);
    const report1 = await artifactSizeReport(fixture.workspace);
    const report2 = await artifactSizeReport(fixture.workspace);
    assert.deepEqual(report1, report2);
    assert.equal(report1.reasonCode, "ARTIFACT_SIZE_REPORT_READY");
    assert.equal(report1.totals.count, 10);
    assert.equal(report1.categories["protected-record"].count, 4);
    assert.equal(report1.categories["transient-receipt"].count, 2);
    assert.equal(report1.categories["transient-cache"].count, 2);
    assert.deepEqual(report1.archiveStorage, {
      generationCount: 0,
      storedBytes: 0,
      maximumGenerations: ARTIFACT_LIMITS.maximumArchiveGenerations,
      maximumStoredBytes: ARTIFACT_LIMITS.maximumArchiveStoredBytes,
    });
    assert.deepEqual(report1.limits, ARTIFACT_LIMITS);
    assert.equal((await artifactDoctor(fixture.workspace, {
      warningBytes: 10_000,
      criticalBytes: 20_000,
      warningCount: 50,
      criticalCount: 100,
    })).reasonCode, "ARTIFACT_DOCTOR_OK");
    assert.equal((await artifactDoctor(fixture.workspace, {
      warningBytes: 500,
      criticalBytes: 10_000,
      warningCount: 50,
      criticalCount: 100,
    })).reasonCode, "ARTIFACT_DOCTOR_WARNING");
    assert.equal((await artifactDoctor(fixture.workspace, {
      warningBytes: 100,
      criticalBytes: 500,
      warningCount: 5,
      criticalCount: 9,
    })).reasonCode, "ARTIFACT_DOCTOR_CRITICAL");
    const compact = await artifactCompactDryRun(fixture.workspace);
    assert.equal(compact.reasonCode, "ARTIFACT_COMPACT_DRY_RUN_READY");
    assert.equal(compact.retained.length, 6);
    assert.equal(compact.dropped.length, 4);
    assert.deepEqual(compact.retained.map((entry) => entry.kind).sort(), [
      "acceptance",
      "artifact",
      "decision",
      "evidence-reference",
      "gate",
      "terminal-state",
    ]);
    assert.equal(compact.mutationApplied, false);
    assert.equal(compact.eventHighWaterDigest, fixture.marker.eventHighWaterDigest);
    assert.deepEqual(await recordSnapshot(fixture), before);
    const exported = await exportWorkspace(fixture.workspace);
    assert.equal(exported.includes("RECEIPT-RECORD"), false);
    assert.equal(exported.includes("projection.cache"), false);
    for (let index = 0; index < 64; index += 1) {
      assert.equal((await artifactCompactDryRun(fixture.workspace)).projectionDigest, compact.projectionDigest);
    }
  } finally {
    await fixture.close();
  }
});

test("governed CLI doctor, size, compact, and archive dry-run surfaces are deterministic and read-only", async () => {
  const fixture = await artifactFixture();
  try {
    await seedLifecycle(fixture);
    const commands = [
      ["artifact-size", "ARTIFACT_SIZE_REPORT_READY"],
      ["artifact-doctor", "ARTIFACT_DOCTOR_OK"],
      ["artifact-compact-dry-run", "ARTIFACT_COMPACT_DRY_RUN_READY"],
      ["artifact-archive-dry-run", "ARTIFACT_ARCHIVE_DRY_RUN_READY"],
    ];
    for (const [command, reasonCode] of commands) {
      let output = "";
      await runCli([command, "--workspace", fixture.workspace], { write: (value) => { output += value; } });
      assert.equal(JSON.parse(output).reasonCode, reasonCode);
    }
    let output = "";
    await runCli(["artifact-archive-dry-run", "--workspace", fixture.workspace], { write: (value) => { output += value; } });
    const plan = JSON.parse(output);
    output = "";
    await runCli([
      "artifact-archive-apply",
      "--workspace", fixture.workspace,
      "--expected-plan-digest", plan.planDigest,
    ], { write: (value) => { output += value; } });
    assert.equal(JSON.parse(output).reasonCode, "ARTIFACT_ARCHIVE_APPLIED");
    for (const name of await readdir(join(fixture.store, "records"))) {
      await unlink(join(fixture.store, "records", name));
    }
    output = "";
    await runCli([
      "artifact-archive-restore",
      "--workspace", fixture.workspace,
      "--archive-id", plan.archiveId,
      "--expected-plan-digest", plan.planDigest,
    ], { write: (value) => { output += value; } });
    assert.equal(JSON.parse(output).reasonCode, "ARTIFACT_ARCHIVE_RESTORED");
    await expectReason("CLI_ARGUMENT_UNKNOWN", () => runCli(
      ["artifact-size", "--workspace", fixture.workspace, "--delete", "true"],
      { write() {} },
    ));
  } finally {
    await fixture.close();
  }
});

test("archive apply and exact restore preserve high-water authority on a disposable fixture only", async () => {
  const fixture = await artifactFixture({ externalKey: "FIXTURE-ARTIFACT-ARCHIVE" });
  try {
    await seedLifecycle(fixture);
    const dryRun1 = await artifactArchiveDryRun(fixture.workspace);
    const dryRun2 = await artifactArchiveDryRun(fixture.workspace);
    assert.deepEqual(dryRun1, dryRun2);
    assert.equal(dryRun1.retained.length, 6);
    assert.equal(dryRun1.dropped.length, 4);
    const before = await recordSnapshot(fixture);
    const retainedNames = dryRun1.retained.map((entry) => `${entry.id}.json`).sort();
    const applied = await applyArtifactArchive(fixture.workspace, { expectedPlanDigest: dryRun1.planDigest });
    assert.equal(applied.reasonCode, "ARTIFACT_ARCHIVE_APPLIED");
    assert.equal(applied.entries, 6);
    assert.equal(applied.authorityMutated, false);
    assert.equal(applied.eventHighWaterDigest, fixture.marker.eventHighWaterDigest);
    const archivedSize = await artifactSizeReport(fixture.workspace);
    assert.equal(archivedSize.archiveStorage.generationCount, 1);
    assert.ok(archivedSize.archiveStorage.storedBytes > 0);
    assert.equal(archivedSize.totals.storedBytes > archivedSize.archiveStorage.storedBytes, true);
    assert.deepEqual(await recordSnapshot(fixture), before);
    await expectReason("ARTIFACT_ARCHIVE_EXISTS", () => applyArtifactArchive(
      fixture.workspace,
      { expectedPlanDigest: dryRun1.planDigest },
    ));
    for (const name of before.names) {
      await unlink(join(fixture.store, "records", name));
    }
    const restored = await restoreArtifactArchive(fixture.workspace, dryRun1.archiveId, {
      expectedPlanDigest: dryRun1.planDigest,
    });
    assert.equal(restored.reasonCode, "ARTIFACT_ARCHIVE_RESTORED");
    assert.equal(restored.restored, 6);
    assert.equal(restored.eventHighWaterDigest, fixture.marker.eventHighWaterDigest);
    const after = await recordSnapshot(fixture);
    assert.deepEqual(after.names, retainedNames);
    assert.deepEqual(
      after.entries,
      before.entries.filter((entry) => retainedNames.includes(entry.name)),
    );
    assert.equal((await readFile(join(fixture.store, "transient", "receipts", "command.receipt"), "utf8")), "receipt\n");
    assert.equal((await readFile(join(fixture.store, "transient", "cache", "projection.cache"), "utf8")), "cache\n");
    await expectReason("ARTIFACT_RESTORE_CONFLICT", () => restoreArtifactArchive(
      fixture.workspace,
      dryRun1.archiveId,
      { expectedPlanDigest: dryRun1.planDigest },
    ));
  } finally {
    await fixture.close();
  }
});

test("hierarchical URL credentials are redacted before archive apply and exact restore", async () => {
  const fixture = await artifactFixture({ externalKey: "FIXTURE-ARTIFACT-URL-REDACTION" });
  try {
    const references = [
      ftpAuthenticatedReference("/evidence?id=private#token"),
      schemeRelativeAuthenticatedReference("/evidence?id=private#token"),
      leadingSpaceAuthenticatedReference("/path"),
    ];
    const expected = ["ftp://example.test/evidence", "//example.test/evidence", loopbackReference("/path")];
    const records = [];
    for (const [index, reference] of references.entries()) {
      const record = artifactRecord(fixture.marker, `URL-REDACTION-${index}`, "artifact", {
        reference: redactArtifactReference(reference),
      });
      records.push(record);
      await writeRecord(fixture, record);
    }
    const plan = await artifactArchiveDryRun(fixture.workspace);
    await applyArtifactArchive(fixture.workspace, { expectedPlanDigest: plan.planDigest });
    const bundlePath = join(fixture.store, "archives", plan.archiveId.slice("artifact-archive:".length), "bundle.json");
    const bundleText = await readFile(bundlePath, "utf8");
    for (const reference of references) {
      assert.equal(bundleText.includes(reference), false);
    }
    for (const record of records) {
      await unlink(join(fixture.store, "records", `${record.id}.json`));
    }
    await restoreArtifactArchive(fixture.workspace, plan.archiveId, { expectedPlanDigest: plan.planDigest });
    for (const [index, record] of records.entries()) {
      const restored = JSON.parse(await readFile(join(fixture.store, "records", `${record.id}.json`), "utf8"));
      assert.equal(restored.reference, expected[index]);
      assert.equal(references.includes(restored.reference), false);
    }
  } finally {
    await fixture.close();
  }
});

test("redaction, closed records, high-water, links, special files, and replacement attacks fail closed", async () => {
  for (const [label, mutate, reasonCode] of [
    ["authenticated-url", (record) => ({ ...record, reference: authenticatedReference("/item?token=raw") }), "ARTIFACT_REDACTION_REQUIRED"],
    ["ftp-userinfo", (record) => ({ ...record, reference: ftpAuthenticatedReference("/item?token=raw") }), "ARTIFACT_REDACTION_REQUIRED"],
    ["scheme-relative-userinfo", (record) => ({ ...record, reference: schemeRelativeAuthenticatedReference("/item?token=raw") }), "ARTIFACT_REDACTION_REQUIRED"],
    ["leading-space-userinfo", (record) => ({ ...record, reference: leadingSpaceAuthenticatedReference("/path") }), "ARTIFACT_REDACTION_REQUIRED"],
    ["protected-active", (record) => ({ ...record, kind: "decision", state: "active" }), "ARTIFACT_INPUT_INVALID"],
    ["extra-field", (record) => ({ ...record, extraAuthority: true }), "ARTIFACT_INPUT_INVALID"],
  ]) {
    const fixture = await artifactFixture({ externalKey: `FIXTURE-NEGATIVE-${label.toUpperCase()}` });
    try {
      await writeRecord(fixture, mutate(artifactRecord(fixture.marker, `NEGATIVE-${label}`, "artifact")));
      await expectReason(reasonCode, () => artifactSizeReport(fixture.workspace));
    } finally {
      await fixture.close();
    }
  }

  for (const kind of ["symlink", "hardlink", "directory"]) {
    const fixture = await artifactFixture({ externalKey: `FIXTURE-LINK-${kind.toUpperCase()}` });
    try {
      const record = artifactRecord(fixture.marker, `LINK-${kind}`, "artifact");
      const target = join(fixture.store, "records", `${record.id}.json`);
      const backing = join(fixture.store, "records", `backing-${kind}`);
      await writeFile(backing, canonicalJson(record));
      if (kind === "symlink") await symlink(backing, target);
      else if (kind === "hardlink") await link(backing, target);
      else await mkdir(target);
      await expectReason(kind === "directory" ? "ARTIFACT_SPECIAL_FILE" : "ARTIFACT_LINK_UNSAFE", () => artifactSizeReport(fixture.workspace));
    } finally {
      await fixture.close();
    }
  }

  const replacement = await artifactFixture({ externalKey: "FIXTURE-SOURCE-REPLACEMENT" });
  try {
    const record = artifactRecord(replacement.marker, "REPLACEMENT", "artifact");
    const path = await writeRecord(replacement, record);
    let replaced = false;
    await expectReason("ARTIFACT_SOURCE_CHANGED", () => artifactSizeReport(replacement.workspace, {
      async beforeDescriptorReadForTest(candidate) {
        if (!replaced && candidate === path) {
          replaced = true;
          await rename(path, `${path}.old`);
          await writeFile(path, canonicalJson(record));
        }
      },
    }));
  } finally {
    await replacement.close();
  }

  const grown = await artifactFixture({ externalKey: "FIXTURE-SOURCE-GROW" });
  try {
    const record = artifactRecord(grown.marker, "GROWN", "artifact");
    const path = await writeRecord(grown, record);
    let changed = false;
    await expectReason("ARTIFACT_LIMIT_EXCEEDED", () => artifactSizeReport(grown.workspace, {
      async beforeDescriptorReadForTest(candidate) {
        if (!changed && candidate === path) {
          changed = true;
          await writeFile(path, Buffer.alloc(1_048_577));
        }
      },
    }));
  } finally {
    await grown.close();
  }

  const rewritten = await artifactFixture({ externalKey: "FIXTURE-SOURCE-SAME-INODE" });
  try {
    const record = artifactRecord(rewritten.marker, "SAME-INODE", "artifact", { byteSize: 256 });
    const path = await writeRecord(rewritten, record);
    const changedRecord = { ...record, byteSize: 257 };
    assert.equal(canonicalJson(record).length, canonicalJson(changedRecord).length);
    let changed = false;
    await expectReason("ARTIFACT_SOURCE_CHANGED", () => artifactSizeReport(rewritten.workspace, {
      async afterDescriptorOpenForTest(candidate) {
        if (!changed && candidate === path) {
          changed = true;
          await writeFile(path, canonicalJson(changedRecord));
        }
      },
    }));
  } finally {
    await rewritten.close();
  }

  const resized = await artifactFixture({ externalKey: "FIXTURE-SOURCE-POST-READ-SIZE" });
  try {
    const record = artifactRecord(resized.marker, "POST-READ-SIZE", "artifact");
    const path = await writeRecord(resized, record);
    let changed = false;
    await expectReason("ARTIFACT_SOURCE_CHANGED", () => artifactSizeReport(resized.workspace, {
      async afterDescriptorReadForTest(candidate) {
        if (!changed && candidate === path) {
          changed = true;
          await writeFile(path, `${canonicalJson(record)} `);
        }
      },
    }));
  } finally {
    await resized.close();
  }

  const highWater = await artifactFixture({ externalKey: "FIXTURE-HIGH-WATER" });
  try {
    const lease = await acquireWorkspaceLease(highWater.workspace, { now: instant(3) });
    try {
      await createProject(highWater.workspace, lease, {
        expectedVersion: 1,
        occurredAt: instant(3),
        externalKey: "FIXTURE-HIGH-WATER-SECOND",
        name: "Changed",
      });
    } finally {
      await lease.release();
    }
    await expectReason("ARTIFACT_HIGH_WATER_MISMATCH", () => artifactArchiveDryRun(highWater.workspace));
  } finally {
    await highWater.close();
  }
});

test("size/count limits and non-disposable archive admission fail closed", async () => {
  const oversized = await artifactFixture({ externalKey: "FIXTURE-OVERSIZED" });
  try {
    await writeFile(join(oversized.store, "transient", "cache", "oversized.cache"), Buffer.alloc(1_048_577));
    await expectReason("ARTIFACT_LIMIT_EXCEEDED", () => artifactSizeReport(oversized.workspace));
  } finally {
    await oversized.close();
  }

  const count = await artifactFixture({ externalKey: "FIXTURE-COUNT" });
  try {
    const root = join(count.store, "records");
    for (let index = 0; index < 1_025; index += 1) {
      await writeFile(join(root, `artifact:${index.toString(16).padStart(24, "0")}.json`), "{}");
    }
    await expectReason("ARTIFACT_LIMIT_EXCEEDED", () => artifactSizeReport(count.workspace));
  } finally {
    await count.close();
  }

  const nondisposable = await artifactFixture({ disposable: false });
  try {
    await writeRecord(nondisposable, artifactRecord(nondisposable.marker, "NONDISPOSABLE", "artifact"));
    const plan = await artifactArchiveDryRun(nondisposable.workspace);
    await expectReason("ARTIFACT_WORKSPACE_NOT_DISPOSABLE", () => applyArtifactArchive(
      nondisposable.workspace,
      { expectedPlanDigest: plan.planDigest },
    ));
  } finally {
    await nondisposable.close();
  }
});

test("transient and archive storage exhaustion fail before unbounded admission", async () => {
  const transientCount = await artifactFixture({ externalKey: "FIXTURE-TRANSIENT-COUNT" });
  try {
    const root = join(transientCount.store, "transient", "receipts");
    for (let index = 0; index <= ARTIFACT_LIMITS.maximumEntries; index += 1) {
      await writeFile(join(root, `receipt-${String(index).padStart(4, "0")}`), "");
    }
    let transientOpened = false;
    await expectReason("ARTIFACT_LIMIT_EXCEEDED", () => artifactSizeReport(transientCount.workspace, {
      async beforeDescriptorReadForTest(path) {
        if (path.includes("/transient/")) transientOpened = true;
      },
    }));
    assert.equal(transientOpened, false);
  } finally {
    await transientCount.close();
  }

  const transientBytes = await artifactFixture({ externalKey: "FIXTURE-TRANSIENT-BYTES" });
  try {
    const root = join(transientBytes.store, "transient", "cache");
    const count = Math.floor(ARTIFACT_LIMITS.maximumStoredBytes / ARTIFACT_LIMITS.maximumSourceBytes) + 1;
    for (let index = 0; index < count; index += 1) {
      await writeFile(join(root, `cache-${String(index).padStart(2, "0")}`), Buffer.alloc(ARTIFACT_LIMITS.maximumSourceBytes));
    }
    await expectReason("ARTIFACT_LIMIT_EXCEEDED", () => artifactSizeReport(transientBytes.workspace));
  } finally {
    await transientBytes.close();
  }

  const completeCount = await artifactFixture({ externalKey: "FIXTURE-ARCHIVE-GENERATION-COUNT" });
  try {
    const root = join(completeCount.store, "archives");
    for (let index = 0; index <= ARTIFACT_LIMITS.maximumArchiveGenerations; index += 1) {
      const generation = join(root, index.toString(16).padStart(24, "0"));
      await mkdir(generation);
      await writeFile(join(generation, "bundle.json"), "");
    }
    await expectReason("ARTIFACT_LIMIT_EXCEEDED", () => artifactDoctor(completeCount.workspace));
  } finally {
    await completeCount.close();
  }

  const archiveBytes = await artifactFixture({ externalKey: "FIXTURE-ARCHIVE-STORED-BYTES" });
  try {
    const root = join(archiveBytes.store, "archives");
    const perGeneration = Math.floor(ARTIFACT_LIMITS.maximumArchiveStoredBytes / 2) + 1;
    for (let index = 0; index < 2; index += 1) {
      const generation = join(root, index.toString(16).padStart(24, "0"));
      await mkdir(generation);
      await writeFile(join(generation, "bundle.json"), Buffer.alloc(perGeneration));
    }
    await expectReason("ARTIFACT_LIMIT_EXCEEDED", () => artifactSizeReport(archiveBytes.workspace));
  } finally {
    await archiveBytes.close();
  }

  const partialCount = await artifactFixture({ externalKey: "FIXTURE-ARCHIVE-PARTIAL-COUNT" });
  try {
    const root = join(partialCount.store, "archives");
    for (let index = 0; index <= ARTIFACT_LIMITS.maximumArchiveGenerations; index += 1) {
      await mkdir(join(root, index.toString(16).padStart(24, "0")));
    }
    await expectReason("ARTIFACT_LIMIT_EXCEEDED", () => artifactSizeReport(partialCount.workspace));
  } finally {
    await partialCount.close();
  }

  const partialEntries = await artifactFixture({ externalKey: "FIXTURE-ARCHIVE-PARTIAL-ENTRIES" });
  try {
    const generation = join(partialEntries.store, "archives", "f".repeat(24));
    await mkdir(generation);
    await writeFile(join(generation, "first.tmp"), "");
    await writeFile(join(generation, "second.tmp"), "");
    await expectReason("ARTIFACT_LIMIT_EXCEEDED", () => artifactSizeReport(partialEntries.workspace));
  } finally {
    await partialEntries.close();
  }
});

test("archive and restore crash/partial states remain observable and fail closed", async () => {
  for (const faultAt of ["after-archive-directory", "after-bundle-sync"]) {
    const fixture = await artifactFixture({ externalKey: `FIXTURE-ARCHIVE-${faultAt.toUpperCase()}` });
    try {
      await writeRecord(fixture, artifactRecord(fixture.marker, `ARCHIVE-${faultAt}`, "artifact"));
      const plan = await artifactArchiveDryRun(fixture.workspace);
      await expectReason("ARTIFACT_FAULT_INJECTED", () => applyArtifactArchive(fixture.workspace, {
        expectedPlanDigest: plan.planDigest,
        faultAt,
      }));
      await expectReason("ARTIFACT_PARTIAL_STATE", () => artifactDoctor(fixture.workspace));
    } finally {
      await fixture.close();
    }
  }

  const committed = await artifactFixture({ externalKey: "FIXTURE-ARCHIVE-AFTER-COMMIT" });
  try {
    await writeRecord(committed, artifactRecord(committed.marker, "ARCHIVE-COMMITTED", "artifact"));
    const plan = await artifactArchiveDryRun(committed.workspace);
    await expectReason("ARTIFACT_FAULT_INJECTED", () => applyArtifactArchive(committed.workspace, {
      expectedPlanDigest: plan.planDigest,
      faultAt: "after-bundle-commit",
    }));
    assert.equal((await artifactDoctor(committed.workspace)).reasonCode, "ARTIFACT_DOCTOR_OK");
    await expectReason("ARTIFACT_ARCHIVE_EXISTS", () => applyArtifactArchive(
      committed.workspace,
      { expectedPlanDigest: plan.planDigest },
    ));
  } finally {
    await committed.close();
  }

  for (const faultAt of ["after-restore-claim", "after-first-restore-write"]) {
    const fixture = await artifactFixture({ externalKey: `FIXTURE-RESTORE-${faultAt.toUpperCase()}` });
    try {
      const record = artifactRecord(fixture.marker, `RESTORE-${faultAt}`, "artifact");
      const path = await writeRecord(fixture, record);
      const plan = await artifactArchiveDryRun(fixture.workspace);
      await applyArtifactArchive(fixture.workspace, { expectedPlanDigest: plan.planDigest });
      await unlink(path);
      await expectReason("ARTIFACT_FAULT_INJECTED", () => restoreArtifactArchive(
        fixture.workspace,
        plan.archiveId,
        { expectedPlanDigest: plan.planDigest, faultAt },
      ));
      await expectReason("ARTIFACT_PARTIAL_STATE", () => artifactDoctor(fixture.workspace));
    } finally {
      await fixture.close();
    }
  }
});

test("malformed archive fields, base64, records, paths, and URL userinfo fail closed", async () => {
  for (const variant of ["fields", "base64", "record", "record-ftp", "record-scheme-relative", "record-leading-space", "path"]) {
    const fixture = await artifactFixture({ externalKey: `FIXTURE-ARCHIVE-INVALID-${variant.toUpperCase()}` });
    try {
      const record = artifactRecord(fixture.marker, `INVALID-${variant}`, "artifact");
      const recordPath = await writeRecord(fixture, record);
      const plan = await artifactArchiveDryRun(fixture.workspace);
      await applyArtifactArchive(fixture.workspace, { expectedPlanDigest: plan.planDigest });
      await unlink(recordPath);
      const bundlePath = join(fixture.store, "archives", plan.archiveId.slice("artifact-archive:".length), "bundle.json");
      const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
      if (variant === "fields") bundle.extraAuthority = true;
      else if (variant === "base64") bundle.entries[0].contentBase64 += "=";
      else if (variant.startsWith("record")) {
        const archived = JSON.parse(Buffer.from(bundle.entries[0].contentBase64, "base64").toString("utf8"));
        archived.reference = variant === "record-ftp" ? ftpAuthenticatedReference("/evidence?token=raw") :
          variant === "record-scheme-relative" ? schemeRelativeAuthenticatedReference("/evidence?token=raw") :
            variant === "record-leading-space" ? leadingSpaceAuthenticatedReference("/path") :
            authenticatedReference("/evidence?token=raw");
        bundle.entries[0].contentBase64 = Buffer.from(canonicalJson(archived)).toString("base64");
      }
      else bundle.entries[0].path = "../escape";
      await writeFile(bundlePath, canonicalJson(bundle));
      await expectReason(variant === "path" ? "ARTIFACT_PATH_INVALID" : "ARTIFACT_ARCHIVE_INVALID", () => restoreArtifactArchive(
        fixture.workspace,
        plan.archiveId,
        { expectedPlanDigest: plan.planDigest },
      ));
      assert.deepEqual(await readdir(join(fixture.store, "records")), []);
    } finally {
      await fixture.close();
    }
  }
});

test("archive bundle symlink, hardlink, and special-file attacks fail closed", async () => {
  for (const kind of ["symlink", "hardlink", "directory"]) {
    const fixture = await artifactFixture({ externalKey: `FIXTURE-ARCHIVE-LINK-${kind.toUpperCase()}` });
    try {
      const recordPath = await writeRecord(fixture, artifactRecord(fixture.marker, `ARCHIVE-LINK-${kind}`, "artifact"));
      const plan = await artifactArchiveDryRun(fixture.workspace);
      await applyArtifactArchive(fixture.workspace, { expectedPlanDigest: plan.planDigest });
      await unlink(recordPath);
      const archiveRoot = join(fixture.store, "archives", plan.archiveId.slice("artifact-archive:".length));
      const bundlePath = join(archiveRoot, "bundle.json");
      const backing = join(fixture.store, `bundle-${kind}.json`);
      if (kind === "symlink") {
        await rename(bundlePath, backing);
        await symlink(backing, bundlePath);
      } else if (kind === "hardlink") {
        await link(bundlePath, backing);
      } else {
        await unlink(bundlePath);
        await mkdir(bundlePath);
      }
      await expectReason(kind === "directory" ? "ARTIFACT_SPECIAL_FILE" : "ARTIFACT_LINK_UNSAFE", () => restoreArtifactArchive(
        fixture.workspace,
        plan.archiveId,
        { expectedPlanDigest: plan.planDigest },
      ));
    } finally {
      await fixture.close();
    }
  }
});

test("artifact implementation and fixtures contain no legacy source-read authority", async () => {
  const paths = [
    new URL("../packages/core/src/artifact-lifecycle.ts", import.meta.url),
    new URL("../packages/cli/src/index.ts", import.meta.url),
    new URL("../packages/core/fixtures/p4-artifact-lifecycle-cases.json", import.meta.url),
  ];
  const forbidden = [
    String.fromCharCode(86, 97, 117, 108, 116),
    String.fromCharCode(47, 102, 97, 99, 116, 115, 47),
    String.fromCharCode(47, 105, 110, 105, 116, 105, 97, 116, 105, 118, 101, 115, 47),
    String.fromCharCode(84, 67, 82, 78, 32, 87, 111, 114, 107, 102, 108, 111, 119, 47),
  ];
  for (const path of paths) {
    const source = await readFile(path, "utf8");
    for (const token of forbidden) {
      assert.equal(source.includes(token), false, `${path.pathname}:${token}`);
    }
  }
});

test("same disposable archive generation admits exactly one apply", async () => {
  const fixture = await artifactFixture({ externalKey: "FIXTURE-ARCHIVE-CONCURRENCY" });
  try {
    await writeRecord(fixture, artifactRecord(fixture.marker, "CONCURRENT-ARCHIVE", "artifact"));
    const plan = await artifactArchiveDryRun(fixture.workspace);
    const outcomes = await Promise.all([
      settle(applyArtifactArchive(fixture.workspace, { expectedPlanDigest: plan.planDigest })),
      settle(applyArtifactArchive(fixture.workspace, { expectedPlanDigest: plan.planDigest })),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    assert.equal(rejected.length, 1);
    assert.ok(["ARTIFACT_ARCHIVE_EXISTS", "ARTIFACT_PARTIAL_STATE"].includes(rejected[0].reason.reasonCode));
  } finally {
    await fixture.close();
  }
});
