// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-380: workspace.generatedArtifactsPath accepts an absolute root and has
// a real consumer, and the consumer is a content-addressed blob store.
//
// Every workspace below is created with a NON-`FIXTURE-` externalKey on purpose. The
// retired artifact-lifecycle.ts refused to archive anything unless the key began with
// `FIXTURE-`, which made the capability real only for its own tests; a suite that reached
// for a FIXTURE- key here would pass whether or not that restriction had come back.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inflateSync } from "node:zlib";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import {
  assertGeneratedArtifactsRoot,
  initializeWorkspace,
  materializeWorkspace,
  validateWorkspace,
} from "../dist/build/packages/core/src/index.js";

const instant = (second) => `2026-09-08T04:00:${String(second).padStart(2, "0")}Z`;

async function fixture(context, suffix) {
  const base = await realpath(await mkdtemp(join(tmpdir(), `tcrn-s380-${suffix}-`)));
  context.after(() => rm(base, { recursive: true, force: true }));
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  const workspace = join(base, "workspace");
  await initializeWorkspace({ roots, externalKey: `STORY-380-${suffix}`, createdAt: instant(0), segmentEventLimit: 64 });
  // The shape Owner named: a directory under a cloud provider's mount point, outside the
  // workspace and outside the machine control home.
  const cloud = join(base, "Library", "CloudStorage", "OneDrive-Personal", "tcrn-artifacts");
  await mkdir(cloud, { recursive: true });
  return { base, workspace, cloud };
}

