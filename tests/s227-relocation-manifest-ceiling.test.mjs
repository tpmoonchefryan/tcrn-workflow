// SPDX-License-Identifier: Apache-2.0
//
// TCRN-CROSS-STORY-227 / INC-132.
//
// The case this file exists for is not "an oversized manifest is refused". It is
// "an oversized manifest is refused BEFORE the source dies". Those are different
// claims and only the second one was ever in doubt: 0.11.10 refused too, but it
// refused after committing the vacate, leaving a workspace that no read verb would
// open and no adopt could reach. So every assertion below that matters is about the
// state of the SOURCE after the refusal, not about the refusal itself.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { canonicalRelocationAuthority, initializeWorkspace } from "../dist/build/packages/core/src/index.js";

const instant = (second) => new Date(Date.UTC(2026, 0, 1) + second * 1000).toISOString().replace(/\.\d+Z$/u, "Z");
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

async function json(args) {
  let output = "";
  await runCli(args, { write: (value) => { output += value; } });
  return JSON.parse(output);
}

async function refusal(args) {
  try {
    await runCli(args, { write() {} });
  } catch (error) {
    return error;
  }
  return assert.fail(`expected ${args[0]} to refuse`);
}

/**
 * A workspace whose control manifest is too large to ride inside a receipt.
 *
 * `--segment-events 2` is the whole trick: the manifest lists one entry per control
 * file, so a small segment size buys the entry count that a real long-lived chain
 * reaches through ordinary use. cross-project hit this at 93 files in production.
 */
async function oversizedFixture(context) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-s227-")));
  context.after(() => rm(base, { recursive: true, force: true }));
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  const destination = join(base, "dest");
  for (const kind of ["transient", "evidence-locator", "release-trust"]) await mkdir(join(destination, kind), { recursive: true });

  const workspace = join(base, "workspace");
  await initializeWorkspace({ roots, externalKey: "FIXTURE-S227", createdAt: instant(0), segmentEventLimit: 2 });

  const version = async () => (await json(["status", "--workspace", workspace])).version;
  const project = (await json(["project-create", "--workspace", workspace, "--expected-version", String(await version()),
    "--at", instant(1), "--external-key", "S227-PROJ-001", "--name", "s227", "--actor", "agent:test"])).record.id;

  const manifestBytes = async () => JSON.stringify(await json(["snapshot-manifest", "--workspace", workspace, "--at", instant(9000)])).length;
  for (let index = 1; index <= 200 && await manifestBytes() <= 8192; index += 1) {
    await json(["work-create", "--workspace", workspace, "--expected-version", String(await version()),
      "--at", instant(100 + index), "--project-id", project,
      "--external-key", `S227-INIT-${String(index).padStart(3, "0")}`, "--kind", "Initiative", "--actor", "agent:test"]);
  }
  assert.ok(await manifestBytes() > 8192, "fixture failed to exceed the protocol string limit");

  return {
    base,
    workspace,
    destination,
    toArgs: [
      "--to-framework", join(base, "framework"),
      "--to-workspace-root", join(destination, "workspace"),
      "--to-transient", join(destination, "transient"),
      "--to-evidence-locator", join(destination, "evidence-locator"),
      "--to-release-trust", join(destination, "release-trust"),
    ],
  };
}

test("S227: an oversized manifest refuses the plan and names the flag that fixes it", async (t) => {
  const fixture = await oversizedFixture(t);
  const version = (await json(["status", "--workspace", fixture.workspace])).version;
  const error = await refusal(["relocation-plan", "--workspace", fixture.workspace, "--at", instant(9100),
    "--expected-version", String(version), ...fixture.toArgs]);
  assert.equal(error.reasonCode, "WORKSPACE_RELOCATION_MANIFEST_OVERSIZED");
  assert.match(error.message, /--control-manifest-out/u);
});

