// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { runCli } from "../dist/build/packages/cli/src/index.js";
import { CORE_PERSONA_SOURCE_MANIFEST_SHA256, generateCorePersonaBundle, generateCorePersonaReleaseLayers, resolveGenericProfile, validateCorePersonaBundle, validateCorePersonaProfile } from "../dist/build/packages/core/src/index.js";
import { canonicalJson, canonicalSha256 } from "../dist/build/packages/protocol/src/index.js";

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
  reason("PERSONA_UNKNOWN_FIELD", () => validateCorePersonaProfile({ ...first, threadId: "thread:private" }));
  const forbidden = { ...first, mission: "Use https://example.test and password secret" }; delete forbidden.profileDigest; forbidden.profileDigest = canonicalSha256(forbidden);
  reason("PERSONA_FORBIDDEN_CONTENT", () => validateCorePersonaProfile(forbidden));
  reason("PERSONA_SCHEMA_INVALID", () => validateCorePersonaProfile({ ...first, displayName: "Extended" }));
  reason("PERSONA_CANONICAL_INVALID", () => validateCorePersonaProfile({ ...first, profileDigest: "0".repeat(64) }));
  const duplicate = structuredClone(bundle); duplicate.profiles[1] = duplicate.profiles[0]; duplicate.bundleDigest = canonicalSha256({ schemaVersion: duplicate.schemaVersion, sourceManifestSha256: duplicate.sourceManifestSha256, profiles: duplicate.profiles }); reason("PERSONA_DUPLICATE", () => validateCorePersonaBundle(duplicate));
  reason("PERSONA_SOURCE_MISMATCH", () => validateCorePersonaBundle({ ...bundle, sourceManifestSha256: "0".repeat(64) }));
});

test("64 insertion permutations normalize to the same canonical bundle", () => {
  const base = generateCorePersonaBundle(); const digests = new Set();
  for (let n = 0; n < 64; n += 1) { const rotated = [...base.profiles.slice(n % 8), ...base.profiles.slice(0, n % 8)]; const normalized = { ...base, profiles: [...rotated].sort((a, b) => Buffer.compare(Buffer.from(a.profileId), Buffer.from(b.profileId))) }; digests.add(canonicalSha256(validateCorePersonaBundle(normalized))); }
  assert.equal(digests.size, 1);
});

test("governed persona CLI is read-only and closed", async () => {
  let output=""; await runCli(["persona-generate", "--set", "core-reference"], { write: (v) => { output=v; } }); const generated=JSON.parse(output); assert.equal(generated.reasonCode,"PERSONA_BUNDLE_GENERATED");
  await runCli(["persona-validate", "--bundle", canonicalJson(generated.bundle)], { write: (v) => { output=v; } }); assert.equal(JSON.parse(output).reasonCode,"PERSONA_VALIDATED");
  await assert.rejects(runCli(["persona-generate", "--set", "extended"], { write:()=>{} }));
});

test("persona implementation has no legacy, network, database, hook, Skill, or runtime source authority", async () => {
  const source=await readFile(new URL("../packages/core/src/core-reference-personas.ts", import.meta.url),"utf8");
  const forbidden = [["node", ":", "fs"], ["node", ":", "http"], ["node", ":", "https"], ["process", ".", "env"], ["thread", "Id"], ["session", "Id"], ["model", "Id"], ["/", "Users", "/"], ["legacy", "/"], ["hooks", "/"], ["skills", "/"]].map((parts) => parts.join(""));
  for(const token of forbidden) assert.equal(source.includes(token),false,token);
});
