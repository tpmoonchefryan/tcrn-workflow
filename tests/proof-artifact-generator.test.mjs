// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { ProofArtifactError, generateProofArtifacts } from "../scripts/lib/proof-artifacts.mjs";

const routeFiles = [
  "scripts/generate-proof-artifacts.mjs",
  "scripts/dependency-materialization.mjs",
  "scripts/lib/dependency-materialization.mjs",
  "scripts/lib/local-command.mjs",
  "scripts/lib/p8-workflow-rc.mjs",
  "scripts/lib/proof-artifacts.mjs",
  "scripts/lib/p8-workflow-rc.mjs",
  "docs/releases/0.1.0-rc.2.md",
  "docs/releases/0.1.0-rc.3.md",
  "docs/releases/0.1.0-rc.4.md",
  "tests/ci-bootstrap.test.mjs",
  "scripts/lib/scoped-strip-types.mjs",
  "scripts/test-controller-bootstrap.mjs",
  "scripts/test-controller-child-policy.mjs",
  "scripts/test-controller-reaper.mjs",
  "tests/dependency-materialization.test.mjs",
  "tests/local-command-byte-fidelity.test.mjs",
  "tests/output-session-lifecycle.test.mjs",
  "tests/proof-artifact-generator.test.mjs",
  "tests/p8-workflow-rc.test.mjs",
  "tests/p8-workflow-rc.test.mjs",
  "scripts/regen-rc1-inputs.mjs",
  "scripts/lib/rc1-inputs.mjs",
  "tests/regen-rc1-inputs.test.mjs",
  "docs/hardening/rc1-map-regeneration.md",
  "docs/activation/activation-ladder-v1.md",
  "docs/adr/0002-snapshot-not-mirror-backup.md",
  "packages/core/src/actor-attestation.ts",
  "tests/actor-attestation.test.mjs",
  "tests/p3-cli-read-surface.test.mjs",
  "tests/p3-cli-catalog.test.mjs",
  "packages/core/src/workspace-perf-instrumentation.ts",
  "tests/p3-engine-complexity.test.mjs",
  "tests/workspace-extension-records.test.mjs",
  "packages/core/src/workspace-snapshot.ts",
  "packages/core/schema/workspace-snapshot-manifest-v1.schema.json",
  "tests/backup-snapshot.test.mjs",
  "docs/architecture/backup-git-tier.md",
  "docs/architecture/backup-restore-runbook.md",
  "docs/architecture/agent-integration-v1.md",
  "packages/core/src/claude-adapter-installer.ts",
  "tests/act1-claude-installer.test.mjs",
  "packages/core/src/claude-adapter-activation.ts",
  "packages/core/src/claude-adapter-session-start.ts",
  "tests/act2-claude-activation.test.mjs",
  "packages/core/src/persona-render.ts",
  "tests/act3-persona-render.test.mjs",
  "docs/2026-07-17-p3-compaction-deferral-decision.md",
  "docs/tutorial/governed-loop.md",
  "tests/e2e-governed-loop-commands.mjs",
  "tests/e2e-governed-loop.test.mjs",
];
const roles = Object.fromEntries(["platform-workflow-architect", "workflow-verification-engineer", "security-risk-reviewer", "reality-checker"].map((role) => [role, { status: "unresolved", verdict: null, basisDigest: null }]));

