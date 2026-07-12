// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { runCli } from "../dist/build/packages/cli/src/index.js";
import { CORE_PERSONA_SOURCE_MANIFEST_SHA256, generateCorePersonaBundle, generateCorePersonaReleaseLayers, resolveGenericProfile, validateCorePersonaBundle, validateCorePersonaProfile, validateCorePersonaProfileShape } from "../dist/build/packages/core/src/index.js";
import { canonicalJson, canonicalSha256 } from "../dist/build/packages/protocol/src/index.js";
const fixture = JSON.parse(await readFile(new URL("../packages/core/fixtures/p5-generic-profile-cases.json", import.meta.url), "utf8"));

const reason = (code, operation) => assert.throws(operation, (error) => error?.reasonCode === code, code);
test("exact eight-profile bundle is closed, schema-valid, source-bound, and deterministic", async () => {
  const bundle = generateCorePersonaBundle(); assert.equal(bundle.profiles.length, 8); assert.equal(bundle.sourceManifestSha256, CORE_PERSONA_SOURCE_MANIFEST_SHA256);
  assert.deepEqual(bundle.profiles.map((p) => p.displayName).sort(), ["Arturo", "Ilya", "Janus", "Mara", "Minerva", "Mneme", "Sable", "Verity"]);
  assert.equal(new Set(bundle.profiles.map((p) => p.profileId)).size, 8); assert.deepEqual(validateCorePersonaBundle(bundle), bundle);
  const schema = JSON.parse(await readFile(new URL("../packages/core/schema/core-reference-persona-v1.schema.json", import.meta.url), "utf8")); const ajv = new Ajv2020({ strict: true }); const validate = ajv.compile(schema); assert.equal(validate(bundle), true, JSON.stringify(validate.errors));
  const layers = generateCorePersonaReleaseLayers(); assert.equal(layers.length, 8); for (const layer of layers) assert.equal(layer.fields.displayOnly.presentation.category, "core-reference");
  reason("PROFILE_ADMISSION_REQUIRED", () => resolveGenericProfile({ schemaVersion: "tcrn.generic-profile-resolution-request.v1", layers: [generateCorePersonaReleaseLayers()[0]], ownerRebind: null }, null));
});

test("forbidden, tampered, duplicate, unknown, and extended roster records fail closed", () => {
  const bundle = generateCorePersonaBundle(); const first = structuredClone(bundle.profiles[0]);
  const linuxPath = ["", "home", "alice", "private", "persona.json"].join("/");
  const macPath = ["", "Users", "alice", "private", "persona.json"].join("/");
  const windowsPath = ["C:", "Users", "alice", "private", "persona.json"].join("\\");
  reason("PERSONA_UNKNOWN_FIELD", () => validateCorePersonaProfile({ ...first, threadId: "thread:private" }));
  const semanticMutations = [
    ["mission", "Use model performance settings for this public role."],
    ["mission", "Owner private preference and private family fact."],
    ["mission", `Read ${linuxPath} from Linux.`],
    ["mission", `Read ${macPath} from macOS.`],
    ["mission", `Read ${windowsPath} from Windows.`],
    ["mission", "Assert current product deployment facts and customer state."],
    ["mission", "Carry current runtime release state and retained resources."],
    ["mission", "Bind raw thread 019f-private session and conversation identifiers."],
    ["mission", "Preserve historical incident recovery and predecessor prose."],
    ["authorityBoundary", `${first.authorityBoundary} Expanded.`],
    ["collaborationRelationships", [...first.collaborationRelationships].reverse()],
  ];
  for (const [field, value] of semanticMutations) {
    const changed = { ...first, [field]: value }; delete changed.profileDigest; changed.profileDigest = canonicalSha256(changed);
    reason("PERSONA_SOURCE_MISMATCH", () => validateCorePersonaProfile(changed));
    const changedBundle = structuredClone(bundle); changedBundle.profiles[0] = changed; changedBundle.bundleDigest = canonicalSha256({ schemaVersion: changedBundle.schemaVersion, sourceManifestSha256: changedBundle.sourceManifestSha256, profiles: changedBundle.profiles });
    reason("PERSONA_SOURCE_MISMATCH", () => validateCorePersonaBundle(changedBundle));
  }
  reason("PERSONA_SCHEMA_INVALID", () => validateCorePersonaProfile({ ...first, displayName: "Extended" }));
  reason("PERSONA_CANONICAL_INVALID", () => validateCorePersonaProfile({ ...first, profileDigest: "0".repeat(64) }));
  const duplicate = structuredClone(bundle); duplicate.profiles[1] = duplicate.profiles[0]; duplicate.bundleDigest = canonicalSha256({ schemaVersion: duplicate.schemaVersion, sourceManifestSha256: duplicate.sourceManifestSha256, profiles: duplicate.profiles }); reason("PERSONA_DUPLICATE", () => validateCorePersonaBundle(duplicate));
  reason("PERSONA_SOURCE_MISMATCH", () => validateCorePersonaBundle({ ...bundle, sourceManifestSha256: "0".repeat(64) }));
});

