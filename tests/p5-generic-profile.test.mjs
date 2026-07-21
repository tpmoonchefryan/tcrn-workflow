// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { appendFile, chmod, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import {
  GENERIC_PROFILE_ADMISSION_RECEIPT_VERSION,
  GENERIC_PROFILE_BASE_DIGEST,
  GENERIC_PROFILE_OPERATIONS,
  acquireWorkspaceLease,
  authorizeGenericProfileOperation,
  calculateGenericProfileAdmissionClaims,
  createProject,
  createWork,
  generateGenericStarterBundle,
  initializeWorkspace,
  readGenericProfileAdmissionReceipt,
  resolveGenericProfile,
  transitionWork,
  validateEffectiveGenericProfile,
  validateGenericProfileLayer,
  validateGenericStarterBundle,
  validateWorkspace,
} from "../dist/build/packages/core/src/index.js";
import {
  canonicalExternalKey,
  canonicalJson,
  canonicalSha256,
  compareCanonicalText,
  deriveStableId,
} from "../dist/build/packages/protocol/src/index.js";

const fixture = JSON.parse(await readFile(
  new URL("../packages/core/fixtures/p5-generic-profile-cases.json", import.meta.url),
  "utf8",
));
const clone = (value) => structuredClone(value);
const fileAuthority = (path, bytes) => ({
  expectedCanonicalPath: path,
  expectedFileSha256: createHash("sha256").update(bytes).digest("hex"),
});

function expectReason(reasonCode, operation) {
  assert.throws(operation, (error) => error?.reasonCode === reasonCode, reasonCode);
}

async function expectReasonAsync(reasonCode, operation) {
  await assert.rejects(operation, (error) => error?.reasonCode === reasonCode, reasonCode);
}

function ownerFields(workspaceId = "workspace:generic-fixture", options = {}) {
  return {
    activeBinding: {
      mode: options.mode ?? "workspace",
      workspaceId: options.workspaceId === undefined ? workspaceId : options.workspaceId,
      projectId: options.projectId ?? null,
      command: options.command ?? null,
    },
    roleReplacement: options.roleReplacement ?? null,
    projectAuthority: options.projectAuthority ?? null,
    escalationOwner: options.escalationOwner === undefined ? "owner:generic-workspace" : options.escalationOwner,
  };
}

function display(label) {
  return {
    label,
    description: `${label} inert display metadata.`,
    examples: [`${label.toLowerCase().replaceAll(" ", "-")}-example`],
    presentation: { category: "workflow", audience: "workspace-owner" },
  };
}

function overlay(layerKind, layerId, fields, options = {}) {
  const trustLevel = layerKind === "release_verified_framework_profile"
    ? "framework_profile"
    : layerKind === "imported_untrusted"
      ? "imported_untrusted"
      : "user_owned_overlay";
  return {
    schemaVersion: "tcrn.generic-profile.v1",
    layerId,
    layerKind,
    trustLevel,
    releaseVerificationDigest: layerKind === "release_verified_framework_profile"
      ? options.releaseVerificationDigest ?? "a".repeat(64)
      : null,
    fields,
  };
}

function ownerRebind(layer, replacement = layer.fields.ownerRebindOnly, options = {}) {
  return {
    schemaVersion: "tcrn.generic-profile-owner-rebind.v1",
    approved: true,
    ownerId: options.ownerId ?? "owner:generic-workspace",
    targetLayerId: options.targetLayerId ?? layer.layerId,
    replacement,
  };
}

function request(layers, options = {}) {
  return {
    schemaVersion: "tcrn.generic-profile-resolution-request.v1",
    layers,
    ownerRebind: options.ownerRebind ?? null,
  };
}

function boundRequest(workspaceId = "workspace:generic-fixture", options = {}) {
  const bundle = generateGenericStarterBundle();
  const replacement = ownerFields(workspaceId, options);
  const workspace = overlay(
    "workspace_configuration",
    "profile-layer:workspace-configuration",
    {
      ...(options.restrictOnly ? { restrictOnly: options.restrictOnly } : {}),
      ownerRebindOnly: replacement,
      displayOnly: display("Workspace Configuration"),
    },
  );
  return request([workspace, ...bundle.layers], { ownerRebind: ownerRebind(workspace, replacement) });
}

function admissionReceipt(resolutionRequest, options = {}) {
  const admittedLayers = options.admittedLayers ?? resolutionRequest.layers.filter(
    (layer) => layer.layerKind !== "framework_defaults",
  );
  const layerAdmissions = admittedLayers.map((layer) => ({
    layerDigest: canonicalSha256(layer),
    layerKind: layer.layerKind,
    trustLevel: layer.trustLevel,
    releaseVerificationDigest: layer.releaseVerificationDigest,
  })).sort((left, right) => compareCanonicalText(left.layerKind, right.layerKind) ||
    compareCanonicalText(left.layerDigest, right.layerDigest));
  let ownerRebindAdmission = null;
  if (resolutionRequest.ownerRebind !== null && options.admitOwnerRebind !== false) {
    const target = resolutionRequest.layers.find(
      (layer) => layer.layerId === resolutionRequest.ownerRebind.targetLayerId,
    );
    assert.ok(target);
    ownerRebindAdmission = {
      ownerRebindDigest: canonicalSha256(resolutionRequest.ownerRebind),
      targetLayerDigest: canonicalSha256(target),
      targetBindingDigest: canonicalSha256(resolutionRequest.ownerRebind.replacement.activeBinding),
      ownerId: resolutionRequest.ownerRebind.ownerId,
    };
  }
  const claims = options.skipClaimCalculation
    ? { requestDigest: canonicalSha256(resolutionRequest), effectiveDigest: "0".repeat(64) }
    : calculateGenericProfileAdmissionClaims(
      resolutionRequest,
      options.resolutionDisposition ?? "normal",
    );
  const basis = {
    schemaVersion: GENERIC_PROFILE_ADMISSION_RECEIPT_VERSION,
    frameworkBaseDigest: GENERIC_PROFILE_BASE_DIGEST,
    layerAdmissions,
    ownerRebindAdmission,
    governedActions: options.governedActions ?? [...GENERIC_PROFILE_OPERATIONS],
    resolutionDisposition: options.resolutionDisposition ?? "normal",
    requestDigest: options.requestDigest ?? claims.requestDigest,
    effectiveDigest: options.effectiveDigest ?? claims.effectiveDigest,
  };
  const mutated = options.mutateBasis ? options.mutateBasis(clone(basis)) : basis;
  return { ...mutated, receiptDigest: options.receiptDigest ?? canonicalSha256(mutated) };
}

async function admissionFixture(resolutionRequest, options = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "workflow-profile-admission-")));
  const path = join(directory, "admission.json");
  const document = options.document ?? admissionReceipt(resolutionRequest, options);
  const bytes = (options.transformBytes ?? ((value) => value))(canonicalJson(document));
  await writeFile(path, bytes, { encoding: "utf8", mode: 0o600 });
  const authority = options.authority ?? fileAuthority(path, bytes);
  const context = options.skipRead ? null : await readGenericProfileAdmissionReceipt(path, {
    ...options.readOptions,
    authority,
  });
  return { directory, path, document, bytes, authority, context, close: () => rm(directory, { recursive: true, force: true }) };
}

async function withAdmission(resolutionRequest, operation, options = {}) {
  const admitted = await admissionFixture(resolutionRequest, options);
  try {
    return await operation(admitted.context, admitted);
  } finally {
    await admitted.close();
  }
}

