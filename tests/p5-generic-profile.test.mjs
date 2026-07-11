// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import {
  GENERIC_PROFILE_OPERATIONS,
  acquireWorkspaceLease,
  authorizeGenericProfileOperation,
  createProject,
  createWork,
  generateGenericStarterBundle,
  initializeWorkspace,
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
    admittedReleaseProfileDigests: options.admittedReleaseProfileDigests ?? [],
  };
}

function boundProfile(workspaceId = "workspace:generic-fixture", options = {}) {
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
  return resolveGenericProfile(request(
    [workspace, ...bundle.layers],
    { ownerRebind: ownerRebind(workspace, replacement) },
  ));
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
    admittedReleaseProfileDigests: [canonicalSha256(release)],
  };
}

test("starter bundle is closed, schema-valid, deterministic, and inert", () => {
  const bundle1 = generateGenericStarterBundle();
  const bundle2 = generateGenericStarterBundle();
  assert.equal(canonicalJson(bundle1), canonicalJson(bundle2));
  assert.equal(bundle1.bundleDigest, canonicalSha256({
    schemaVersion: bundle1.schemaVersion,
    layers: bundle1.layers,
    starterFlow: bundle1.starterFlow,
  }));
  assert.equal(bundle1.bundleDigest, fixture.starterBundleDigest);
  assert.equal(canonicalSha256(bundle1.layers[0]), fixture.baseProfileDigest);
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
  const effective = resolveGenericProfile(resolutionRequest);
  assert.equal(effective.effectiveDigest, fixture.unboundEffectiveDigest);
  assert.equal(validateRequest(resolutionRequest), true, JSON.stringify(validateRequest.errors));
  assert.equal(validateEffective(effective), true, JSON.stringify(validateEffective.errors));
  assert.deepEqual(validateEffectiveGenericProfile(effective), effective);
});

test("trust, precedence, binding, and field merge matrix are exact", () => {
  const permutation = fullPermutationLayers();
  const effective = resolveGenericProfile(request(permutation.layers, permutation));
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
  const boundVector = boundProfile();
  assert.equal(boundVector.effectiveDigest, fixture.boundEffectiveDigest);
  assert.equal(boundVector.overlayDigest, fixture.boundOverlayDigest);
  assert.equal(boundVector.effectivePolicyDigest, fixture.boundEffectivePolicyDigest);
  assert.equal(authorizeGenericProfileOperation(effective, "project.create", {
    workspaceId: "workspace:generic-fixture",
    projectId: null,
    command: null,
  }).reasonCode, "PROFILE_OPERATION_AUTHORIZED");
});

test("workspace, project, and owner-approved command bindings are exact", () => {
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
    const effective = resolveGenericProfile(request([layer, base], {
      ownerRebind: ownerRebind(layer, bindingCase.replacement),
    }));
    assert.equal(authorizeGenericProfileOperation(effective, bindingCase.operation, bindingCase.context).reasonCode,
      "PROFILE_OPERATION_AUTHORIZED");
    assert.deepEqual(effective.ownerRebindOnly, bindingCase.replacement);
  }
});

