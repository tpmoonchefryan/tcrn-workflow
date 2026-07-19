// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LocalCommandError, runLocalCommand } from "../scripts/lib/local-command.mjs";
import { parseGitObjectBatch, parseHistoricalTreePaths, scanPrivacyEntries } from "../scripts/lib/privacy.mjs";

const batchCheckFormat = "--batch-check=%(objectname) %(objecttype) %(objectsize)";
const batchArguments = ["cat-file", "--batch-all-objects", "--batch"];
const fixtureMaximumBytes = 64 * 1024 * 1024;

function fixtureGit(root, arguments_, { raw = false, tolerateStderr = false } = {}) {
  const publicEmail = ["fixture", "@", "users.noreply.github.com"].join("");
  const result = spawnSync("git", arguments_, {
    cwd: root,
    encoding: raw ? undefined : "utf8",
    maxBuffer: fixtureMaximumBytes,
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
  if (!tolerateStderr) {
    assert.equal(result.stderr?.length ?? 0, 0, arguments_.join(" "));
  }
  return raw ? result.stdout : result.stdout.trim();
}

async function emptyFixtureRepository(context, prefix) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  context.after(async () => rm(root, { recursive: true, force: true }));
  fixtureGit(root, ["init", "-q", "-b", "main"]);
  return root;
}

// Independent reimplementation of the length the batch pass must emit: the batch-check
// bytes are byte-for-byte the headers the batch pass repeats, plus each declared payload
// and its framing newline. Kept separate from the production computation on purpose.
function declaredBatchBytes(root) {
  const check = fixtureGit(root, ["cat-file", "--batch-all-objects", batchCheckFormat], { raw: true, tolerateStderr: true });
  let expected = check.length;
  for (const line of check.toString("utf8").split("\n")) {
    if (line === "") continue;
    const size = Number(line.split(" ")[2]);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("PRIVACY_GIT_OBJECT_INDEX_SIZE");
    expected += size + 1;
  }
  return expected;
}

async function corruptOneLooseObject(root, object) {
  const path = join(root, ".git", "objects", object.slice(0, 2), object.slice(2));
  await chmod(path, 0o644);
  await writeFile(path, Buffer.from("this is not a zlib stream"));
}

test("adversarial object-database shapes fail closed instead of shortening the scanned surface", async (context) => {
  await context.test("a symlink blob is extracted by declared length, not by delimiter", async (caseContext) => {
    const root = await emptyFixtureRepository(caseContext, "tcrn-privacy-symlink-");
    // A symlink blob's content is the raw target with no trailing newline, so a parser
    // that scanned for the framing LF instead of honouring the declared size would run
    // straight into the next object's header and lose the privacy-bearing path.
    const target = ["..", "..", "Users", "local-user", "secrets.txt"].join("/");
    await symlink(target, join(root, "link"));
    fixtureGit(root, ["add", "-A"]);
    fixtureGit(root, ["commit", "-q", "-m", "symlink fixture"]);
    const stream = fixtureGit(root, batchArguments, { raw: true });
    const records = parseGitObjectBatch(stream, declaredBatchBytes(root));
    const blob = records.find((record) => record.type === "blob");
    assert.ok(blob, "the symlink blob must be present in the batch stream");
    assert.deepEqual(blob.content, Buffer.from(target, "utf8"));
    const findings = scanPrivacyEntries(
      [{ label: blob.object, kind: "blob", content: blob.content.toString("utf8") }],
      { owner: publicIdentity.login },
    );
    assert.ok(findings.some((finding) => finding.startsWith("LOCAL_ABSOLUTE_PATH:")));
  });

  await context.test("a submodule gitlink is absent from the object database and is not claimed as scanned", async (caseContext) => {
    const root = await emptyFixtureRepository(caseContext, "tcrn-privacy-gitlink-");
    const gitlink = "b".repeat(40);
    await writeFile(join(root, "a.txt"), "content\n");
    fixtureGit(root, ["add", "-A"]);
    fixtureGit(root, ["update-index", "--add", "--cacheinfo", `160000,${gitlink},sub`]);
    fixtureGit(root, ["commit", "-q", "-m", "gitlink fixture"]);
    const records = parseGitObjectBatch(fixtureGit(root, batchArguments, { raw: true }), declaredBatchBytes(root));
    // --batch-all-objects enumerates only objects this database holds, so the gitlink
    // commit is simply absent -- the tree naming it is still scanned, and the batch pass
    // does not emit a placeholder record that would be mistaken for scanned content.
    assert.ok(records.every((record) => record.object !== gitlink));
    assert.ok(records.some((record) => record.type === "tree" && record.content.includes("sub")));
    assert.throws(
      () => runLocalCommand("git", ["cat-file", "commit", gitlink], { cwd: root, raw: true }),
      (error) => error instanceof LocalCommandError && error.reasonCode === "COMMAND_FAILED",
    );
  });

  await context.test("an oversized object database overflows the capture bound instead of truncating", async (caseContext) => {
    const root = await emptyFixtureRepository(caseContext, "tcrn-privacy-oversize-");
    await writeFile(join(root, "big.bin"), Buffer.alloc(2 * 1024 * 1024, 0x41));
    fixtureGit(root, ["add", "-A"]);
    fixtureGit(root, ["commit", "-q", "-m", "oversized fixture"]);
    const expected = declaredBatchBytes(root);
    // spawnSync's 1 MiB default silently returns a truncated stdout on overflow, which is
    // the fail-open shape: every object past the cut goes unscanned while the gate stays
    // green. The capture must instead surface a typed overflow.
    assert.throws(
      () => runLocalCommand("git", batchArguments, { cwd: root, raw: true }),
      (error) => error instanceof LocalCommandError && error.reasonCode === "COMMAND_OUTPUT_OVERFLOW",
    );
    assert.throws(
      () => runLocalCommand("git", batchArguments, { cwd: root, raw: true, maxBuffer: expected - 1 }),
      (error) => error instanceof LocalCommandError && error.reasonCode === "COMMAND_OUTPUT_OVERFLOW",
    );
    const stream = runLocalCommand("git", batchArguments, { cwd: root, raw: true, maxBuffer: expected + 1 });
    assert.equal(stream.length, expected);
    assert.ok(parseGitObjectBatch(stream, expected).some((record) => record.content.length === 2 * 1024 * 1024));
    // The exact shape an overflow hands back: a prefix that parses cleanly on its own and
    // drops everything after the cut. Only comparing against the declared total sees it.
    assert.throws(
      () => parseGitObjectBatch(stream.subarray(0, 1024 * 1024), expected),
      /PRIVACY_GIT_OBJECT_STREAM_INCOMPLETE/u,
    );
  });

  await context.test("a corrupted object degrades to a size-less record that stops the scan", async (caseContext) => {
    const root = await emptyFixtureRepository(caseContext, "tcrn-privacy-corrupt-");
    await writeFile(join(root, "a.txt"), "hello\n");
    await writeFile(join(root, "b.txt"), "world\n");
    fixtureGit(root, ["add", "-A"]);
    fixtureGit(root, ["commit", "-q", "-m", "corruption fixture"]);
    const object = fixtureGit(root, ["hash-object", "a.txt"]);
    await corruptOneLooseObject(root, object);
    // git still exits 0 on an unreadable object. It reports the failure on stderr and
    // degrades the record to a bare "<oid> missing" line carrying neither a type nor a
    // size -- in both the batch-check and the batch pass. Nothing about the exit status
    // or the surrounding framing marks the object as unscanned, so the parser has to
    // reject the header outright rather than step over it.
    const raw = spawnSync("git", batchArguments, { cwd: root, maxBuffer: fixtureMaximumBytes });
    assert.equal(raw.status, 0);
    assert.ok(raw.stderr.length > 0);
    assert.ok(raw.stdout.toString("utf8").includes(`${object} missing\n`));
    assert.throws(() => parseGitObjectBatch(raw.stdout, raw.stdout.length), /PRIVACY_GIT_OBJECT_TYPE/u);
    // The same degradation reaches the declared-length pass, where a size-less line
    // cannot contribute a length and must stop the scan instead of being skipped.
    assert.throws(() => declaredBatchBytes(root), /PRIVACY_GIT_OBJECT_INDEX_SIZE/u);
    assert.throws(
      () => runLocalCommand("git", batchArguments, { cwd: root, raw: true, maxBuffer: fixtureMaximumBytes }),
      (error) => error instanceof LocalCommandError && error.reasonCode === "COMMAND_UNEXPECTED_STDERR",
    );
  });
});

test("batch object framing is validated per record and as a whole stream", () => {
  const object = "a".repeat(40);
  const record = (type, content) => Buffer.concat([
    Buffer.from(`${object} ${type} ${content.length}\n`, "utf8"),
    content,
    Buffer.from([0x0a]),
  ]);
  const binary = Buffer.from([0x00, 0xff, 0x0a, 0x41, 0x00]);
  const stream = Buffer.concat([record("blob", binary), record("tree", Buffer.alloc(0))]);
  const parsed = parseGitObjectBatch(stream, stream.length);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0].content, binary, "an embedded framing newline must not end the record");
  assert.equal(parsed[1].content.length, 0);
  assert.throws(() => parseGitObjectBatch(stream, stream.length - 1), /PRIVACY_GIT_OBJECT_STREAM_INCOMPLETE/u);
  // A capture cut at a record boundary is the fail-open shape: it parses cleanly on its
  // own and silently drops every later object. Only the declared total exposes it.
  const cleanPrefix = stream.subarray(0, record("blob", binary).length);
  assert.equal(parseGitObjectBatch(cleanPrefix, cleanPrefix.length).length, 1);
  assert.throws(() => parseGitObjectBatch(cleanPrefix, stream.length), /PRIVACY_GIT_OBJECT_STREAM_INCOMPLETE/u);
  assert.throws(() => parseGitObjectBatch("not a buffer", 0), /PRIVACY_GIT_OBJECT_STREAM_INVALID/u);
  const declaresTooMuch = Buffer.from(`${object} blob 99\nshort\n`, "utf8");
  assert.throws(() => parseGitObjectBatch(declaresTooMuch, declaresTooMuch.length), /PRIVACY_GIT_OBJECT_TYPE/u);
  const missingFramingNewline = Buffer.from(`${object} blob 5\nshortX`, "utf8");
  assert.throws(() => parseGitObjectBatch(missingFramingNewline, missingFramingNewline.length), /PRIVACY_GIT_OBJECT_TYPE/u);
  assert.throws(
    () => parseGitObjectBatch(record("gitlink", Buffer.alloc(0)), record("gitlink", Buffer.alloc(0)).length),
    /PRIVACY_GIT_OBJECT_TYPE/u,
  );
});