async function json(path, value) {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), "tcrn-proof-artifacts-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const files = {
    "package.json": "{\"name\":\"proof-fixture\"}\n",
    "extensions/aos-requirements-v1.json": "{}\n",
    "schemas/example.schema.json": "{}\n",
    "specs/example.md": "# example\n",
    "fixtures/protocol/example.json": "{}\n",
    "scripts/generate-proof-artifacts.mjs": "// route fixture\n",
    "scripts/dependency-materialization.mjs": "// route fixture\n",
    "scripts/lib/dependency-materialization.mjs": "// route fixture\n",
    "scripts/lib/local-command.mjs": "// route fixture\n",
    "scripts/lib/p8-workflow-rc.mjs": "// route fixture\n",
    "scripts/lib/proof-artifacts.mjs": "// route fixture\n",
    "scripts/lib/p8-workflow-rc.mjs": "// route fixture\n",
    "docs/releases/0.1.0-rc.2.md": "# historical release fixture\n",
    "docs/releases/0.1.0-rc.3.md": "# historical release fixture\n",
    "docs/releases/0.1.0-rc.4.md": "# release fixture\n",
    "tests/ci-bootstrap.test.mjs": "// route fixture\n",
    "scripts/lib/scoped-strip-types.mjs": "// route fixture\n",
    "scripts/test-controller-bootstrap.mjs": "// route fixture\n",
    "scripts/test-controller-child-policy.mjs": "// route fixture\n",
    "scripts/test-controller-reaper.mjs": "// route fixture\n",
    "tests/output-session-lifecycle.test.mjs": "// route fixture\n",
    "tests/dependency-materialization.test.mjs": "// route fixture\n",
    "tests/local-command-byte-fidelity.test.mjs": "// route fixture\n",
    "tests/proof-artifact-generator.test.mjs": "// route fixture\n",
    "tests/p8-workflow-rc.test.mjs": "// route fixture\n",
    "scripts/regen-rc1-inputs.mjs": "// route fixture\n",
    "scripts/lib/rc1-inputs.mjs": "// route fixture\n",
    "tests/regen-rc1-inputs.test.mjs": "// route fixture\n",
    "docs/hardening/rc1-map-regeneration.md": "# route fixture\n",
    "docs/activation/activation-ladder-v1.md": "# route fixture\n",
    "docs/adr/0002-snapshot-not-mirror-backup.md": "# route fixture\n",
    "packages/core/src/actor-attestation.ts": "// route fixture\n",
    "tests/actor-attestation.test.mjs": "// route fixture\n",
    "tests/p3-cli-read-surface.test.mjs": "// route fixture\n",
    "tests/p3-cli-catalog.test.mjs": "// route fixture\n",
    "packages/core/src/workspace-perf-instrumentation.ts": "// route fixture\n",
    "tests/p3-engine-complexity.test.mjs": "// route fixture\n",
    "tests/workspace-extension-records.test.mjs": "// route fixture\n",
    "packages/core/src/workspace-snapshot.ts": "// route fixture\n",
    "packages/core/schema/workspace-snapshot-manifest-v1.schema.json": "{}\n",
    "tests/backup-snapshot.test.mjs": "// route fixture\n",
    "docs/architecture/backup-git-tier.md": "# route fixture\n",
    "docs/architecture/backup-restore-runbook.md": "# route fixture\n",
    "docs/architecture/agent-integration-v1.md": "# route fixture\n",
    "packages/core/src/claude-adapter-installer.ts": "// route fixture\n",
    "tests/act1-claude-installer.test.mjs": "// route fixture\n",
    "packages/core/src/claude-adapter-activation.ts": "// route fixture\n",
    "packages/core/src/claude-adapter-session-start.ts": "// route fixture\n",
    "tests/act2-claude-activation.test.mjs": "// route fixture\n",
    "packages/core/src/persona-render.ts": "// route fixture\n",
    "tests/act3-persona-render.test.mjs": "// route fixture\n",
    "docs/2026-07-17-p3-compaction-deferral-decision.md": "# route fixture\n",
    "docs/tutorial/governed-loop.md": "# route fixture\n",
    "tests/e2e-governed-loop-commands.mjs": "// route fixture\n",
    "tests/e2e-governed-loop.test.mjs": "// route fixture\n",
  };
  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(resolve(root, path, ".."), { recursive: true });
    await writeFile(resolve(root, path), bytes, { mode: 0o600 });
  }
  const allowedFiles = [
    "package.json", "extensions/aos-requirements-v1.json", "schemas/example.schema.json", "specs/example.md", "fixtures/protocol/example.json",
    "scripts/policy/rc1-inputs.json", "scripts/policy/source-allowlist.json", "verification-map.yaml", "fixtures/rc1/rc1-candidate-proof-manifest.json",
  ].sort();
  await json(resolve(root, "scripts/policy/source-allowlist.json"), { allowedFiles });
  await json(resolve(root, "scripts/policy/rc1-inputs.json"), {
    normativeInputs: ["extensions/aos-requirements-v1.json", "fixtures/protocol/example.json", "schemas/example.schema.json", "specs/example.md", "verification-map.yaml"].sort(),
  });
  const claim = {
    id: "FIXTURE", phase: "P1", category: "framework-hygiene", status: "implemented", subject: "fixture", command: "pnpm test", fixturePaths: ["package.json"], fixtureDigest: "0".repeat(64),
    environment: { node: "24.16.0", pnpm: "11.3.0", network: "offline" }, expectedExit: 0, expectedReasonCode: "FIXTURE", evidencePath: "dist/evidence.json", invalidationTriggers: ["fixture"],
  };
  const planned = { ...claim, id: "PLANNED", status: "planned", fixtureDigest: null };
  await json(resolve(root, "verification-map.yaml"), { schemaVersion: "tcrn.verification-map.v1", claims: [claim, planned] });
  await json(resolve(root, "fixtures/rc1/rc1-candidate-proof-manifest.json"), {
    schemaVersion: "tcrn.rc1-candidate-proof-manifest.v1", status: "candidate_unreviewed", accepted: false, basisDigest: "0".repeat(64), inputs: [], roleVerdictSlots: roles,
  });
  return root;
}