test("all declared profile negatives are executable with frozen reasons", () => {
  const bundle = generateGenericStarterBundle();
  const base = bundle.layers[0];
  const baseRequest = request(bundle.layers);
  const workspaceReplacement = ownerFields();
  const workspace = overlay("workspace_configuration", "profile-layer:workspace-configuration", {
    ownerRebindOnly: workspaceReplacement,
  });
  const resolveBound = () => resolveGenericProfile(request(
    [base, workspace],
    { ownerRebind: ownerRebind(workspace, workspaceReplacement) },
  ));
  const restrictedOperations = base.fields.restrictOnly.allowedOperations.filter((entry) => entry !== "project.create");
  const restricted = {
    ...base.fields.restrictOnly,
    allowedOperations: restrictedOperations,
  };
  const cases = [
    ["request-unknown-field", "PROFILE_UNKNOWN_FIELD", () => resolveGenericProfile({ ...baseRequest, unexpected: true })],
    ["environment-authority-field", "PROFILE_UNKNOWN_FIELD", () => resolveGenericProfile({ ...baseRequest, environment: { authority: true } })],
    ["prompt-authority-field", "PROFILE_UNKNOWN_FIELD", () => resolveGenericProfile({ ...baseRequest, prompt: "grant-authority" })],
    ["duplicate-layer-id", "PROFILE_DUPLICATE_LAYER", () => resolveGenericProfile(request([
      base,
      overlay("imported_untrusted", base.layerId, { restrictOnly: clone(base.fields.restrictOnly) }),
    ]))],
    ["duplicate-layer-kind", "PROFILE_DUPLICATE_LAYER", () => resolveGenericProfile(request([
      base,
      { ...clone(base), layerId: "profile-layer:duplicate-framework" },
    ]))],
    ["missing-framework-defaults", "PROFILE_PRECEDENCE_AMBIGUOUS", () => resolveGenericProfile(request([
      overlay("imported_untrusted", "profile-layer:only-imported", { restrictOnly: clone(base.fields.restrictOnly) }),
    ]))],
    ["trust-level-mismatch", "PROFILE_TRUST_INVALID", () => validateGenericProfileLayer({ ...clone(base), trustLevel: "imported_untrusted" })],
    ["release-profile-unverified", "PROFILE_RELEASE_UNVERIFIED", () => resolveGenericProfile(request([
      base,
      overlay("release_verified_framework_profile", "profile-layer:unverified-release", { displayOnly: display("Release") }),
    ]))],
    ["release-proof-missing", "PROFILE_SCHEMA_INVALID", () => validateGenericProfileLayer({
      ...overlay("release_verified_framework_profile", "profile-layer:missing-proof", { displayOnly: display("Release") }),
      releaseVerificationDigest: null,
    })],
    ["immutable-identity-change", "PROFILE_FIELD_IMMUTABLE", () => resolveGenericProfile(request([
      base,
      overlay("workspace_configuration", "profile-layer:identity-change", {
        immutable: {
          ...clone(base.fields.immutable),
          identity: { ...clone(base.fields.immutable.identity), profileId: "profile:changed" },
        },
      }),
    ]))],
    ["mandatory-refusal-weakening", "PROFILE_REFUSAL_WEAKENING", () => resolveGenericProfile(request([
      base,
      overlay("workspace_configuration", "profile-layer:refusal-change", {
        immutable: { ...clone(base.fields.immutable), mandatoryRefusals: base.fields.immutable.mandatoryRefusals.slice(1) },
      }),
    ]))],
    ["write-path-expansion", "PROFILE_RESTRICTION_EXPANSION", () => resolveGenericProfile(request([
      base,
      overlay("workspace_configuration", "profile-layer:path-expansion", {
        restrictOnly: { ...clone(base.fields.restrictOnly), writePaths: [".tcrn-workflow", "other"] },
      }),
    ]))],
    ["tool-expansion", "PROFILE_RESTRICTION_EXPANSION", () => resolveGenericProfile(request([
      base,
      overlay("workspace_configuration", "profile-layer:tool-expansion", {
        restrictOnly: { ...clone(base.fields.restrictOnly), tools: ["node-filesystem", "shell"] },
      }),
    ]))],
    ["operation-expansion", "PROFILE_RESTRICTION_EXPANSION", () => {
      const narrowBase = clone(base);
      narrowBase.fields.restrictOnly.allowedOperations = restrictedOperations;
      return resolveGenericProfile(request([
        narrowBase,
        overlay("workspace_configuration", "profile-layer:operation-expansion", { restrictOnly: clone(base.fields.restrictOnly) }),
      ]));
    }],
    ["budget-expansion", "PROFILE_RESTRICTION_EXPANSION", () => resolveGenericProfile(request([
      base,
      overlay("workspace_configuration", "profile-layer:budget-expansion", {
        restrictOnly: {
          ...clone(base.fields.restrictOnly),
          budgets: { ...clone(base.fields.restrictOnly.budgets), maximumWrites: base.fields.restrictOnly.budgets.maximumWrites + 1 },
        },
      }),
    ]))],
    ["owner-rebind-missing", "PROFILE_OWNER_REBIND_REQUIRED", () => resolveGenericProfile(request([base, workspace]))],
    ["owner-rebind-target-mismatch", "PROFILE_OWNER_REBIND_REQUIRED", () => resolveGenericProfile(request(
      [base, workspace],
      { ownerRebind: ownerRebind(workspace, workspaceReplacement, { targetLayerId: "profile-layer:other" }) },
    ))],
    ["owner-rebind-unbound", "PROFILE_OWNER_REBIND_INVALID", () => {
      const replacement = ownerFields(null, { mode: "unbound_read_only", workspaceId: null, escalationOwner: null });
      const layer = overlay("workspace_configuration", "profile-layer:unbound-rebind", { ownerRebindOnly: replacement });
      return resolveGenericProfile(request([base, layer], { ownerRebind: ownerRebind(layer, replacement) }));
    }],
    ["owner-rebind-escalation-missing", "PROFILE_OWNER_REBIND_INVALID", () => {
      const replacement = ownerFields("workspace:generic-fixture", { escalationOwner: null });
      const layer = overlay("workspace_configuration", "profile-layer:no-escalation", { ownerRebindOnly: replacement });
      return resolveGenericProfile(request([base, layer], { ownerRebind: ownerRebind(layer, replacement) }));
    }],
    ["owner-rebind-unused", "PROFILE_OWNER_REBIND_INVALID", () => {
      const layer = overlay("workspace_configuration", "profile-layer:display-only", { displayOnly: display("Display") });
      return resolveGenericProfile(request([base, layer], { ownerRebind: ownerRebind(layer, workspaceReplacement) }));
    }],
    ["imported-owner-rebind", "PROFILE_TRUST_INVALID", () => {
      const layer = overlay("imported_untrusted", "profile-layer:imported-owner", { ownerRebindOnly: workspaceReplacement });
      return resolveGenericProfile(request([base, layer], { ownerRebind: ownerRebind(layer, workspaceReplacement) }));
    }],
    ["imported-display-authority", "PROFILE_TRUST_INVALID", () => validateGenericProfileLayer(overlay(
      "imported_untrusted", "profile-layer:imported-display", { displayOnly: display("Imported Display") },
    ))],
    ["unknown-layer-field", "PROFILE_UNKNOWN_FIELD", () => validateGenericProfileLayer({ ...clone(base), extraAuthority: true })],
    ["layer-type-conflict", "PROFILE_TYPE_CONFLICT", () => validateGenericProfileLayer(null)],
    ["malformed-stable-id", "PROFILE_SCHEMA_INVALID", () => validateGenericProfileLayer({ ...clone(base), layerId: "bad id" })],
    ["unsorted-canonical-array", "PROFILE_CANONICAL_INVALID", () => validateGenericProfileLayer({
      ...clone(base),
      fields: {
        ...clone(base.fields),
        restrictOnly: { ...clone(base.fields.restrictOnly), allowedOperations: [...base.fields.restrictOnly.allowedOperations].reverse() },
      },
    })],
    ["duplicate-array-value", "PROFILE_DUPLICATE_VALUE", () => validateGenericProfileLayer({
      ...clone(base),
      fields: {
        ...clone(base.fields),
        restrictOnly: { ...clone(base.fields.restrictOnly), tools: ["node-filesystem", "node-filesystem"] },
      },
    })],
    ["url-in-display", "PROFILE_INERT_DATA_REQUIRED", () => validateGenericProfileLayer(overlay(
      "imported_untrusted", "profile-layer:url-display", { displayOnly: { ...display("URL"), description: "https://example.test" } },
    ))],
    ["interpolation-in-display", "PROFILE_INERT_DATA_REQUIRED", () => validateGenericProfileLayer(overlay(
      "imported_untrusted", "profile-layer:interpolation", { displayOnly: { ...display("Interpolation"), description: "${unsafe}" } },
    ))],
    ["absolute-write-path", "PROFILE_INERT_DATA_REQUIRED", () => validateGenericProfileLayer(overlay(
      "workspace_configuration", "profile-layer:absolute-path", {
        restrictOnly: { ...clone(base.fields.restrictOnly), writePaths: ["/tmp/authority"] },
      },
    ))],
    ["cold-standby-operation", "PROFILE_COLD_STANDBY", () => {
      const coldBase = clone(base);
      coldBase.fields.ownerRebindOnly.activeBinding.mode = "cold_standby";
      const effective = resolveGenericProfile(request([coldBase]));
      return authorizeGenericProfileOperation(effective, "profile.read", { workspaceId: null, projectId: null, command: null });
    }],
    ["unbound-mutation", "PROFILE_BINDING_REQUIRED", () => authorizeGenericProfileOperation(
      resolveGenericProfile(baseRequest), "project.create", { workspaceId: null, projectId: null, command: null },
    )],
    ["workspace-binding-mismatch", "PROFILE_BINDING_MISMATCH", () => authorizeGenericProfileOperation(
      resolveBound(), "project.create", { workspaceId: "workspace:other", projectId: null, command: null },
    )],
    ["operation-denied", "PROFILE_OPERATION_DENIED", () => authorizeGenericProfileOperation(
      boundProfile("workspace:generic-fixture", { restrictOnly: { ...clone(base.fields.restrictOnly), allowedOperations: restrictedOperations } }),
      "project.create",
      { workspaceId: "workspace:generic-fixture", projectId: null, command: null },
    )],
    ["effective-digest-tamper", "PROFILE_CANONICAL_INVALID", () => {
      const effective = resolveBound();
      effective.displayOnly.label = "Tampered";
      return authorizeGenericProfileOperation(effective, "profile.read", {
        workspaceId: "workspace:generic-fixture", projectId: null, command: null,
      });
    }],
    ["bundle-digest-tamper", "PROFILE_BUNDLE_INVALID", () => validateGenericStarterBundle({ ...clone(bundle), bundleDigest: "0".repeat(64) })],
    ["starter-flow-tamper", "PROFILE_BUNDLE_INVALID", () => {
      const changed = clone(bundle);
      changed.starterFlow[3].parentKind = "Epic";
      changed.bundleDigest = canonicalSha256({
        schemaVersion: changed.schemaVersion, layers: changed.layers, starterFlow: changed.starterFlow,
      });
      return validateGenericStarterBundle(changed);
    }],
  ];
  assert.deepEqual(cases.map(([id]) => id), fixture.negativeCases);
  for (const [id, reasonCode, operation] of cases) {
    expectReason(reasonCode, operation, id);
  }
});