async function cli(args) {
  let output = "";
  await runCli(args, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

function refusal(args) {
  return runCli(args, { write() {} }).then(() => null, (error) => error?.reasonCode);
}

function setArtifactsPath(workspace, version, second, value) {
  return cli(["settings-set", "--workspace", workspace, "--expected-version", String(version), "--at", instant(second),
    "--actor", "agent:claude-opus-5", "--key", "workspace.generatedArtifactsPath", "--value", value]);
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// A deterministic 2 MiB body. Deliberately not all-zeroes: an incompressible-ish payload
// keeps the deflate assertions honest about what compression actually bought.
function twoMegabytes() {
  const bytes = Buffer.allocUnsafe(2 * 1024 * 1024);
  let state = 0x2f6e2b1;
  for (let index = 0; index < bytes.length; index += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    bytes[index] = (state >>> 16) & 0xff;
  }
  return bytes;
}

test("GWT1: an absolute generatedArtifactsPath under a cloud mount is accepted and read back", async (t) => {
  const fx = await fixture(t, "gwt1");
  const receipt = await setArtifactsPath(fx.workspace, 0, 1, fx.cloud);
  assert.equal(receipt.reasonCode, "SETTINGS_WRITE_COMMITTED");
  assert.equal(receipt.setting.value, fx.cloud);

  const catalog = await cli(["settings-catalog", "--workspace", fx.workspace]);
  const entry = catalog.settings.find((candidate) => candidate.key === "workspace.generatedArtifactsPath");
  assert.equal(entry.currentValue, fx.cloud);
  assert.equal(entry.defaultValue, ".tcrn-workflow/artifacts", "the relative default is unchanged");
});

test("GWT1: the path conditions are enforced, and each refusal names its own rule", async (t) => {
  const fx = await fixture(t, "gwt1-refusals");
  const base = ["settings-set", "--workspace", fx.workspace, "--expected-version", "0", "--at", instant(1),
    "--actor", "agent:claude-opus-5", "--key", "workspace.generatedArtifactsPath", "--value"];

  // Inside the workspace, and inside its control tree: shape rules, decided by settings.ts
  // because they are the two that mean the same thing on every machine.
  assert.equal(await refusal([...base, join(fx.workspace, "artifacts")]), "SETTINGS_VALUE_INVALID");
  assert.equal(await refusal([...base, join(fx.workspace, ".tcrn-workflow", "artifacts")]), "SETTINGS_VALUE_INVALID");
  assert.equal(await refusal([...base, `${fx.cloud}/./nested`]), "SETTINGS_VALUE_INVALID", "an unnormalized path is refused rather than normalized");

  // Absent, and a symbolic link to a real directory: filesystem rules, decided by
  // artifact-store.ts at the moment the value is declared.
  assert.equal(await refusal([...base, join(fx.base, "not-created")]), "ARTIFACT_PATH_INVALID");
  const link = join(fx.base, "linked-artifacts");
  await symlink(fx.cloud, link);
  assert.equal(await refusal([...base, link]), "ARTIFACT_PATH_INVALID");

  // A regular file where a directory was named.
  const file = join(fx.base, "not-a-directory");
  await writeFile(file, "x");
  assert.equal(await refusal([...base, file]), "ARTIFACT_PATH_INVALID");

  assert.equal((await materializeWorkspace(fx.workspace)).version, 0, "no refusal appended an event");
});

test("GWT1: the machine control home is out of bounds even when it is a real directory", async (t) => {
  const fx = await fixture(t, "gwt1-home");
  const home = join(fx.base, "home");
  const inside = join(home, ".tcrn-workflow", "artifacts");
  await mkdir(inside, { recursive: true });
  const outside = join(home, "Documents", "artifacts");
  await mkdir(outside, { recursive: true });

  const reason = await assertGeneratedArtifactsRoot(fx.workspace, inside, home).then(() => null, (error) => error?.reasonCode);
  assert.equal(reason, "ARTIFACT_PATH_INVALID");
  assert.equal(await assertGeneratedArtifactsRoot(fx.workspace, outside, home), await realpath(outside));
});

test("GWT2: artifact-put stores a 2 MB file as <sha256>.bin and records size and hash", async (t) => {
  const fx = await fixture(t, "gwt2");
  await setArtifactsPath(fx.workspace, 0, 1, fx.cloud);

  const body = twoMegabytes();
  const digest = sha256(body);
  const source = join(fx.base, "audit-report.html");
  await writeFile(source, body);

  const receipt = await cli(["artifact-put", "--workspace", fx.workspace, "--file", source, "--at", instant(2)]);
  assert.equal(receipt.reasonCode, "ARTIFACT_PUT_COMMITTED");
  assert.equal(receipt.sha256, digest);
  assert.equal(receipt.bytes, body.length);
  assert.equal(receipt.blobName, `${digest}.bin`);
  assert.equal(receipt.deduplicated, false);
  assert.deepEqual(await readdir(fx.cloud), [`${digest}.bin`], "the root holds exactly the one content-addressed blob");

  const listing = await cli(["artifact-list", "--workspace", fx.workspace]);
  assert.equal(listing.reasonCode, "ARTIFACT_LIST_READY");
  assert.equal(listing.artifacts.length, 1);
  assert.deepEqual(
    { sha256: listing.artifacts[0].sha256, bytes: listing.artifacts[0].bytes, name: listing.artifacts[0].name, present: listing.artifacts[0].present },
    { sha256: digest, bytes: body.length, name: "audit-report.html", present: true },
  );
  assert.deepEqual(listing.unindexed, []);

  // The manifest is local. It stays in the workspace control tree even though the blob
  // did not, and it records no absolute path, so the same manifest reads on another
  // machine whose cloud mount sits somewhere else.
  const manifest = JSON.parse(await readFile(join(fx.workspace, ".tcrn-workflow", "artifact-manifest.json"), "utf8"));
  assert.equal(manifest.schemaVersion, "tcrn.artifact-manifest.v1");
  assert.deepEqual(Object.keys(manifest.artifacts[0]).sort(), ["bytes", "name", "sha256", "storedAt", "storedBytes"]);
  assert.equal(JSON.stringify(manifest).includes(fx.cloud), false, "the manifest carries no local address");
});

test("GWT3: a single flipped byte in a stored blob is reported by artifact-verify", async (t) => {
  const fx = await fixture(t, "gwt3");
  await setArtifactsPath(fx.workspace, 0, 1, fx.cloud);
  const source = join(fx.base, "report.bin");
  const body = twoMegabytes();
  await writeFile(source, body);
  const { sha256: digest } = await cli(["artifact-put", "--workspace", fx.workspace, "--file", source, "--at", instant(2)]);

  const clean = await cli(["artifact-verify", "--workspace", fx.workspace]);
  assert.equal(clean.reasonCode, "ARTIFACT_VERIFIED");
  assert.equal(clean.checked, 1);
  assert.deepEqual(clean.findings, []);

  // The rewrite a sync client performs, reduced to its smallest form: one byte, same
  // length, same name. Nothing but recomputation can see it.
  const blob = join(fx.cloud, `${digest}.bin`);
  const stored = await readFile(blob);
  stored[Math.floor(stored.length / 2)] ^= 0x01;
  await writeFile(blob, stored);

  const tampered = await cli(["artifact-verify", "--workspace", fx.workspace]);
  assert.equal(tampered.reasonCode, "ARTIFACT_MISMATCH");
  assert.equal(tampered.checked, 1);
  assert.equal(tampered.findings.length, 1);
  assert.equal(tampered.findings[0].sha256, digest);
  assert.ok(["unreadable", "digest-mismatch"].includes(tampered.findings[0].finding), tampered.findings[0].finding);

  // A truncated blob is a different finding, and is caught before anything is decompressed.
  await writeFile(blob, stored.subarray(0, stored.length - 1));
  const truncated = await cli(["artifact-verify", "--workspace", fx.workspace]);
  assert.equal(truncated.findings[0].finding, "size-mismatch");

  // A blob that is gone entirely is reported, not thrown.
  await rm(blob);
  const missing = await cli(["artifact-verify", "--workspace", fx.workspace]);
  assert.equal(missing.reasonCode, "ARTIFACT_MISMATCH");
  assert.equal(missing.findings[0].finding, "missing");
  const listing = await cli(["artifact-list", "--workspace", fx.workspace]);
  assert.equal(listing.artifacts[0].present, false);
});

test("the archive is deflate, not base64: the stored bytes are compressed and inflate exactly", async (t) => {
  const fx = await fixture(t, "deflate");
  await setArtifactsPath(fx.workspace, 0, 1, fx.cloud);
  const body = Buffer.from("generated artifact line\n".repeat(40_000), "utf8");
  const source = join(fx.base, "compressible.txt");
  await writeFile(source, body);

  const receipt = await cli(["artifact-put", "--workspace", fx.workspace, "--file", source, "--at", instant(2)]);
  assert.equal(receipt.bytes, body.length);
  // The retired base64 archive expanded by a third. This one has to shrink, or "deflate"
  // is a word in a comment rather than the format on disk.
  assert.ok(receipt.storedBytes < body.length / 4, `stored ${String(receipt.storedBytes)} of ${String(body.length)}`);

  const stored = await readFile(join(fx.cloud, `${receipt.sha256}.bin`));
  assert.equal(stored.length, receipt.storedBytes);
  assert.deepEqual(inflateSync(stored), body, "the stored stream inflates to the original bytes");
  assert.equal(sha256(inflateSync(stored)), receipt.sha256, "the name is the digest of the plaintext, not of the stream");
});

test("a repeat put is deduplicated by content and leaves one manifest entry", async (t) => {
  const fx = await fixture(t, "dedup");
  await setArtifactsPath(fx.workspace, 0, 1, fx.cloud);
  const body = Buffer.from("once", "utf8");
  const first = join(fx.base, "first.txt");
  const second = join(fx.base, "second-name.txt");
  await writeFile(first, body);
  await writeFile(second, body);

  const one = await cli(["artifact-put", "--workspace", fx.workspace, "--file", first, "--at", instant(2)]);
  assert.equal(one.deduplicated, false);
  const two = await cli(["artifact-put", "--workspace", fx.workspace, "--file", second, "--at", instant(3)]);
  assert.equal(two.deduplicated, true);
  assert.equal(two.sha256, one.sha256);
  assert.equal(two.artifacts, 1);
  assert.deepEqual(await readdir(fx.cloud), [`${one.sha256}.bin`]);

  const listing = await cli(["artifact-list", "--workspace", fx.workspace]);
  assert.equal(listing.artifacts.length, 1);
  assert.equal(listing.artifacts[0].name, "second-name.txt", "the latest put names the blob");
});

test("a repeat put refuses rather than overwriting when the blob already on disk is corrupt", async (t) => {
  const fx = await fixture(t, "dedup-corrupt");
  await setArtifactsPath(fx.workspace, 0, 1, fx.cloud);
  const source = join(fx.base, "payload.txt");
  await writeFile(source, "payload");
  const { sha256: digest } = await cli(["artifact-put", "--workspace", fx.workspace, "--file", source, "--at", instant(2)]);
  await writeFile(join(fx.cloud, `${digest}.bin`), "not a deflate stream");

  const reason = await refusal(["artifact-put", "--workspace", fx.workspace, "--file", source, "--at", instant(3)]);
  assert.equal(reason, "ARTIFACT_MISMATCH");
});

test("a blob in the root that no manifest entry names is reported as unindexed, not adopted", async (t) => {
  const fx = await fixture(t, "unindexed");
  await setArtifactsPath(fx.workspace, 0, 1, fx.cloud);
  const stray = `${"a".repeat(64)}.bin`;
  await writeFile(join(fx.cloud, stray), "stray");
  const listing = await cli(["artifact-list", "--workspace", fx.workspace]);
  assert.deepEqual(listing.artifacts, []);
  assert.deepEqual(listing.unindexed, [stray]);
  const verified = await cli(["artifact-verify", "--workspace", fx.workspace]);
  assert.equal(verified.reasonCode, "ARTIFACT_VERIFIED", "verify judges what the manifest claims, not what the directory holds");
});

test("the default relative root still works and lands inside the control tree", async (t) => {
  const fx = await fixture(t, "default-root");
  const source = join(fx.base, "default.txt");
  await writeFile(source, "default root");
  const receipt = await cli(["artifact-put", "--workspace", fx.workspace, "--file", source, "--at", instant(2)]);
  assert.equal(receipt.reasonCode, "ARTIFACT_PUT_COMMITTED");
  assert.deepEqual(await readdir(join(fx.workspace, ".tcrn-workflow", "artifacts")), [`${receipt.sha256}.bin`]);
});

test("neither the chain nor the lease follows the blob: artifact-put appends no event", async (t) => {
  const fx = await fixture(t, "chain-still");
  await setArtifactsPath(fx.workspace, 0, 1, fx.cloud);
  const before = await materializeWorkspace(fx.workspace);
  const source = join(fx.base, "quiet.txt");
  await writeFile(source, "quiet");
  await cli(["artifact-put", "--workspace", fx.workspace, "--file", source, "--at", instant(2)]);

  const after = await validateWorkspace(fx.workspace);
  assert.equal(after.version, before.version, "the chain did not move");
  assert.equal(after.headEventHash, before.headEventHash);
  assert.equal((await readdir(join(fx.workspace, ".tcrn-workflow"))).includes("lease"), false, "the lease was released");
});

test("a chain carrying an absolute artifact root replays even where that directory does not exist", async (t) => {
  const fx = await fixture(t, "replay");
  await setArtifactsPath(fx.workspace, 0, 1, fx.cloud);
  // The other machine: same chain, no such mount. If the setting's admission rule asked
  // the filesystem on the replay path, this is where a portable chain would stop being
  // portable — so this test is the design decision in settings.ts, stated as a fact.
  await rm(fx.cloud, { recursive: true, force: true });
  const state = await validateWorkspace(fx.workspace);
  assert.equal(state.settings.find((entry) => entry.key === "workspace.generatedArtifactsPath").value, fx.cloud);
});
