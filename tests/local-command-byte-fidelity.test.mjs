// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LocalCommandError, runLocalCommand } from "../scripts/lib/local-command.mjs";
import {
  aggregatePrivacySurface,
  decodeGitMetadataBytes,
  decodePrivacyScanBytes,
  parseHistoricalTreePaths,
} from "../scripts/lib/privacy.mjs";

function fixtureGit(root, arguments_, { raw = false } = {}) {
  const publicEmail = ["fixture", "@", "users.noreply.github.com"].join("");
  const result = spawnSync("git", arguments_, {
    cwd: root,
    encoding: raw ? undefined : "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-07-14T00:00:00Z",
      GIT_AUTHOR_EMAIL: publicEmail,
      GIT_AUTHOR_NAME: "fixture",
      GIT_COMMITTER_DATE: "2026-07-14T00:00:00Z",
      GIT_COMMITTER_EMAIL: publicEmail,
      GIT_COMMITTER_NAME: "fixture",
    },
  });
  assert.equal(result.status, 0, `${arguments_.join(" ")}\n${result.stderr?.toString("utf8") ?? ""}`);
  assert.equal(result.stderr?.length ?? 0, 0, arguments_.join(" "));
  return raw ? result.stdout : result.stdout.trim();
}

async function gitObjectFixture(context) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tcrn-git-byte-fidelity-")));
  context.after(async () => rm(root, { recursive: true, force: true }));
  fixtureGit(root, ["init", "-q", "-b", "main"]);
  const invalidUtf8 = Buffer.from([0x66, 0x80, 0x67, 0xff, 0x0a]);
  const nulBearing = Buffer.from([0x00, 0x41, 0x00, 0x42, 0x0a]);
  const text = Buffer.from("ordinary textual Git blob\n", "utf8");
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "invalid.bin"), invalidUtf8);
  await writeFile(join(root, "nested", "nul.bin"), nulBearing);
  await writeFile(join(root, "text.txt"), text);
  fixtureGit(root, ["add", "--", "invalid.bin", "nested/nul.bin", "text.txt"]);
  fixtureGit(root, ["commit", "-q", "-m", "ordinary textual commit"]);
  fixtureGit(root, ["tag", "-a", "fixture-tag", "-m", "ordinary textual tag"]);
  return { root, invalidUtf8, nulBearing, text };
}

function independentAggregate(records) {
  const digest = createHash("sha256");
  let bytes = 0;
  const ordered = [...records].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  for (const record of ordered) {
    bytes += record.content.length;
    digest.update(Buffer.from(record.path, "utf8"));
    digest.update(Buffer.from([0]));
    digest.update(Buffer.from(String(record.content.length), "utf8"));
    digest.update(Buffer.from([0]));
    digest.update(record.content);
  }
  return { entries: ordered.length, bytes, sha256: digest.digest("hex") };
}

test("raw command capture preserves invalid UTF-8, NUL and textual Git object bytes", async (context) => {
  const fixture = await gitObjectFixture(context);
  const paths = ["invalid.bin", "nested/nul.bin", "text.txt"];
  const expected = [fixture.invalidUtf8, fixture.nulBearing, fixture.text];
  for (let index = 0; index < paths.length; index += 1) {
    const object = fixtureGit(fixture.root, ["hash-object", paths[index]]);
    const content = runLocalCommand("git", ["cat-file", "blob", object], { cwd: fixture.root, raw: true });
    assert.ok(Buffer.isBuffer(content));
    assert.deepEqual(content, expected[index]);
  }
  const invalidObject = fixtureGit(fixture.root, ["hash-object", "invalid.bin"]);
  const invalidRaw = runLocalCommand("git", ["cat-file", "blob", invalidObject], { cwd: fixture.root, raw: true });
  assert.match(decodePrivacyScanBytes(invalidRaw), /\uFFFD/u);
  assert.equal(invalidRaw.length, fixture.invalidUtf8.length);
});

test("fullHistory aggregation matches an independent raw Git-object reconstruction", async (context) => {
  const { root } = await gitObjectFixture(context);
  const objectRows = fixtureGit(root, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype) %(objectsize)"])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [object, type, size] = line.split(" ");
      return { object, type, size: Number(size) };
    });
  const actualRecords = [];
  const oracleRecords = [];
  for (const { object, type } of objectRows) {
    const path = `${type}:${object}`;
    const actual = runLocalCommand("git", ["cat-file", type, object], { cwd: root, raw: true });
    const oracle = fixtureGit(root, ["cat-file", type, object], { raw: true });
    assert.deepEqual(actual, oracle, path);
    actualRecords.push({ path, content: actual });
    oracleRecords.push({ path, content: oracle });
  }
  assert.deepEqual(new Set(objectRows.map(({ type }) => type)), new Set(["blob", "commit", "tag", "tree"]));
  const actual = aggregatePrivacySurface(actualRecords);
  const expected = independentAggregate(oracleRecords);
  assert.deepEqual(actual, expected);
  assert.equal(actual.entries, objectRows.length);
  assert.equal(actual.bytes, objectRows.reduce((total, row) => total + row.size, 0));
});