test("schema and runtime structural boundaries have exact bidirectional parity", async () => {
  const base = structuredClone(generateCorePersonaBundle().profiles[0]);
  const schema = JSON.parse(await readFile(new URL("../packages/core/schema/core-reference-persona-v1.schema.json", import.meta.url), "utf8")); const ajv = new Ajv2020({ strict: true }); ajv.addSchema(schema); const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/profile` });
  for (const [field, value, accepted] of [["jobTitle", "x", false], ["jobTitle", "xx", true], ["jobTitle", "x".repeat(128), true], ["jobTitle", "x".repeat(129), false], ["requiredInputs", ["x"], false], ["requiredInputs", ["xx"], true], ["requiredInputs", ["x".repeat(256)], true], ["requiredInputs", ["x".repeat(257)], false]]) {
    const candidate = { ...base, [field]: value }; delete candidate.profileDigest; candidate.profileDigest = canonicalSha256(candidate); const schemaAccepted = validate(candidate); let runtimeAccepted = true; try { validateCorePersonaProfileShape(candidate); } catch { runtimeAccepted = false; } assert.equal(schemaAccepted, accepted, `${field}:schema`); assert.equal(runtimeAccepted, accepted, `${field}:runtime`);
  }
});

test("64 distinct insertion permutations normalize to identical accepted bytes", () => {
  const base = generateCorePersonaBundle(); const orders = []; const visit = (prefix, rest) => { if (orders.length >= 64) return; if (rest.length === 0) { orders.push(prefix); return; } for (let i=0;i<rest.length;i+=1) visit([...prefix, rest[i]], [...rest.slice(0,i), ...rest.slice(i+1)]); }; visit([], [...base.profiles]);
  assert.equal(orders.length, fixture.corePersonaDistinctPermutations); assert.equal(new Set(orders.map((order) => order.map((p) => p.profileId).join("|"))).size, 64);
  const acceptedBytes = []; const records = orders.map((profiles) => { const accepted = validateCorePersonaBundle({ ...base, profiles }); acceptedBytes.push(canonicalJson(accepted)); return { inputOrder: profiles.map((p) => p.profileId), acceptedDigest: canonicalSha256(accepted), bundleDigest: accepted.bundleDigest }; });
  assert.equal(new Set(acceptedBytes).size, 1); assert.equal(new Set(records.map((r) => r.bundleDigest)).size, 1); assert.equal(canonicalSha256(records), fixture.corePersonaPermutationCorpusDigest);
});

test("governed persona CLI is read-only and closed", async () => {
  let output=""; await runCli(["persona-generate", "--set", "core-reference"], { write: (v) => { output=v; } }); const generated=JSON.parse(output); assert.equal(generated.reasonCode,"PERSONA_BUNDLE_GENERATED");
  await runCli(["persona-validate", "--bundle", canonicalJson(generated.bundle)], { write: (v) => { output=v; } }); assert.equal(JSON.parse(output).reasonCode,"PERSONA_VALIDATED");
  const changed=structuredClone(generated.bundle); changed.profiles[0].mission += " Changed."; delete changed.profiles[0].profileDigest; changed.profiles[0].profileDigest=canonicalSha256(changed.profiles[0]); changed.bundleDigest=canonicalSha256({schemaVersion:changed.schemaVersion,sourceManifestSha256:changed.sourceManifestSha256,profiles:changed.profiles}); await assert.rejects(runCli(["persona-validate","--bundle",canonicalJson(changed)],{write:()=>{}}),(error)=>error?.reasonCode==="PERSONA_SOURCE_MISMATCH");
  await assert.rejects(runCli(["persona-generate", "--set", "extended"], { write:()=>{} }));
});

test("persona implementation has no legacy, network, database, hook, Skill, or runtime source authority", async () => {
  const source=await readFile(new URL("../packages/core/src/core-reference-personas.ts", import.meta.url),"utf8");
  const forbidden = [["node", ":", "fs"], ["node", ":", "http"], ["node", ":", "https"], ["process", ".", "env"], ["thread", "Id"], ["session", "Id"], ["model", "Id"], ["/", "Users", "/"], ["legacy", "/"], ["hooks", "/"], ["skills", "/"]].map((parts) => parts.join(""));
  for(const token of forbidden) assert.equal(source.includes(token),false,token);
});