async function resolveAdmitted(resolutionRequest, options = {}) {
  return withAdmission(resolutionRequest, (context) => resolveGenericProfile(resolutionRequest, context), options);
}

function deterministicPermutations(values, maximum) {
  const result = [];
  const visit = (prefix, remaining) => {
    if (result.length >= maximum) return;
    if (remaining.length === 0) {
      result.push(prefix);
      return;
    }
    for (let index = 0; index < remaining.length; index += 1) {
      visit([...prefix, remaining[index]], [...remaining.slice(0, index), ...remaining.slice(index + 1)]);
    }
  };
  visit([], values);
  return result;
}

function fullPermutationLayers() {
  const base = generateGenericStarterBundle().layers[0];
  const release = overlay(
    "release_verified_framework_profile",
    "profile-layer:release-verified",
    { displayOnly: display("Release Display") },
  );
  const imported = overlay(
    "imported_untrusted",
    "profile-layer:imported-untrusted",
    { restrictOnly: clone(base.fields.restrictOnly) },
  );
  const replacement = ownerFields();
  const workspace = overlay(
    "workspace_configuration",
    "profile-layer:workspace-configuration",
    { ownerRebindOnly: replacement, displayOnly: display("Workspace Display") },
  );
  const project = overlay(
    "project_configuration",
    "profile-layer:project-configuration",
    { displayOnly: display("Project Display") },
  );
  const command = overlay(
    "command_override",
    "profile-layer:command-override",
    { displayOnly: display("Command Display") },
  );
  return {
    layers: [base, release, imported, workspace, project, command],
    ownerRebind: ownerRebind(workspace, replacement),
  };
}