test("raw ls-tree and for-each-ref callers use explicit strict metadata decoding", async (context) => {
  const { root } = await gitObjectFixture(context);
  const treeBytes = runLocalCommand("git", ["ls-tree", "-rz", "--full-tree", "HEAD"], { cwd: root, raw: true });
  assert.ok(Buffer.isBuffer(treeBytes));
  assert.deepEqual(
    parseHistoricalTreePaths(decodeGitMetadataBytes(treeBytes, "PRIVACY_TREE_UTF8_INVALID")),
    ["invalid.bin", "nested/nul.bin", "text.txt"],
  );
  const refBytes = runLocalCommand("git", ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(upstream)"], { cwd: root, raw: true });
  assert.ok(Buffer.isBuffer(refBytes));
  const refs = decodeGitMetadataBytes(refBytes, "PRIVACY_REFS_UTF8_INVALID");
  assert.match(refs, /refs\/heads\/main\u0000[0-9a-f]{40}\u0000/u);
  assert.match(refs, /refs\/tags\/fixture-tag\u0000[0-9a-f]{40}\u0000/u);
  assert.throws(
    () => decodeGitMetadataBytes(Buffer.from([0xff]), "GIT_METADATA_UTF8_INVALID"),
    /GIT_METADATA_UTF8_INVALID/u,
  );
  assert.throws(() => parseHistoricalTreePaths("malformed"), /PRIVACY_TREE_RECORD_INVALID/u);
});

test("a capture-bound overflow is its own typed failure and does not reclassify other spawn faults", async (context) => {
  const payloadBytes = 64 * 1024;
  const emit = ["-e", `process.stdout.write(Buffer.alloc(${payloadBytes}, 0x61))`];
  // spawnSync signals a maxBuffer overflow through `error.code` while handing back a
  // truncated stdout, and `status` is 0 or null depending on child exit timing. A
  // status-only guard therefore admits a silently shortened capture as success. The
  // overflow gets its own reason code so a caller cannot mistake a bounded capture that
  // did not fit for a command that ran and failed.
  for (const maxBuffer of [payloadBytes - 1, 1]) {
    assert.throws(
      () => runLocalCommand(process.execPath, emit, { cwd: process.cwd(), raw: true, maxBuffer }),
      (error) => error instanceof LocalCommandError && error.reasonCode === "COMMAND_OUTPUT_OVERFLOW",
      `maxBuffer ${maxBuffer}`,
    );
  }
  const withinBound = runLocalCommand(process.execPath, emit, { cwd: process.cwd(), raw: true, maxBuffer: payloadBytes + 1 });
  assert.equal(withinBound.length, payloadBytes, "the same capture inside its bound stays whole");

  // The gate is ENOBUFS-specific on purpose: every other spawn-level fault keeps the
  // COMMAND_FAILED classification callers already branch on.
  const absentCwd = join(await realpath(await mkdtemp(join(tmpdir(), "tcrn-absent-cwd-"))), "gone");
  context.after(async () => rm(join(absentCwd, ".."), { recursive: true, force: true }));
  const otherFaults = [
    ["ETIMEDOUT", ["-e", "setTimeout(() => {}, 60000)"], { cwd: process.cwd(), timeout: 250 }],
    ["ENOENT", ["-e", ""], { cwd: absentCwd }],
  ];
  for (const [label, arguments_, options] of otherFaults) {
    assert.throws(
      () => runLocalCommand(process.execPath, arguments_, options),
      (error) => error instanceof LocalCommandError && error.reasonCode === "COMMAND_FAILED",
      label,
    );
  }
});

test("text behavior and stderr fail-closed semantics remain unchanged", () => {
  assert.equal(
    runLocalCommand(process.execPath, ["-e", "process.stdout.write('  text output  \\n')"], { cwd: process.cwd() }),
    "text output",
  );
  assert.deepEqual(
    runLocalCommand(process.execPath, ["-e", "process.stdout.write(Buffer.from([0x20,0x00,0xff,0x0a]))"], { cwd: process.cwd(), raw: true }),
    Buffer.from([0x20, 0x00, 0xff, 0x0a]),
  );
  for (const raw of [false, true]) {
    assert.throws(
      () => runLocalCommand(process.execPath, ["-e", "process.stderr.write('warning')"], { cwd: process.cwd(), raw }),
      (error) => error instanceof LocalCommandError && error.reasonCode === "COMMAND_UNEXPECTED_STDERR",
    );
  }
  assert.throws(
    () => runLocalCommand(process.execPath, ["-e", "process.stderr.write('failure');process.exit(2)"], { cwd: process.cwd(), raw: true }),
    (error) => error instanceof LocalCommandError && error.reasonCode === "COMMAND_FAILED",
  );
  assert.throws(
    () => runLocalCommand(process.execPath, ["-e", ""], { cwd: process.cwd(), encoding: "utf8" }),
    (error) => error instanceof LocalCommandError && error.reasonCode === "PROCESS_ENCODING_FORBIDDEN",
  );
});