const publicIdentity = {
  login: "public-contributor",
  email: ["12345+public-contributor", "@", "users.noreply.github.com"].join(""),
};

test("public Git hosting identity is allowed only in commit metadata", () => {
  const commit = `tree ${"a".repeat(40)}\nauthor ${publicIdentity.login} <${publicIdentity.email}> 1 +0000\ncommitter ${publicIdentity.login} <${publicIdentity.email}> 1 +0000\n\nmessage\n`;
  assert.deepEqual(
    scanPrivacyEntries([
      { label: "commit", kind: "commit", content: commit },
      {
        label: "origin",
        kind: "remote",
        content: `https://github.com/${publicIdentity.login}/tcrn-workflow.git`,
      },
    ], {
      owner: publicIdentity.login,
    }),
    [],
  );
  assert.match(
    scanPrivacyEntries([{ label: "source", kind: "source", content: publicIdentity.email }], {
      owner: publicIdentity.login,
    })[0],
    /EMAIL_IDENTIFIER/u,
  );
});

test("private/raw identifiers and common secret families fail closed", () => {
  const cases = [
    ["raw email", ["person", "@", "example.invalid"].join(""), "EMAIL_IDENTIFIER"],
    ["fine-grained GitHub", `github_pat_${"A".repeat(32)}`, "GITHUB_FINE_GRAINED_TOKEN"],
    ["AWS session", `ASIA${"A".repeat(16)}`, "AWS_ACCESS_KEY"],
    ["npm", `npm_${"A".repeat(36)}`, "NPM_TOKEN"],
    ["Slack", `xoxb-${"1".repeat(12)}-${"A".repeat(24)}`, "SLACK_TOKEN"],
    ["cloud", `AIza${"A".repeat(35)}`, "GOOGLE_API_KEY"],
    ["JWT", `${"eyJ"}${"A".repeat(24)}.${"B".repeat(24)}.${"C".repeat(24)}`, "JWT_TOKEN"],
    ["authenticated URL", ["https://user", ":", "password", "@", "example.invalid/path"].join(""), "AUTHENTICATED_URL"],
    ["private key", ["-----BEGIN OPENSSH", " PRIVATE KEY-----"].join(""), "PRIVATE_KEY"],
    ["customer marker", ["tenant", "-", "export.csv"].join(""), "CUSTOMER_SOURCE_MARKER"],
    ["linux home path", ["/", "home", "/", "user1", "/work"].join(""), "LINUX_HOME_PATH"],
    ["raw windows path", ["C", ":", "\\", "Users", "\\", "user1"].join(""), "WINDOWS_USER_PATH"],
  ];
  for (const [label, content, reasonCode] of cases) {
    const findings = scanPrivacyEntries([{ label, kind: "source", content }], {
      owner: publicIdentity.login,
    });
    assert.ok(findings.some((finding) => finding.startsWith(`${reasonCode}:`)), label);
  }
});