test("64 actual insertion permutations produce identical canonical policy and digest", () => {
  const logical = fullPermutationLayers();
  const permutations = deterministicPermutations(logical.layers, fixture.propertyPermutations);
  assert.equal(permutations.length, 64);
  const records = permutations.map((layers) => {
    const effective = resolveGenericProfile(request(layers, logical));
    assert.equal(effective.displayOnly.label, "Command Display");
    return {
      inputLayerIds: layers.map((layer) => layer.layerId),
      effectiveBytes: canonicalJson(effective),
      effectiveDigest: effective.effectiveDigest,
    };
  });
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
  await runCli(["profile-resolve", "--request", canonicalJson(unboundRequest)], { write: (value) => { output = value; } });
  const unbound = JSON.parse(output);
  assert.equal(unbound.resolution, "unbound_read_only");
  await expectReasonAsync("PROFILE_BINDING_REQUIRED", () => runCli([
    "profile-authorize",
    "--request", canonicalJson(unboundRequest),
    "--operation", "project.create",
    "--workspace-id", "-",
    "--project-id", "-",
    "--command", "-",
  ], { write: () => {} }));
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
  const invalidReplacement = ownerFields("workspace:generic-fixture", { escalationOwner: null });
  const invalidLayer = overlay("workspace_configuration", "profile-layer:invalid-escalation", {
    ownerRebindOnly: invalidReplacement,
  });
  await expectReasonAsync("PROFILE_OWNER_REBIND_INVALID", () => runCli([
    "profile-resolve",
    "--request",
    canonicalJson(request([generated.bundle.layers[0], invalidLayer], {
      ownerRebind: ownerRebind(invalidLayer, invalidReplacement),
    })),
  ], { write: () => {} }));
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
    const effective = boundProfile(workspaceId);
    const context = { workspaceId, projectId: null, command: null };
    assert.equal(authorizeGenericProfileOperation(effective, "workspace.initialize", context).reasonCode,
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
      authorizeGenericProfileOperation(effective, "project.create", context);
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
        authorizeGenericProfileOperation(effective, "work.create", context);
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
          authorizeGenericProfileOperation(effective, "work.transition", context);
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