test("starter bundle is closed, schema-valid, deterministic, inert, and base-anchored", async () => {
  const bundle1 = generateGenericStarterBundle();
  const bundle2 = generateGenericStarterBundle();
  assert.equal(canonicalJson(bundle1), canonicalJson(bundle2));
  assert.equal(bundle1.bundleDigest, canonicalSha256({
    schemaVersion: bundle1.schemaVersion,
    layers: bundle1.layers,
    starterFlow: bundle1.starterFlow,
  }));
  assert.equal(bundle1.bundleDigest, fixture.starterBundleDigest);
  assert.equal(canonicalSha256(bundle1.layers[0]), GENERIC_PROFILE_BASE_DIGEST);
  assert.equal(GENERIC_PROFILE_BASE_DIGEST, fixture.baseProfileDigest);
  assert.deepEqual(bundle1.starterFlow.map((step) => step.kind), ["Initiative", "Epic", "Story", "Subtask"]);
  const serialized = canonicalJson(bundle1);
  assert.equal(/persona|https?:\/\/|file:\/\/|\/Users\/|"(?:hooks?|models?|threadIds?)"\s*:/iu.test(serialized), false);
  assert.equal(/\$\{|\{\{|`|<\/?script/iu.test(serialized), false);

  const schema = JSON.parse(readFileSync(new URL("../packages/core/schema/generic-profile-v1.schema.json", import.meta.url), "utf8"));
  const common = JSON.parse(readFileSync(new URL("../schemas/protocol-common-v1.schema.json", import.meta.url), "utf8"));
  const ajv = new Ajv2020({ strict: true, validateFormats: false });
  ajv.addKeyword({ keyword: "x-tcrn-aos-requirementIds", schemaType: "array", valid: true });
  ajv.addSchema(common);
  ajv.addSchema(schema);
  const validateBundle = ajv.getSchema(schema.$id);
  const validateLayer = ajv.compile({ $ref: `${schema.$id}#/$defs/layer` });
  const validateRequest = ajv.compile({ $ref: `${schema.$id}#/$defs/resolutionRequest` });
  const validateReceipt = ajv.compile({ $ref: `${schema.$id}#/$defs/admissionReceipt` });
  const validateEffective = ajv.compile({ $ref: `${schema.$id}#/$defs/effectiveProfile` });
  assert.equal(validateBundle(bundle1), true, JSON.stringify(validateBundle.errors));
  assert.deepEqual(validateGenericStarterBundle(bundle1), bundle1);

  const extra = clone(bundle1);
  extra.layers[0].extraAuthority = true;
  assert.equal(validateBundle(extra), false);
  expectReason("PROFILE_UNKNOWN_FIELD", () => validateGenericStarterBundle(extra));

  const missing = clone(bundle1.layers[0]);
  delete missing.layerId;
  assert.equal(validateLayer(missing), false);
  expectReason("PROFILE_SCHEMA_INVALID", () => validateGenericProfileLayer(missing));

  const invalidBinding = clone(bundle1.layers[0]);
  invalidBinding.fields.ownerRebindOnly.activeBinding = {
    mode: "workspace",
    workspaceId: "workspace:generic-fixture",
    projectId: "project:forbidden-at-workspace-scope",
    command: null,
  };
  assert.equal(validateLayer(invalidBinding), false);
  expectReason("PROFILE_SCHEMA_INVALID", () => validateGenericProfileLayer(invalidBinding));

  const resolutionRequest = request(bundle1.layers);
  const receipt = admissionReceipt(resolutionRequest);
  const effective = await resolveAdmitted(resolutionRequest);
  assert.equal(effective.effectiveDigest, fixture.unboundEffectiveDigest);
  assert.equal(validateRequest(resolutionRequest), true, JSON.stringify(validateRequest.errors));
  assert.equal(validateReceipt(receipt), true, JSON.stringify(validateReceipt.errors));
  assert.equal(validateEffective(effective), true, JSON.stringify(validateEffective.errors));
  assert.deepEqual(validateEffectiveGenericProfile(effective), effective);
});

test("independently admitted trust, precedence, binding, and merge matrix are exact", async () => {
  const permutation = fullPermutationLayers();
  const resolutionRequest = request(permutation.layers, permutation);
  await withAdmission(resolutionRequest, async (admission) => {
    const effective = resolveGenericProfile(resolutionRequest, admission);
  assert.equal(effective.resolution, "bound");
  assert.equal(effective.displayOnly.label, "Command Display");
  assert.equal(effective.ownerRebindOnly.activeBinding.workspaceId, "workspace:generic-fixture");
  assert.deepEqual(effective.sourceLayerIds, [
    "profile-layer:generic-framework-defaults",
    "profile-layer:release-verified",
    "profile-layer:imported-untrusted",
    "profile-layer:workspace-configuration",
    "profile-layer:project-configuration",
    "profile-layer:command-override",
  ]);
  assert.deepEqual(effective.trustSummary, {
    frameworkProfiles: 2,
    userOwnedOverlays: 3,
    importedUntrusted: 1,
  });
    assert.equal(authorizeGenericProfileOperation(resolutionRequest, admission, "project.create", {
      workspaceId: "workspace:generic-fixture",
      projectId: null,
      command: null,
    }).reasonCode, "PROFILE_OPERATION_AUTHORIZED");
  });
  const bound = boundRequest();
  const boundVector = await resolveAdmitted(bound);
  assert.equal(boundVector.effectiveDigest, fixture.boundEffectiveDigest);
  assert.equal(boundVector.overlayDigest, fixture.boundOverlayDigest);
  assert.equal(boundVector.effectivePolicyDigest, fixture.boundEffectivePolicyDigest);
});

test("workspace, project, and owner-approved command bindings are exact", async () => {
  const base = generateGenericStarterBundle().layers[0];
  for (const bindingCase of [
    {
      kind: "workspace_configuration",
      id: "profile-layer:workspace-binding",
      operation: "project.create",
      replacement: ownerFields("workspace:generic-fixture"),
      context: { workspaceId: "workspace:generic-fixture", projectId: null, command: null },
    },
    {
      kind: "project_configuration",
      id: "profile-layer:project-binding",
      operation: "work.create",
      replacement: ownerFields("workspace:generic-fixture", {
        mode: "project",
        projectId: "project:generic-fixture",
        roleReplacement: "role:generic-operator",
        projectAuthority: "authority:generic-project",
      }),
      context: {
        workspaceId: "workspace:generic-fixture",
        projectId: "project:generic-fixture",
        command: null,
      },
    },
    {
      kind: "command_override",
      id: "profile-layer:command-binding",
      operation: "work.create",
      replacement: ownerFields("workspace:generic-fixture", {
        mode: "command",
        projectId: "project:generic-fixture",
        command: "work:create",
        roleReplacement: "role:generic-operator",
        projectAuthority: "authority:generic-project",
      }),
      context: {
        workspaceId: "workspace:generic-fixture",
        projectId: "project:generic-fixture",
        command: "work:create",
      },
    },
  ]) {
    const layer = overlay(bindingCase.kind, bindingCase.id, {
      ownerRebindOnly: bindingCase.replacement,
      displayOnly: display(`Bound ${bindingCase.kind}`),
    });
    const resolutionRequest = request([layer, base], { ownerRebind: ownerRebind(layer, bindingCase.replacement) });
    await withAdmission(resolutionRequest, async (admission) => {
      const effective = resolveGenericProfile(resolutionRequest, admission);
      assert.equal(authorizeGenericProfileOperation(
        resolutionRequest, admission, bindingCase.operation, bindingCase.context,
      ).reasonCode, "PROFILE_OPERATION_AUTHORIZED");
      assert.deepEqual(effective.ownerRebindOnly, bindingCase.replacement);
    });
  }
});

test("trusted admission rejects forged trust, malformed receipts, and standalone effective objects", async () => {
  const bundle = generateGenericStarterBundle();
  const base = bundle.layers[0];
  const baseRequest = request(bundle.layers);
  const workspaceReplacement = ownerFields();
  const workspace = overlay("workspace_configuration", "profile-layer:workspace-configuration", {
    ownerRebindOnly: workspaceReplacement,
  });
  const bound = request([base, workspace], { ownerRebind: ownerRebind(workspace, workspaceReplacement) });

  await withAdmission(baseRequest, async (admission) => {
    const forgedBase = clone(base);
    forgedBase.fields.ownerRebindOnly = workspaceReplacement;
    expectReason("PROFILE_FRAMEWORK_BASE_MISMATCH", () => resolveGenericProfile(request([forgedBase]), admission));
  });
  await withAdmission(bound, async (admission) => {
    expectReason("PROFILE_LAYER_UNADMITTED", () => resolveGenericProfile(bound, admission));
  }, { admittedLayers: [] });
  await withAdmission(bound, async (admission) => {
    const effective = resolveGenericProfile(bound, admission);
    const forgedEffective = clone(effective);
    forgedEffective.ownerRebindOnly.activeBinding.workspaceId = "workspace:forged";
    forgedEffective.effectivePolicyDigest = canonicalSha256({
      immutable: forgedEffective.immutable,
      restrictOnly: forgedEffective.restrictOnly,
      ownerRebindOnly: forgedEffective.ownerRebindOnly,
    });
    forgedEffective.effectiveDigest = canonicalSha256({
      schemaVersion: forgedEffective.schemaVersion,
      resolution: forgedEffective.resolution,
      immutable: forgedEffective.immutable,
      restrictOnly: forgedEffective.restrictOnly,
      ownerRebindOnly: forgedEffective.ownerRebindOnly,
      displayOnly: forgedEffective.displayOnly,
      sourceLayerIds: forgedEffective.sourceLayerIds,
      trustSummary: forgedEffective.trustSummary,
      overlayDigest: forgedEffective.overlayDigest,
      effectivePolicyDigest: forgedEffective.effectivePolicyDigest,
    });
    expectReason("PROFILE_EFFECTIVE_UNADMITTED", () => authorizeGenericProfileOperation(
      forgedEffective, admission, "project.create",
      { workspaceId: "workspace:forged", projectId: null, command: null },
    ));
  });
  await withAdmission(baseRequest, async (admission) => {
    const cold = resolveGenericProfile(baseRequest, admission);
    assert.equal(cold.resolution, "cold_standby");
    expectReason("PROFILE_COLD_STANDBY", () => authorizeGenericProfileOperation(
      baseRequest, admission, "profile.read", { workspaceId: null, projectId: null, command: null },
    ));
  }, { resolutionDisposition: "cold_standby" });

  await withAdmission(bound, async (admission) => {
    expectReason("PROFILE_OWNER_REBIND_UNADMITTED", () => resolveGenericProfile(bound, admission));
  }, { admitOwnerRebind: false });

  const release = overlay(
    "release_verified_framework_profile", "profile-layer:self-release", { displayOnly: display("Self Release") },
  );
  const releaseRequest = request([base, release]);
  await withAdmission(releaseRequest, async (admission) => {
    expectReason("PROFILE_RELEASE_UNADMITTED", () => resolveGenericProfile(releaseRequest, admission));
  }, { admittedLayers: [] });

  const malformed = await admissionFixture(baseRequest, { skipRead: true });
  try {
    const malformedBytes = "{\n";
    await writeFile(malformed.path, malformedBytes, "utf8");
    await expectReasonAsync("PROFILE_ADMISSION_MALFORMED", () => readGenericProfileAdmissionReceipt(malformed.path, {
      authority: fileAuthority(malformed.path, malformedBytes),
    }));
    const mismatched = admissionReceipt(baseRequest, { receiptDigest: "0".repeat(64) });
    const mismatchedBytes = canonicalJson(mismatched);
    await writeFile(malformed.path, mismatchedBytes, "utf8");
    await expectReasonAsync("PROFILE_ADMISSION_MISMATCH", () => readGenericProfileAdmissionReceipt(malformed.path, {
      authority: fileAuthority(malformed.path, mismatchedBytes),
    }));
    const valid = admissionReceipt(baseRequest);
    const validBytes = canonicalJson(valid);
    await writeFile(malformed.path, validBytes, "utf8");
    const hardlink = join(malformed.directory, "hardlink.json");
    await link(malformed.path, hardlink);
    await expectReasonAsync("PROFILE_ADMISSION_LINK", () => readGenericProfileAdmissionReceipt(hardlink, {
      authority: fileAuthority(hardlink, validBytes),
    }));
    await rm(hardlink);
    const symlinkPath = join(malformed.directory, "symlink.json");
    await symlink(malformed.path, symlinkPath);
    await expectReasonAsync("PROFILE_ADMISSION_LINK", () => readGenericProfileAdmissionReceipt(symlinkPath, {
      authority: fileAuthority(symlinkPath, validBytes),
    }));
    await rm(symlinkPath);
    await expectReasonAsync("PROFILE_ADMISSION_CHANGED", () => readGenericProfileAdmissionReceipt(malformed.path, {
      authority: fileAuthority(malformed.path, validBytes),
      afterLstatForTest: async () => writeFile(malformed.path, canonicalJson({ ...valid, receiptDigest: "1".repeat(64) }), "utf8"),
    }));
    await writeFile(malformed.path, validBytes, "utf8");
    await expectReasonAsync("PROFILE_ADMISSION_CHANGED", () => readGenericProfileAdmissionReceipt(malformed.path, {
      authority: fileAuthority(malformed.path, validBytes),
      afterOpenForTest: async () => writeFile(malformed.path, canonicalJson({ ...valid, receiptDigest: "2".repeat(64) }), "utf8"),
    }));
  } finally {
    await malformed.close();
  }

  const selfTrustCases = [
    "forged-bound-framework-base",
    "self-labeled-user-owned-overlay",
    "self-approved-owner-rebind",
    "self-supplied-release-digest",
    "recomputed-forged-effective-object",
  ];
  assert.deepEqual(fixture.trustAdmissionNegativeCases, selfTrustCases);
});

test("profile admission reads reject directories, mode races and unbounded growth", async () => {
  const baseRequest = request([generateGenericStarterBundle().layers[0]]);

  // A directory has nlink >= 2, so the pre-unification reader classified it as
  // PROFILE_ADMISSION_LINK. The shared reader gates isFile() before nlink, so a
  // directory now reports the special-file code (OD-6).
  const special = await admissionFixture(baseRequest);
  try {
    const directoryPath = join(special.directory, "special");
    await mkdir(directoryPath);
    await expectReasonAsync("PROFILE_ADMISSION_SPECIAL_FILE", () => readGenericProfileAdmissionReceipt(directoryPath, {
      authority: { expectedCanonicalPath: directoryPath, expectedFileSha256: special.authority.expectedFileSha256 },
    }));
  } finally { await special.close(); }

  // mode joined the descriptor identity, so a concurrent chmod is now visible.
  const modeRace = await admissionFixture(baseRequest);
  try {
    await expectReasonAsync("PROFILE_ADMISSION_CHANGED", () => readGenericProfileAdmissionReceipt(modeRace.path, {
      authority: modeRace.authority,
      afterOpenForTest: async () => { await chmod(modeRace.path, 0o640); },
    }));
  } finally { await modeRace.close(); }

  // The read is chunk-bounded rather than a single unbounded readFile().
  const sparse = await admissionFixture(baseRequest); let sparseRead = 0;
  try {
    await expectReasonAsync("PROFILE_ADMISSION_MALFORMED", () => readGenericProfileAdmissionReceipt(sparse.path, {
      authority: sparse.authority,
      afterOpenForTest: async () => { await truncate(sparse.path, 32 * 1024 * 1024); },
      observeReadBytesForTest: (bytes) => { sparseRead = bytes; },
    }));
    assert.equal(sparseRead, 65_537);
  } finally { await sparse.close(); }

  const growing = await admissionFixture(baseRequest); let growingRead = 0; let growthRounds = 0;
  try {
    await expectReasonAsync("PROFILE_ADMISSION_MALFORMED", () => readGenericProfileAdmissionReceipt(growing.path, {
      authority: growing.authority,
      observeReadBytesForTest: (bytes) => { growingRead = bytes; },
      afterReadChunkForTest: async () => { growthRounds += 1; await appendFile(growing.path, "x".repeat(16_384)); },
    }));
    assert.equal(growingRead, 65_537);
    assert.ok(growthRounds >= 4);
  } finally { await growing.close(); }
});

test("profile admission receipts require exactly one canonical terminal LF", async () => {
  const baseRequest = request([generateGenericStarterBundle().layers[0]]);
  const positive = await admissionFixture(baseRequest);
  try {
    assert.equal(positive.bytes.endsWith("\n"), true);
    assert.equal(positive.bytes.endsWith("\n\n"), false);
    assert.equal(createHash("sha256").update(positive.bytes).digest("hex"), positive.authority.expectedFileSha256);
    assert.equal(positive.context.receipt.receiptDigest, positive.document.receiptDigest);
  } finally { await positive.close(); }
  const transforms = [(bytes) => `${bytes}\n`, (bytes) => ` ${bytes}`, (bytes) => `${bytes} `];
  assert.equal(transforms.length + 1, fixture.admissionCanonicalByteCases);
  for (const transformBytes of transforms) {
    const changed = await admissionFixture(baseRequest, { skipRead: true, transformBytes });
    try {
      assert.equal(createHash("sha256").update(changed.bytes).digest("hex"), changed.authority.expectedFileSha256);
      await expectReasonAsync("PROFILE_ADMISSION_CANONICAL_INVALID", () =>
        readGenericProfileAdmissionReceipt(changed.path, { authority: changed.authority }));
    } finally { await changed.close(); }
  }
});

test("out-of-band path and digest authority rejects caller-minted admission receipts", async () => {
  assert.deepEqual(fixture.authorityAnchorNegativeCases, [
    "caller-created-canonical-receipt",
    "copied-valid-receipt-untrusted-path",
    "trusted-path-replacement",
    "attacker-selected-admission-claims",
    "missing-authority",
    "wrong-expected-digest",
    "request-effective-binding-mismatch",
  ]);
  const base = generateGenericStarterBundle().layers[0];
  const legitimateRequest = request([base]);
  const trusted = await admissionFixture(legitimateRequest, { skipRead: true });
  const attackerDirectory = await realpath(await mkdtemp(join(tmpdir(), "workflow-profile-attacker-")));
  try {
    const trustedBytes = canonicalJson(trusted.document);
    const attackerPath = join(attackerDirectory, "self-minted.json");
    const attackerReplacement = ownerFields("workspace:attacker", { escalationOwner: "owner:attacker" });
    const attackerLayer = overlay("workspace_configuration", "profile-layer:attacker", {
      ownerRebindOnly: attackerReplacement,
    });
    const attackerRequest = request([base, attackerLayer], {
      ownerRebind: ownerRebind(attackerLayer, attackerReplacement, { ownerId: "owner:attacker" }),
    });
    const attackerBytes = canonicalJson(admissionReceipt(attackerRequest));
    await writeFile(attackerPath, attackerBytes, "utf8");

    await expectReasonAsync("PROFILE_ADMISSION_AUTHORITY_REQUIRED", () =>
      readGenericProfileAdmissionReceipt(attackerPath));
    await expectReasonAsync("PROFILE_ADMISSION_AUTHORITY_REQUIRED", () => runCli([
      "profile-authorize",
      "--request", canonicalJson(attackerRequest),
      "--receipt", attackerPath,
      "--operation", "project.create",
      "--workspace-id", "workspace:attacker",
      "--project-id", "-",
      "--command", "-",
    ], { write: () => {} }));

    const copiedPath = join(attackerDirectory, "copied-valid.json");
    await writeFile(copiedPath, trustedBytes, "utf8");
    await expectReasonAsync("PROFILE_ADMISSION_AUTHORITY_PATH", () => readGenericProfileAdmissionReceipt(copiedPath, {
      authority: trusted.authority,
    }));
    await expectReasonAsync("PROFILE_ADMISSION_AUTHORITY_PATH", () => runCli([
      "profile-resolve", "--request", canonicalJson(legitimateRequest), "--receipt", copiedPath,
    ], { write: () => {}, profileAdmissionAuthority: trusted.authority }));

    await writeFile(trusted.path, attackerBytes, "utf8");
    await expectReasonAsync("PROFILE_ADMISSION_AUTHORITY_DIGEST", () => readGenericProfileAdmissionReceipt(trusted.path, {
      authority: trusted.authority,
    }));
    await expectReasonAsync("PROFILE_ADMISSION_AUTHORITY_DIGEST", () => runCli([
      "profile-authorize",
      "--request", canonicalJson(attackerRequest),
      "--receipt", trusted.path,
      "--operation", "project.create",
      "--workspace-id", "workspace:attacker",
      "--project-id", "-",
      "--command", "-",
    ], { write: () => {}, profileAdmissionAuthority: trusted.authority }));

    await writeFile(trusted.path, trustedBytes, "utf8");
    await expectReasonAsync("PROFILE_ADMISSION_AUTHORITY_DIGEST", () => readGenericProfileAdmissionReceipt(trusted.path, {
      authority: { ...trusted.authority, expectedFileSha256: "0".repeat(64) },
    }));
    const admission = await readGenericProfileAdmissionReceipt(trusted.path, { authority: trusted.authority });
    expectReason("PROFILE_ADMISSION_REQUEST_MISMATCH", () => resolveGenericProfile(attackerRequest, admission));
    const wrongEffective = admissionReceipt(legitimateRequest, { effectiveDigest: "0".repeat(64) });
    const wrongEffectiveBytes = canonicalJson(wrongEffective);
    await writeFile(trusted.path, wrongEffectiveBytes, "utf8");
    const wrongEffectiveAdmission = await readGenericProfileAdmissionReceipt(trusted.path, {
      authority: fileAuthority(trusted.path, wrongEffectiveBytes),
    });
    expectReason("PROFILE_ADMISSION_EFFECTIVE_MISMATCH", () =>
      resolveGenericProfile(legitimateRequest, wrongEffectiveAdmission));
  } finally {
    await trusted.close();
    await rm(attackerDirectory, { recursive: true, force: true });
  }
});

test("all inherited profile negative vectors remain executable", async () => {
  const bundle = generateGenericStarterBundle();
  const base = bundle.layers[0];
  const baseRequest = request([base]);
  const workspaceReplacement = ownerFields();
  const workspace = overlay("workspace_configuration", "profile-layer:workspace-negative", {
    ownerRebindOnly: workspaceReplacement,
  });
  const runResolve = async (resolutionRequest, reasonCode, options = {}) => withAdmission(
    options.admissionRequest ?? resolutionRequest,
    async (admission) => expectReason(reasonCode, () => resolveGenericProfile(resolutionRequest, admission)),
    { skipClaimCalculation: true, ...(options.receiptOptions ?? {}) },
  );
  const sync = (reasonCode, operation) => async () => expectReason(reasonCode, operation);
  const restrictedOperations = base.fields.restrictOnly.allowedOperations.filter((entry) => entry !== "project.create");
  const cases = new Map([
    ["request-unknown-field", async () => withAdmission(baseRequest, async (admission) => expectReason(
      "PROFILE_UNKNOWN_FIELD", () => resolveGenericProfile({ ...baseRequest, unexpected: true }, admission),
    ))],
    ["environment-authority-field", async () => withAdmission(baseRequest, async (admission) => expectReason(
      "PROFILE_UNKNOWN_FIELD", () => resolveGenericProfile({ ...baseRequest, environment: { authority: true } }, admission),
    ))],
    ["prompt-authority-field", async () => withAdmission(baseRequest, async (admission) => expectReason(
      "PROFILE_UNKNOWN_FIELD", () => resolveGenericProfile({ ...baseRequest, prompt: "grant" }, admission),
    ))],
    ["duplicate-layer-id", () => runResolve(request([
      base, overlay("imported_untrusted", base.layerId, { restrictOnly: clone(base.fields.restrictOnly) }),
    ]), "PROFILE_DUPLICATE_LAYER", { admissionRequest: baseRequest })],
    ["duplicate-layer-kind", () => runResolve(request([
      base, { ...clone(base), layerId: "profile-layer:duplicate-framework" },
    ]), "PROFILE_DUPLICATE_LAYER", { admissionRequest: baseRequest })],
    ["missing-framework-defaults", () => runResolve(request([
      overlay("imported_untrusted", "profile-layer:only-imported", { restrictOnly: clone(base.fields.restrictOnly) }),
    ]), "PROFILE_PRECEDENCE_AMBIGUOUS", { admissionRequest: baseRequest })],
    ["trust-level-mismatch", sync("PROFILE_TRUST_INVALID", () => validateGenericProfileLayer({
      ...clone(base), trustLevel: "imported_untrusted",
    }))],
    ["release-profile-unverified", () => {
      const release = overlay("release_verified_framework_profile", "profile-layer:unadmitted-release", {
        displayOnly: display("Release"),
      });
      return runResolve(request([base, release]), "PROFILE_RELEASE_UNADMITTED", {
        receiptOptions: { admittedLayers: [] },
      });
    }],
    ["release-proof-missing", sync("PROFILE_SCHEMA_INVALID", () => validateGenericProfileLayer({
      ...overlay("release_verified_framework_profile", "profile-layer:missing-proof", { displayOnly: display("Release") }),
      releaseVerificationDigest: null,
    }))],
    ["immutable-identity-change", () => runResolve(request([base, overlay(
      "workspace_configuration", "profile-layer:identity-change", { immutable: {
        ...clone(base.fields.immutable),
        identity: { ...clone(base.fields.immutable.identity), profileId: "profile:changed" },
      } },
    )]), "PROFILE_FIELD_IMMUTABLE")],
    ["mandatory-refusal-weakening", () => runResolve(request([base, overlay(
      "workspace_configuration", "profile-layer:refusal-change", { immutable: {
        ...clone(base.fields.immutable), mandatoryRefusals: base.fields.immutable.mandatoryRefusals.slice(1),
      } },
    )]), "PROFILE_REFUSAL_WEAKENING")],
    ["write-path-expansion", () => runResolve(request([base, overlay(
      "workspace_configuration", "profile-layer:path-expansion", { restrictOnly: {
        ...clone(base.fields.restrictOnly), writePaths: [".tcrn-workflow", "other"],
      } },
    )]), "PROFILE_RESTRICTION_EXPANSION")],
    ["tool-expansion", () => runResolve(request([base, overlay(
      "workspace_configuration", "profile-layer:tool-expansion", { restrictOnly: {
        ...clone(base.fields.restrictOnly), tools: ["node-filesystem", "shell"],
      } },
    )]), "PROFILE_RESTRICTION_EXPANSION")],
    ["operation-expansion", () => runResolve(request([base, overlay(
      "workspace_configuration", "profile-layer:operation-expansion", { restrictOnly: {
        ...clone(base.fields.restrictOnly), allowedOperations: [...base.fields.restrictOnly.allowedOperations, "unsafe.operation"],
      } },
    )]), "PROFILE_SCHEMA_INVALID")],
    ["budget-expansion", () => runResolve(request([base, overlay(
      "workspace_configuration", "profile-layer:budget-expansion", { restrictOnly: {
        ...clone(base.fields.restrictOnly), budgets: {
          ...clone(base.fields.restrictOnly.budgets), maximumWrites: base.fields.restrictOnly.budgets.maximumWrites + 1,
        },
      } },
    )]), "PROFILE_RESTRICTION_EXPANSION")],
    ["owner-rebind-missing", () => runResolve(request([base, workspace]), "PROFILE_OWNER_REBIND_REQUIRED")],
    ["owner-rebind-target-mismatch", () => runResolve(request([base, workspace], {
      ownerRebind: ownerRebind(workspace, workspaceReplacement, { targetLayerId: "profile-layer:other" }),
    }), "PROFILE_OWNER_REBIND_UNADMITTED", { receiptOptions: { admitOwnerRebind: false } })],
    ["owner-rebind-unbound", () => {
      const replacement = ownerFields(null, { mode: "unbound_read_only", workspaceId: null, escalationOwner: null });
      const layer = overlay("workspace_configuration", "profile-layer:unbound-rebind", { ownerRebindOnly: replacement });
      return runResolve(request([base, layer], { ownerRebind: ownerRebind(layer, replacement) }),
        "PROFILE_OWNER_REBIND_INVALID", { admissionRequest: baseRequest });
    }],
    ["owner-rebind-escalation-missing", () => {
      const replacement = ownerFields("workspace:generic-fixture", { escalationOwner: null });
      const layer = overlay("workspace_configuration", "profile-layer:no-escalation", { ownerRebindOnly: replacement });
      return runResolve(request([base, layer], { ownerRebind: ownerRebind(layer, replacement) }),
        "PROFILE_OWNER_REBIND_INVALID", { admissionRequest: baseRequest });
    }],
    ["owner-rebind-unused", () => {
      const layer = overlay("workspace_configuration", "profile-layer:display-only", { displayOnly: display("Display") });
      const resolutionRequest = request([base, layer], { ownerRebind: ownerRebind(layer, workspaceReplacement) });
      return runResolve(resolutionRequest, "PROFILE_OWNER_REBIND_INVALID");
    }],
    ["imported-owner-rebind", () => {
      const layer = overlay("imported_untrusted", "profile-layer:imported-owner", { ownerRebindOnly: workspaceReplacement });
      return runResolve(request([base, layer], { ownerRebind: ownerRebind(layer, workspaceReplacement) }),
        "PROFILE_TRUST_INVALID", { admissionRequest: baseRequest });
    }],
    ["imported-display-authority", sync("PROFILE_TRUST_INVALID", () => validateGenericProfileLayer(overlay(
      "imported_untrusted", "profile-layer:imported-display", { displayOnly: display("Imported") },
    )))],
    ["unknown-layer-field", sync("PROFILE_UNKNOWN_FIELD", () => validateGenericProfileLayer({
      ...clone(base), extraAuthority: true,
    }))],
    ["layer-type-conflict", sync("PROFILE_TYPE_CONFLICT", () => validateGenericProfileLayer(null))],
    ["malformed-stable-id", sync("PROFILE_SCHEMA_INVALID", () => validateGenericProfileLayer({
      ...clone(base), layerId: "bad id",
    }))],
    ["unsorted-canonical-array", sync("PROFILE_CANONICAL_INVALID", () => validateGenericProfileLayer({
      ...clone(base), fields: { ...clone(base.fields), restrictOnly: {
        ...clone(base.fields.restrictOnly), allowedOperations: [...base.fields.restrictOnly.allowedOperations].reverse(),
      } },
    }))],
    ["duplicate-array-value", sync("PROFILE_DUPLICATE_VALUE", () => validateGenericProfileLayer({
      ...clone(base), fields: { ...clone(base.fields), restrictOnly: {
        ...clone(base.fields.restrictOnly), tools: ["node-filesystem", "node-filesystem"],
      } },
    }))],
    ["url-in-display", sync("PROFILE_INERT_DATA_REQUIRED", () => validateGenericProfileLayer(overlay(
      "imported_untrusted", "profile-layer:url-display", { displayOnly: {
        ...display("URL"), description: "https://example.test",
      } },
    )))],
    ["interpolation-in-display", sync("PROFILE_INERT_DATA_REQUIRED", () => validateGenericProfileLayer(overlay(
      "imported_untrusted", "profile-layer:interpolation", { displayOnly: {
        ...display("Interpolation"), description: "${unsafe}",
      } },
    )))],
    ["absolute-write-path", sync("PROFILE_INERT_DATA_REQUIRED", () => validateGenericProfileLayer(overlay(
      "workspace_configuration", "profile-layer:absolute-path", { restrictOnly: {
        ...clone(base.fields.restrictOnly), writePaths: ["/tmp/authority"],
      } },
    )))],
    ["cold-standby-operation", async () => withAdmission(baseRequest, async (admission) => expectReason(
      "PROFILE_COLD_STANDBY", () => authorizeGenericProfileOperation(
        baseRequest, admission, "profile.read", { workspaceId: null, projectId: null, command: null },
      ),
    ), { resolutionDisposition: "cold_standby" })],
    ["unbound-mutation", async () => withAdmission(baseRequest, async (admission) => expectReason(
      "PROFILE_BINDING_REQUIRED", () => authorizeGenericProfileOperation(
        baseRequest, admission, "project.create", { workspaceId: null, projectId: null, command: null },
      ),
    ))],
    ["workspace-binding-mismatch", async () => {
      const resolutionRequest = boundRequest();
      return withAdmission(resolutionRequest, async (admission) => expectReason(
        "PROFILE_BINDING_MISMATCH", () => authorizeGenericProfileOperation(
          resolutionRequest, admission, "project.create", { workspaceId: "workspace:other", projectId: null, command: null },
        ),
      ));
    }],
    ["operation-denied", async () => {
      const resolutionRequest = boundRequest("workspace:generic-fixture", { restrictOnly: {
        ...clone(base.fields.restrictOnly), allowedOperations: restrictedOperations,
      } });
      return withAdmission(resolutionRequest, async (admission) => expectReason(
        "PROFILE_OPERATION_DENIED", () => authorizeGenericProfileOperation(
          resolutionRequest, admission, "project.create",
          { workspaceId: "workspace:generic-fixture", projectId: null, command: null },
        ),
      ));
    }],
    ["effective-digest-tamper", async () => {
      const resolutionRequest = boundRequest();
      return withAdmission(resolutionRequest, async (admission) => {
        const effective = resolveGenericProfile(resolutionRequest, admission);
        effective.displayOnly.label = "Tampered";
        expectReason("PROFILE_EFFECTIVE_UNADMITTED", () => authorizeGenericProfileOperation(
          effective, admission, "profile.read",
          { workspaceId: "workspace:generic-fixture", projectId: null, command: null },
        ));
      });
    }],
    ["bundle-digest-tamper", sync("PROFILE_BUNDLE_INVALID", () => validateGenericStarterBundle({
      ...clone(bundle), bundleDigest: "0".repeat(64),
    }))],
    ["starter-flow-tamper", async () => {
      const changed = clone(bundle);
      changed.starterFlow[3].parentKind = "Epic";
      changed.bundleDigest = canonicalSha256({
        schemaVersion: changed.schemaVersion, layers: changed.layers, starterFlow: changed.starterFlow,
      });
      expectReason("PROFILE_BUNDLE_INVALID", () => validateGenericStarterBundle(changed));
    }],
  ]);
  assert.deepEqual([...cases.keys()], fixture.negativeCases);
  for (const operation of cases.values()) await operation();
});

test("64 actual insertion permutations produce identical admitted policy and digest", async () => {
  const logical = fullPermutationLayers();
  const permutations = deterministicPermutations(logical.layers, fixture.propertyPermutations);
  assert.equal(permutations.length, 64);
  const records = await Promise.all(permutations.map(async (layers) => {
    const permutationRequest = request(layers, logical);
    return withAdmission(permutationRequest, async (admission) => {
      const effective = resolveGenericProfile(permutationRequest, admission);
      assert.equal(effective.displayOnly.label, "Command Display");
      return {
        inputLayerIds: layers.map((layer) => layer.layerId),
        effectiveBytes: canonicalJson(effective),
        effectiveDigest: effective.effectiveDigest,
      };
    });
  }));
  assert.equal(new Set(records.map((record) => record.effectiveBytes)).size, 1);
  assert.equal(new Set(records.map((record) => record.effectiveDigest)).size, 1);
  assert.equal(canonicalSha256(records), fixture.permutationCorpusDigest);
});

test("governed CLI generation, validation, resolution, and authorization fail closed", async () => {
  let output = "";
  await runCli(["profile-generate", "--mode", "generic"], { write: (value) => { output = value; } });
  const generated = JSON.parse(output);
  assert.equal(generated.reasonCode, "PROFILE_BUNDLE_GENERATED");
  await runCli(["profile-validate", "--bundle", canonicalJson(generated.bundle)], { write: (value) => { output = value; } });
  assert.equal(JSON.parse(output).reasonCode, "PROFILE_VALIDATED");
  const unboundRequest = request(generated.bundle.layers);
  const admitted = await admissionFixture(unboundRequest);
  try {
    await runCli(["profile-resolve", "--request", canonicalJson(unboundRequest), "--receipt", admitted.path],
      { write: (value) => { output = value; }, profileAdmissionAuthority: admitted.authority });
    const unbound = JSON.parse(output);
    assert.equal(unbound.resolution, "unbound_read_only");
    await expectReasonAsync("PROFILE_BINDING_REQUIRED", () => runCli([
      "profile-authorize",
      "--request", canonicalJson(unboundRequest),
      "--receipt", admitted.path,
      "--operation", "project.create",
      "--workspace-id", "-",
      "--project-id", "-",
      "--command", "-",
    ], { write: () => {}, profileAdmissionAuthority: admitted.authority }));
    await expectReasonAsync("CLI_ARGUMENT_MISSING", () => runCli([
      "profile-resolve", "--request", canonicalJson(unboundRequest),
    ], { write: () => {} }));
    await expectReasonAsync("CLI_ARGUMENT_UNKNOWN", () => runCli([
      "profile-resolve", "--request", canonicalJson(unboundRequest), "--receipt", admitted.path, "--trust", "self",
    ], { write: () => {} }));
  } finally {
    await admitted.close();
  }
  await expectReasonAsync("CLI_ARGUMENT_MISSING", () => runCli(["profile-generate"], { write: () => {} }));
  await expectReasonAsync("CLI_ARGUMENT_DUPLICATE", () => runCli(
    ["profile-generate", "--mode", "generic", "--mode", "generic"], { write: () => {} },
  ));
  await expectReasonAsync("CLI_ARGUMENT_UNKNOWN", () => runCli(
    ["profile-generate", "--mode", "generic", "--owner", "authority"], { write: () => {} },
  ));
  await expectReasonAsync("PROFILE_INPUT_INVALID", () => runCli(
    ["profile-validate", "--bundle", "{"], { write: () => {} },
  ));
  const selfLabeled = boundRequest();
  const baseOnly = request([generated.bundle.layers[0]]);
  const baseAdmission = await admissionFixture(selfLabeled, { admittedLayers: [] });
  try {
    await expectReasonAsync("PROFILE_LAYER_UNADMITTED", () => runCli([
      "profile-resolve", "--request", canonicalJson(selfLabeled), "--receipt", baseAdmission.path,
    ], { write: () => {}, profileAdmissionAuthority: baseAdmission.authority }));
  } finally {
    await baseAdmission.close();
  }
  const filesystemAdmission = await admissionFixture(baseOnly, { skipRead: true });
  try {
    const malformedBytes = "{\n";
    await writeFile(filesystemAdmission.path, malformedBytes, "utf8");
    await expectReasonAsync("PROFILE_ADMISSION_MALFORMED", () => runCli([
      "profile-resolve", "--request", canonicalJson(baseOnly), "--receipt", filesystemAdmission.path,
    ], { write: () => {}, profileAdmissionAuthority: fileAuthority(filesystemAdmission.path, malformedBytes) }));
    const mismatched = admissionReceipt(baseOnly, { receiptDigest: "0".repeat(64) });
    const mismatchedBytes = canonicalJson(mismatched);
    await writeFile(filesystemAdmission.path, mismatchedBytes, "utf8");
    await expectReasonAsync("PROFILE_ADMISSION_MISMATCH", () => runCli([
      "profile-resolve", "--request", canonicalJson(baseOnly), "--receipt", filesystemAdmission.path,
    ], { write: () => {}, profileAdmissionAuthority: fileAuthority(filesystemAdmission.path, mismatchedBytes) }));
    const validBytes = canonicalJson(admissionReceipt(baseOnly));
    await writeFile(filesystemAdmission.path, validBytes, "utf8");
    const hardlinkPath = join(filesystemAdmission.directory, "cli-hardlink.json");
    await link(filesystemAdmission.path, hardlinkPath);
    await expectReasonAsync("PROFILE_ADMISSION_LINK", () => runCli([
      "profile-resolve", "--request", canonicalJson(baseOnly), "--receipt", hardlinkPath,
    ], { write: () => {}, profileAdmissionAuthority: fileAuthority(hardlinkPath, validBytes) }));
    await rm(hardlinkPath);
    await rm(filesystemAdmission.path);
    await expectReasonAsync("PROFILE_ADMISSION_CHANGED", () => runCli([
      "profile-resolve", "--request", canonicalJson(baseOnly), "--receipt", filesystemAdmission.path,
    ], { write: () => {}, profileAdmissionAuthority: fileAuthority(filesystemAdmission.path, validBytes) }));
  } finally {
    await filesystemAdmission.close();
  }
});

test("empty non-project-specific Workspace cold-start completes the minimal planned-delivery flow", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "workflow-generic-profile-")));
  try {
    const roots = [];
    for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
      const path = join(base, kind);
      await mkdir(path);
      roots.push({ kind, path });
    }
    const externalKey = "GENERIC-EMPTY-WORKSPACE";
    const workspaceId = deriveStableId("workspace", canonicalExternalKey(externalKey));
    const resolutionRequest = boundRequest(workspaceId);
    const admitted = await admissionFixture(resolutionRequest);
    const context = { workspaceId, projectId: null, command: null };
    assert.equal(authorizeGenericProfileOperation(resolutionRequest, admitted.context, "workspace.initialize", context).reasonCode,
      "PROFILE_OPERATION_AUTHORIZED");
    let state = await initializeWorkspace({
      roots,
      externalKey,
      createdAt: "2026-07-11T19:00:00Z",
      segmentEventLimit: 64,
    });
    const workspaceRoot = join(base, "workspace");
    const lease = await acquireWorkspaceLease(workspaceRoot, { now: "2026-07-11T19:00:01Z" });
    try {
      authorizeGenericProfileOperation(resolutionRequest, admitted.context, "project.create", context);
      state = await createProject(workspaceRoot, lease, {
        expectedVersion: 0,
        occurredAt: "2026-07-11T19:00:01Z",
        externalKey: "GENERIC-PROJECT",
        name: "Generic Project",
      });
      const projectId = state.projects[0].id;
      const records = [
        ["GENERIC-INITIATIVE", "Initiative", null],
        ["GENERIC-EPIC", "Epic", "GENERIC-INITIATIVE"],
        ["GENERIC-STORY", "Story", "GENERIC-EPIC"],
        ["GENERIC-SUBTASK", "Subtask", "GENERIC-STORY"],
      ];
      for (let index = 0; index < records.length; index += 1) {
        const [key, kind, parentKey] = records[index];
        authorizeGenericProfileOperation(resolutionRequest, admitted.context, "work.create", context);
        const parentId = parentKey === null ? null : state.work.find((record) => record.externalKey === parentKey).id;
        state = await createWork(workspaceRoot, lease, {
          expectedVersion: state.version,
          occurredAt: `2026-07-11T19:00:0${index + 2}Z`,
          projectId,
          externalKey: key,
          kind,
          parentId,
          status: "planned",
        });
      }
      const completionOrder = ["GENERIC-SUBTASK", "GENERIC-STORY", "GENERIC-EPIC", "GENERIC-INITIATIVE"];
      let second = 6;
      for (const key of completionOrder) {
        for (const status of ["ready", "active", "done"]) {
          authorizeGenericProfileOperation(resolutionRequest, admitted.context, "work.transition", context);
          state = await transitionWork(workspaceRoot, lease, {
            expectedVersion: state.version,
            occurredAt: `2026-07-11T19:00:${String(second).padStart(2, "0")}Z`,
            id: state.work.find((record) => record.externalKey === key).id,
            status,
          });
          second += 1;
        }
      }
    } finally {
      await lease.release();
    }
    await admitted.close();
    const validated = await validateWorkspace(workspaceRoot);
    assert.equal(validated.version, fixture.coldStartEvents);
    assert.equal(validated.events.length, fixture.coldStartEvents);
    assert.equal(validated.work.length, fixture.coldStartRecords);
    assert.deepEqual(validated.work.map((record) => record.kind).sort(compareCanonicalText),
      ["Epic", "Initiative", "Story", "Subtask"].sort(compareCanonicalText));
    assert.equal(validated.work.every((record) => record.status === "done"), true);
    await assert.rejects(readFile(join(workspaceRoot, ".tcrn-workflow", "profiles", "store.json")),
      (error) => error?.code === "ENOENT");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("profile runtime remains standalone and imports only frozen local protocol authority", async () => {
  const source = await readFile(new URL("../packages/core/src/generic-profile.ts", import.meta.url), "utf8");
  assert.equal(source.includes("../../protocol/src/index.js"), true);
  const forbiddenTokens = [
    ["node", ":", "child_process"],
    ["node", ":", "http"],
    ["node", ":", "https"],
    ["node", ":", "net"],
    ["node", ":", "sqlite"],
    ["fet", "ch", "("],
    ["Web", "Socket"],
    ["create", "Connection", "("],
    ["process", ".", "env"],
    ["legacy", "/"],
  ].map((parts) => parts.join(""));
  for (const forbidden of forbiddenTokens) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  assert.deepEqual(GENERIC_PROFILE_OPERATIONS, fixture.operationCases);
});

// CQ-02c, last of the eight sites. `resolution` was admitted through a coercing membership
// test while `operation()` in this same file (generic-profile.ts:434-439) already did the
// typeof check first -- the correct shape was sitting two hundred lines away from the
// broken one.
test("CQ-02c: effective profile resolution refuses values that only coerce to a member", async () => {
  const bundle = fullPermutationLayers();
  const resolutionRequest = request(bundle.layers, bundle);
  const effective = await resolveAdmitted(resolutionRequest);
  const member = effective.resolution;
  assert.equal(typeof member, "string");

  const vectors = [
    ["single-element array", [member]],
    ["plain object with toString", { toString: () => member }],
    ["boxed String", new String(member)],
    // Regression anchors only -- already refused before the guard existed.
    ["anchor number", 1],
    ["anchor null", null],
    ["anchor plain object", {}],
  ];
  // The reason code alone cannot prove this guard: a coercible value that slips past the
  // header is caught two hundred lines later by the resolution/binding mismatch at
  // generic-profile.ts:1139, which fails with the SAME PROFILE_SCHEMA_INVALID code. The
  // failure label is what distinguishes the admission guard from that downstream backstop,
  // so it is pinned here. Asserting the code only would pass with the defect reintroduced.
  for (const [label, resolution] of vectors) {
    assert.throws(() => validateEffectiveGenericProfile({ ...effective, resolution }), (error) => {
      assert.equal(error?.reasonCode, "PROFILE_SCHEMA_INVALID", `${label}: got ${error?.reasonCode}`);
      assert.equal(error?.message, "effective profile header", `${label}: refused downstream, not at the header`);
      return true;
    }, label);
  }
  // The guard must not have closed the legal value.
  assert.deepEqual(validateEffectiveGenericProfile(effective), effective);
});

test("E01/STORY-004: flag-supplied authority binds by digest and refuses a second source", async () => {
  // The out-of-band pin can reach the CLI as an argument, the way --expected-plan-digest
  // already does. What must hold is that the flag is not a way to *skip* the authority:
  // the digest still has to match the bytes on disk, and a wrong one must fail on the
  // digest rather than sail through. Reason codes alone would not show that -- the
  // wrong-digest and correct-digest cases have to land in different places.
  const supplyRequest = request([generateGenericStarterBundle().layers[0]]);
  const admitted = await admissionFixture(supplyRequest, { skipRead: true });
  try {
    // Correct digest: past the authority gate entirely, into resolution.
    let output = "";
    await runCli([
      "profile-resolve", "--request", canonicalJson(supplyRequest),
      "--receipt", admitted.path, "--receipt-digest", admitted.authority.expectedFileSha256,
    ], { write: (value) => { output = value; } });
    assert.equal(JSON.parse(output).schemaVersion, "tcrn.generic-profile-effective.v1");

    // Wrong digest: the pin binds against the bytes, so this stops at the digest.
    await expectReasonAsync("PROFILE_ADMISSION_AUTHORITY_DIGEST", () => runCli([
      "profile-resolve", "--request", canonicalJson(supplyRequest),
      "--receipt", admitted.path, "--receipt-digest", "b".repeat(64),
    ], { write: () => {} }));

    // No supply at all stays exactly as it was before the flag existed.
    await expectReasonAsync("PROFILE_ADMISSION_AUTHORITY_REQUIRED", () => runCli([
      "profile-resolve", "--request", canonicalJson(supplyRequest), "--receipt", admitted.path,
    ], { write: () => {} }));

    // Two sources for one authority is ambiguity. Picking a winner would silently
    // ignore the other, so both-supplied fails closed even when they agree.
    await expectReasonAsync("CLI_AUTHORITY_AMBIGUOUS", () => runCli([
      "profile-resolve", "--request", canonicalJson(supplyRequest),
      "--receipt", admitted.path, "--receipt-digest", admitted.authority.expectedFileSha256,
    ], { write: () => {}, profileAdmissionAuthority: admitted.authority }));

    // A digest-shaped argument is the only thing accepted as a digest.
    await expectReasonAsync("CLI_ARGUMENT_MALFORMED", () => runCli([
      "profile-resolve", "--request", canonicalJson(supplyRequest),
      "--receipt", admitted.path, "--receipt-digest", "not-a-digest",
    ], { write: () => {} }));
  } finally {
    await admitted.close();
  }
});