test("filenames are scanned as privacy-bearing metadata", () => {
  const findings = scanPrivacyEntries(
    [{
      label: ["customer", "-", "export.csv"].join(""),
      kind: "filename",
      content: ["customer", "-", "export.csv"].join(""),
    }],
    { owner: publicIdentity.login },
  );
  assert.ok(findings.some((finding) => finding.startsWith("CUSTOMER_SOURCE_MARKER:")));
});

test("only the exact public P3 marker contract bypasses control-path rejection", () => {
  const marker = [".", "context/platform/workflow-v3-capabilities/p3-local-work-graph.accepted.json"].join("");
  assert.deepEqual(
    scanPrivacyEntries([{ label: "contract", kind: "source", content: marker }], { owner: publicIdentity.login }),
    [],
  );
  const sibling = [".", "context/private-note.json"].join("");
  assert.ok(
    scanPrivacyEntries([{ label: "sibling", kind: "source", content: sibling }], { owner: publicIdentity.login })
      .some((finding) => finding.startsWith("CONTROL_PLANE_PATH:")),
  );
});

test("recursive historical tree records preserve privacy-bearing full paths", () => {
  assert.deepEqual(parseHistoricalTreePaths(""), []);
  assert.throws(() => parseHistoricalTreePaths("malformed"), /PRIVACY_TREE_RECORD_INVALID/u);
  const object = "a".repeat(40);
  const controlPath = `${[".", "context"].join("")}/private-note.md`;
  const machinePath = ["nested", "Users", "local-user", "cache.txt"].join("/");
  const records = [
    `100644 blob ${object}\t${controlPath}`,
    `100644 blob ${object}\t${machinePath}`,
  ].join("\0") + "\0";
  const paths = parseHistoricalTreePaths(records);
  assert.deepEqual(paths, [controlPath, machinePath]);
  const findings = scanPrivacyEntries(
    paths.map((path) => ({ label: path, kind: "filename", content: path })),
    { owner: publicIdentity.login },
  );
  assert.ok(findings.some((finding) => finding.startsWith("CONTROL_PLANE_PATH:")));
  assert.ok(findings.some((finding) => finding.startsWith("LOCAL_ABSOLUTE_PATH:")));
});