function reason(code) {
  return (error) => error instanceof ProofArtifactError && error.reasonCode === code;
}

function nonDerivedClaims(map) {
  return map.claims.map(({ fixtureDigest, ...claim }) => claim);
}

test("proof-artifact generator rebuilds the exact current surfaces, checks without mutation, and is byte-idempotent", async (context) => {
  const root = await fixture(context);
  const mapPath = resolve(root, "verification-map.yaml");
  const map = JSON.parse(await readFile(mapPath, "utf8"));
  map.claims[0].fixturePaths = ["scripts/generate-proof-artifacts.mjs", "package.json"];
  await json(mapPath, map);
  const nonDerivedBefore = nonDerivedClaims(JSON.parse(await readFile(mapPath, "utf8")));
  assert.equal((await generateProofArtifacts({ root, mode: "check" })).reasonCode, "PROOF_ARTIFACTS_STALE");
  assert.equal((await generateProofArtifacts({ root, mode: "write" })).reasonCode, "PROOF_ARTIFACTS_WRITTEN");
  const paths = ["scripts/policy/source-allowlist.json", "verification-map.yaml", "fixtures/rc1/rc1-candidate-proof-manifest.json"].map((path) => resolve(root, path));
  const first = await Promise.all(paths.map((path) => readFile(path)));
  assert.deepEqual(nonDerivedClaims(JSON.parse(await readFile(mapPath, "utf8"))), nonDerivedBefore, "write mode may change only derived fixture digests and must preserve fixture-path order");
  assert.equal((await generateProofArtifacts({ root, mode: "check" })).reasonCode, "PROOF_ARTIFACTS_CURRENT");
  assert.deepEqual(await Promise.all(paths.map((path) => readFile(path))), first, "check mode must not mutate");
  assert.equal((await generateProofArtifacts({ root, mode: "write" })).reasonCode, "PROOF_ARTIFACTS_WRITTEN");
  assert.deepEqual(await Promise.all(paths.map((path) => readFile(path))), first, "second write must be idempotent");
  assert.deepEqual((await readdir(resolve(root, "scripts/policy"))).filter((entry) => entry.startsWith(".tcrn-proof-artifact-")), []);
});