test("S227: an oversized vacate refuses BEFORE the commit — the source is still live", async (t) => {
  const fixture = await oversizedFixture(t);
  const state = await json(["status", "--workspace", fixture.workspace]);
  const at = instant(9200);

  // The relocationId is only obtainable from a verb that computes it, and a permit
  // naming the wrong one is refused before anything else — which is what makes this a
  // safe way to learn it.
  const placeholder = canonicalRelocationAuthority({
    schemaVersion: "tcrn.workspace-relocation-authority.v1",
    permits: [{ actorId: "agent:test", workspaceIds: [state.workspaceId], destinations: [join(fixture.destination, "workspace")],
      basis: { headEventHash: state.headEventHash, version: state.version },
      relocationId: `relocation:${"0".repeat(24)}`, stage: "vacate" }],
  });
  const placeholderPath = join(fixture.base, "placeholder-authority.json");
  await (await import("node:fs/promises")).writeFile(placeholderPath, placeholder);
  const probe = await refusal(["relocation-vacate", "--workspace", fixture.workspace, "--at", at, "--actor", "agent:test",
    "--expected-version", String(state.version), ...fixture.toArgs,
    "--relocation-authority", placeholderPath, "--relocation-authority-digest", sha256(placeholder)]);
  const relocationId = /relocation:[a-f0-9]{24}/u.exec(probe.message)?.[0];
  assert.ok(relocationId, "the refusal must name the hop it would have taken");

  const authority = canonicalRelocationAuthority({
    schemaVersion: "tcrn.workspace-relocation-authority.v1",
    permits: [{ actorId: "agent:test", workspaceIds: [state.workspaceId], destinations: [join(fixture.destination, "workspace")],
      basis: { headEventHash: state.headEventHash, version: state.version }, relocationId, stage: "vacate" }],
  });
  const authorityPath = join(fixture.base, "vacate-authority.json");
  await (await import("node:fs/promises")).writeFile(authorityPath, authority);

  const error = await refusal(["relocation-vacate", "--workspace", fixture.workspace, "--at", at, "--actor", "agent:test",
    "--expected-version", String(state.version), ...fixture.toArgs,
    "--relocation-authority", authorityPath, "--relocation-authority-digest", sha256(authority)]);
  assert.equal(error.reasonCode, "WORKSPACE_RELOCATION_MANIFEST_OVERSIZED");

  // THE ASSERTION THIS FILE EXISTS FOR. Under 0.11.10 this read returned
  // WORKSPACE_RELOCATION_VACATED: the refusal arrived after the source was gone.
  const after = await json(["status", "--workspace", fixture.workspace]);
  assert.equal(after.reasonCode, "WORKSPACE_COMMAND_COMPLETED");
  assert.equal(after.version, state.version);
});

test("S227: with a manifest destination the whole hop completes", async (t) => {
  const fixture = await oversizedFixture(t);
  const state = await json(["status", "--workspace", fixture.workspace]);
  const at = instant(9300);
  const manifestOut = join(fixture.base, "control-manifest.json");
  const { writeFile, cp } = await import("node:fs/promises");

  const plan = await json(["relocation-plan", "--workspace", fixture.workspace, "--at", at,
    "--expected-version", String(state.version), ...fixture.toArgs, "--control-manifest-out", manifestOut]);
  assert.equal(plan.reasonCode, "WORKSPACE_RELOCATION_PLANNED");
  assert.equal(plan.controlManifestOversized, true);
  assert.equal(plan.controlManifest, undefined, "an unemittable manifest must be absent, never truncated");
  assert.equal(sha256(await readFile(manifestOut, "utf8")), plan.basis.controlManifestSha256);

  const permit = (stage) => canonicalRelocationAuthority({
    schemaVersion: "tcrn.workspace-relocation-authority.v1",
    permits: [{ actorId: "agent:test", workspaceIds: [state.workspaceId], destinations: [join(fixture.destination, "workspace")],
      basis: { headEventHash: state.headEventHash, version: state.version }, relocationId: plan.relocationId, stage }],
  });
  const vacateAuthority = permit("vacate");
  const vacatePath = join(fixture.base, "vacate.json");
  await writeFile(vacatePath, vacateAuthority);

  const vacateOut = join(fixture.base, "vacate-manifest.json");
  const receipt = await json(["relocation-vacate", "--workspace", fixture.workspace, "--at", at, "--actor", "agent:test",
    "--expected-version", String(state.version), ...fixture.toArgs,
    "--relocation-authority", vacatePath, "--relocation-authority-digest", sha256(vacateAuthority),
    "--control-manifest-out", vacateOut]);
  assert.equal(receipt.reasonCode, "WORKSPACE_RELOCATION_VACATE_COMPLETED");
  assert.equal(receipt.controlManifestOversized, true);
  assert.equal(receipt.controlManifest, undefined);
  assert.equal(sha256(await readFile(vacateOut, "utf8")), receipt.controlManifestSha256);

  // The ledger entry the vacate wrote lives in the SOURCE tree, so the copy has to be
  // taken after the vacate for the destination to carry it.
  for (const [from, to] of [[fixture.workspace, join(fixture.destination, "workspace")],
    [join(fixture.base, "transient"), join(fixture.destination, "transient")],
    [join(fixture.base, "evidence-locator"), join(fixture.destination, "evidence-locator")]]) {
    await rm(to, { recursive: true, force: true });
    await cp(from, to, { recursive: true });
  }

  const adoptAuthority = permit("adopt");
  const adoptPath = join(fixture.base, "adopt.json");
  await writeFile(adoptPath, adoptAuthority);
  const adopted = await json(["relocation-adopt", "--workspace", join(fixture.destination, "workspace"),
    "--framework", join(fixture.base, "framework"), "--transient", join(fixture.destination, "transient"),
    "--evidence-locator", join(fixture.destination, "evidence-locator"), "--release-trust", join(fixture.destination, "release-trust"),
    "--at", instant(9400), "--actor", "agent:test", "--relocation-id", plan.relocationId,
    "--control-manifest", vacateOut,
    "--relocation-authority", adoptPath, "--relocation-authority-digest", sha256(adoptAuthority)]);
  assert.equal(adopted.reasonCode, "WORKSPACE_RELOCATION_ADOPT_COMPLETED");

  const moved = await json(["status", "--workspace", join(fixture.destination, "workspace")]);
  assert.equal(moved.version, state.version);
});
