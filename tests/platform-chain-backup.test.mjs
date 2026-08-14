// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SNAPSHOT_RETENTION,
  createSnapshot,
  encryptSnapshot,
  isSnapshotDue,
  parseArguments,
} from "../scripts/platform-chain-backup.mjs";

async function syntheticPlatform(context) {
  const root = await mkdtemp(join(tmpdir(), "tcrn-chain-backup-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".tcrn-workspace", "cross-project", "workspace"), { recursive: true });
  await writeFile(join(root, ".tcrn-workspace", "cross-project", "workspace", "marker.json"), "synthetic-chain\n");
  return root;
}

test("S272 backup CLI requires an explicit platform root and rejects extra flags", () => {
  assert.throws(() => parseArguments([]), (error) => error.reasonCode === "PLATFORM_ROOT_REQUIRED");
  assert.throws(() => parseArguments(["--platform-root", "/tmp/platform", "--shell"]), (error) => error.reasonCode === "BACKUP_ARGUMENT_INVALID");
  assert.deepEqual(parseArguments(["--platform-root", "/tmp/platform", "--if-due"]), { platformRoot: "/tmp/platform", ifDue: true });
});

test("S272 creates a tar snapshot, manifest, chain-version sidecar and local receipt", async (context) => {
  const root = await syntheticPlatform(context);
  const result = await createSnapshot(root, {
    chainVersions: [{ partition: "cross-project", version: 3543, headEventHash: "synthetic" }],
  });
  assert.equal(result.manifest.schemaVersion, "tcrn.platform-chain-snapshot.v1");
  assert.equal(result.manifest.workspaceRelative, ".tcrn-workspace");
  assert.equal(result.manifest.chainVersions[0].version, 3543);
  assert.equal(result.manifest.snapshotSha256.length, 64);
  assert.equal((await stat(result.snapshotPath)).isFile(), true);
  assert.equal((await stat(result.versionsPath)).isFile(), true);
  const receipt = JSON.parse(await readFile(join(result.archiveRoot, "local-snapshot.json"), "utf8"));
  assert.equal(receipt.ok, true);
  assert.equal(receipt.snapshotSha256, result.manifest.snapshotSha256);
  assert.equal(await isSnapshotDue(result.archiveRoot), true);
});

test("S272 retention verifies the newest snapshot before keeping fourteen", async (context) => {
  const root = await syntheticPlatform(context);
  let last;
  for (let index = 0; index < SNAPSHOT_RETENTION + 2; index += 1) {
    last = await createSnapshot(root, {
      now: `2026-08-14T00:${String(index).padStart(2, "0")}:00.000Z`,
      chainVersions: [{ partition: "cross-project", version: index, headEventHash: `synthetic-${index}` }],
    });
  }
  const entries = await (await import("node:fs/promises")).readdir(last.archiveRoot);
  const snapshots = entries.filter((entry) => entry.endsWith(".tar.gz"));
  assert.equal(snapshots.length, SNAPSHOT_RETENTION);
  assert.equal(last.rotation.retained, SNAPSHOT_RETENTION);
  assert.equal(last.rotation.removed.length, 1);
});

test("S272 uses an external gpg reference without placing encryption material in the repository", async (context) => {
  const root = await syntheticPlatform(context);
  const toolRoot = await mkdtemp(join(tmpdir(), "tcrn-chain-backup-tool-"));
  context.after(() => rm(toolRoot, { recursive: true, force: true }));
  const fakeGpg = join(toolRoot, "gpg.mjs");
  await writeFile(fakeGpg, `#!/usr/bin/env node\nimport { copyFileSync } from "node:fs";\nif (process.argv.includes("--version")) process.exit(0);\nconst output = process.argv[process.argv.indexOf("--output") + 1];\ncopyFileSync(process.argv.at(-1), output);\n`);
  await chmod(fakeGpg, 0o755);
  const phrase = join(toolRoot, "passphrase");
  await writeFile(phrase, "synthetic-secret\n", { mode: 0o600 });
  const snapshot = await createSnapshot(root, { chainVersions: [{ partition: "cross-project", version: 1 }] });
  const encrypted = await encryptSnapshot(snapshot.snapshotPath, { gpgBin: fakeGpg, passphraseFile: phrase });
  assert.equal(encrypted.method.method, "gpg");
  assert.deepEqual(await readFile(encrypted.encryptedPath), await readFile(snapshot.snapshotPath));
  await rm(encrypted.tempRoot, { recursive: true, force: true });
});