test("proof-artifact generator fails closed for malformed, unknown, unsafe, duplicate, missing, unapproved, symlink, hardlink, and replacement inputs", async (context) => {
  const cases = [
    ["malformed", async (root) => writeFile(resolve(root, "verification-map.yaml"), "{\n")],
    ["unknown field", async (root) => json(resolve(root, "scripts/policy/source-allowlist.json"), { allowedFiles: [], extra: true })],
    ["traversal", async (root) => json(resolve(root, "verification-map.yaml"), { schemaVersion: "tcrn.verification-map.v1", claims: [{ id: "x", phase: "P1", category: "framework-hygiene", status: "implemented", subject: "x", command: "x", fixturePaths: ["../package.json"], fixtureDigest: "0".repeat(64), environment: { node: "x", pnpm: "x", network: "x" }, expectedExit: 0, expectedReasonCode: "x", evidencePath: "x", invalidationTriggers: ["x"] }] })],
    ["duplicate", async (root) => json(resolve(root, "verification-map.yaml"), { schemaVersion: "tcrn.verification-map.v1", claims: [{ id: "x", phase: "P1", category: "framework-hygiene", status: "implemented", subject: "x", command: "x", fixturePaths: ["package.json", "package.json"], fixtureDigest: "0".repeat(64), environment: { node: "x", pnpm: "x", network: "x" }, expectedExit: 0, expectedReasonCode: "x", evidencePath: "x", invalidationTriggers: ["x"] }] })],
    ["missing", async (root) => { await rm(resolve(root, "package.json")); }],
    ["unapproved", async (root) => writeFile(resolve(root, "unexpected.mjs"), "export {};\n")],
    ["symlink", async (root) => { await rm(resolve(root, "package.json")); await symlink("verification-map.yaml", resolve(root, "package.json")); }],
    ["hardlink", async (root) => link(resolve(root, "package.json"), resolve(root, "package-copy.json"))],
  ];
  for (const [name, mutate] of cases) {
    await context.test(name, async (caseContext) => {
      const root = await fixture(caseContext);
      await mutate(root);
      const expected = name === "symlink" ? "PROOF_ARTIFACT_SOURCE_INVALID" : undefined;
      await assert.rejects(generateProofArtifacts({ root, mode: "check" }), expected ? reason(expected) : (error) => error instanceof ProofArtifactError ||
        ["SOURCE_HARDLINK", "SOURCE_SPECIAL_FILE"].includes(error?.reasonCode));
    });
  }
  const partialRoot = await fixture(context);
  await generateProofArtifacts({ root: partialRoot, mode: "write" });
  const partialTarget = resolve(partialRoot, "verification-map.yaml");
  const partialOriginal = await readFile(partialTarget);
  await writeFile(resolve(partialRoot, "package.json"), "{\"name\":\"proof-fixture-partial\"}\n");
  await assert.rejects(generateProofArtifacts({ root: partialRoot, mode: "write", beforeRename: async ({ path }) => {
    if (path === "verification-map.yaml") throw new Error("injected pre-rename failure");
  } }), reason("PROOF_ARTIFACT_PRE_RENAME_FAILED"));
  assert.deepEqual(await readFile(partialTarget), partialOriginal, "a pre-rename failure must preserve the original target");
  assert.deepEqual((await readdir(partialRoot)).filter((entry) => entry.startsWith(".tcrn-proof-artifact-")), []);
  const root = await fixture(context);
  await generateProofArtifacts({ root, mode: "write" });
  const target = resolve(root, "verification-map.yaml");
  const original = await readFile(target);
  await writeFile(resolve(root, "package.json"), "{\"name\":\"proof-fixture-replacement\"}\n");
  const replaced = `${target}.replaced`;
  await assert.rejects(generateProofArtifacts({ root, mode: "write", beforeRename: async ({ path }) => {
    if (path !== "verification-map.yaml") return;
    await rename(target, replaced);
    await writeFile(target, "replacement\n", { mode: 0o600 });
  } }), reason("PROOF_ARTIFACT_TARGET_REPLACED"));
  assert.equal((await readFile(target, "utf8")), "replacement\n");
  assert.deepEqual(await readFile(replaced), original);
  assert.deepEqual((await readdir(root)).filter((entry) => entry.startsWith(".tcrn-proof-artifact-")), []);
});

test("proof-artifact generator check proves the repository's refreshed generated surfaces", async () => {
  assert.equal((await generateProofArtifacts({ mode: "check" })).reasonCode, "PROOF_ARTIFACTS_CURRENT");
});
