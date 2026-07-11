// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { canonicalJson } from "./canonical-json.mjs";
import { fileRecord, readJson, readSourceFile, repositoryRoot, toPosixPath, walkFiles } from "./files.mjs";

export const p3MarkerPath = ".context/platform/workflow-v3-capabilities/p3-local-work-graph.accepted.json";

const p2SchemaNames = new Set([
  "compatibility-v1.schema.json",
  "context-v1.schema.json",
  "event-integrity-v1.schema.json",
  "exchange-v1.schema.json",
  "extension-registration-v1.schema.json",
  "knowledge-model-v1.schema.json",
  "p3-acceptance-marker-v1.schema.json",
  "profile-trust-v1.schema.json",
  "protocol-common-v1.schema.json",
  "receipt-v1.schema.json",
  "work-model-v1.schema.json",
]);

export class ProtocolProofError extends Error {
  constructor(reasonCode, message) {
    super(message);
    this.name = "ProtocolProofError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode, message) {
  throw new ProtocolProofError(reasonCode, message);
}

function assertion(condition, reasonCode, message) {
  if (!condition) {
    fail(reasonCode, message);
  }
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function canonicalBytes(value) {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

function collectRequirementIds(value, output = new Set()) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectRequirementIds(entry, output);
    }
  } else if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if ((key === "requirementIds" || key === "x-tcrn-aos-requirementIds") && Array.isArray(entry)) {
        for (const id of entry) {
          output.add(id);
        }
      }
      collectRequirementIds(entry, output);
    }
  }
  return output;
}

export async function validateAosLedger() {
  const ledger = await readJson(resolve(repositoryRoot, "extensions/aos-requirements-v1.json"));
  assertion(ledger.schemaVersion === "tcrn.aos-requirements.v1", "AOS_LEDGER_SCHEMA", "Unexpected ledger schema");
  assertion(Array.isArray(ledger.requirements) && ledger.requirements.length > 0, "AOS_LEDGER_EMPTY", "No requirements");
  const ids = new Set();
  const maturityCounts = { specified: 0, fixture_verified: 0 };
  for (const requirement of ledger.requirements) {
    assertion(/^AOS-REQ-[0-9]{3}$/u.test(requirement.id), "AOS_REQUIREMENT_ID", requirement.id);
    assertion(!ids.has(requirement.id), "AOS_REQUIREMENT_DUPLICATE", requirement.id);
    ids.add(requirement.id);
    assertion(["specified", "fixture_verified"].includes(requirement.maturity), "AOS_MATURITY_OVERCLAIM", requirement.id);
    maturityCounts[requirement.maturity] += 1;
    assertion(Object.keys(requirement).sort().join("\0") === ["id", "maturity", "subject"].sort().join("\0"), "AOS_REQUIREMENT_FIELDS", requirement.id);
  }
  const forbiddenKeys = new Set(["endpoint", "credential", "database", "releasePairs", "runtimeMutation"]);
  assertion(!Object.keys(ledger).some((key) => forbiddenKeys.has(key)), "AOS_IMPLEMENTATION_ASSUMPTION", "Forbidden implementation field");

  const linkedIds = new Set();
  const files = await walkFiles();
  const aosFiles = files.filter((path) => {
    const name = toPosixPath(relative(repositoryRoot, path));
    return (name.startsWith("schemas/") && p2SchemaNames.has(name.slice("schemas/".length))) ||
      name.startsWith("fixtures/protocol/");
  });
  for (const path of aosFiles) {
    const document = await readJson(path);
    const documentIds = collectRequirementIds(document);
    assertion(documentIds.size > 0, "AOS_REQUIREMENT_LINK_MISSING", toPosixPath(relative(repositoryRoot, path)));
    for (const id of documentIds) {
      assertion(ids.has(id), "AOS_REQUIREMENT_UNKNOWN", `${toPosixPath(relative(repositoryRoot, path))}:${id}`);
      linkedIds.add(id);
    }
  }
  assertion([...ids].every((id) => linkedIds.has(id)), "AOS_REQUIREMENT_UNREFERENCED", [...ids].filter((id) => !linkedIds.has(id)).join(","));
  return {
    requirements: ids.size,
    linkedFiles: aosFiles.length,
    maturityCounts,
    liveCompatibility: "not-claimed",
    currentRuntimeMutation: "not-performed",
  };
}

export async function validateP2SchemasAndFixtures() {
  const files = await walkFiles();
  const schemas = files.filter((path) => toPosixPath(relative(repositoryRoot, path)).startsWith("schemas/"));
  let p2Schemas = 0;
  for (const path of schemas) {
    const name = toPosixPath(relative(repositoryRoot, path));
    const document = await readJson(path);
    assertion(document.$schema === "https://json-schema.org/draft/2020-12/schema", "P2_SCHEMA_DIALECT", name);
    assertion(typeof document.$id === "string" && document.$id.endsWith(name.slice("schemas/".length)), "P2_SCHEMA_ID", name);
    assertion(document.type === "object" && document.additionalProperties === false, "P2_SCHEMA_CLOSED", name);
    const content = (await readSourceFile(path)).toString("utf8");
    for (const match of content.matchAll(/"\$ref": "\.\/([^"#]+)(?:#[^"]*)?"/gu)) {
      assertion(schemas.some((candidate) => candidate.endsWith(`/${match[1]}`)), "P2_SCHEMA_REF_MISSING", `${name}:${match[1]}`);
    }
    if (p2SchemaNames.has(name.slice("schemas/".length))) {
      assertion(Array.isArray(document["x-tcrn-aos-requirementIds"]), "AOS_REQUIREMENT_LINK_MISSING", name);
      p2Schemas += 1;
    }
  }
  assertion(p2Schemas === p2SchemaNames.size, "P2_SCHEMA_SET_INCOMPLETE", `${p2Schemas}/${p2SchemaNames.size}`);

  const fixtures = files.filter((path) => toPosixPath(relative(repositoryRoot, path)).startsWith("fixtures/protocol/") && path.endsWith(".json"));
  for (const path of fixtures) {
    const content = (await readSourceFile(path)).toString("utf8");
    assertion(!content.includes("PENDING"), "P2_FIXTURE_PENDING", toPosixPath(relative(repositoryRoot, path)));
    const document = JSON.parse(content);
    assertion(document.aosFacing === true && Array.isArray(document.requirementIds), "AOS_REQUIREMENT_LINK_MISSING", toPosixPath(relative(repositoryRoot, path)));
  }
  const marker = resolve(repositoryRoot, p3MarkerPath);
  try {
    await lstat(marker);
    fail("P3_MARKER_PRESENT", marker);
  } catch (error) {
    if (error instanceof ProtocolProofError || error.code !== "ENOENT") {
      throw error;
    }
  }
  return { schemas: p2Schemas, fixtures: fixtures.length, p3Marker: "absent" };
}

export async function normativeInputPaths() {
  const policy = await readJson(resolve(repositoryRoot, "scripts/policy/rc1-inputs.json"));
  assertion(Array.isArray(policy.normativeInputs), "RC1_INPUT_POLICY", "normativeInputs must be an array");
  const discovered = (await walkFiles())
    .map((path) => toPosixPath(relative(repositoryRoot, path)))
    .filter((path) => path === "extensions/aos-requirements-v1.json" || path.startsWith("schemas/") || path.startsWith("specs/") ||
      (path.startsWith("fixtures/") && !path.startsWith("fixtures/rc1/")) || path === "verification-map.yaml")
    .sort((left, right) => left.localeCompare(right, "en"));
  const declared = [...policy.normativeInputs].sort((left, right) => left.localeCompare(right, "en"));
  assertion(JSON.stringify(discovered) === JSON.stringify(declared), "RC1_INPUT_SET_MISMATCH", "Normative input policy is stale");
  return declared;
}

export async function calculateRc1InputRecords() {
  const paths = await normativeInputPaths();
  const records = await Promise.all(paths.map((path) => fileRecord(resolve(repositoryRoot, path))));
  records.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return records;
}

export async function validateRc1Candidate() {
  const manifestPath = resolve(repositoryRoot, "fixtures/rc1/rc1-candidate-proof-manifest.json");
  const manifest = await readJson(manifestPath);
  assertion(manifest.schemaVersion === "tcrn.rc1-candidate-proof-manifest.v1", "RC1_MANIFEST_SCHEMA", manifest.schemaVersion);
  assertion(manifest.status === "candidate_unreviewed" && manifest.accepted === false, "RC1_ACCEPTANCE_OVERCLAIM", manifest.status);
  const records = await calculateRc1InputRecords();
  assertion(JSON.stringify(manifest.inputs) === JSON.stringify(records), "RC1_MANIFEST_INPUT_MISMATCH", "Input hashes changed");
  const basisDigest = sha256(canonicalBytes(records));
  assertion(manifest.basisDigest === basisDigest, "RC1_MANIFEST_BASIS_DIGEST", basisDigest);
  const requiredRoles = [
    "platform-workflow-architect",
    "workflow-verification-engineer",
    "security-risk-reviewer",
    "reality-checker",
  ];
  assertion(Object.keys(manifest.roleVerdictSlots).sort().join("\0") === requiredRoles.sort().join("\0"), "RC1_VERDICT_SLOTS", "Required role slots differ");
  for (const role of requiredRoles) {
    const slot = manifest.roleVerdictSlots[role];
    assertion(slot.status === "unresolved" && slot.verdict === null && slot.basisDigest === null, "RC1_VERDICT_FABRICATED", role);
  }
  const manifestDigest = sha256(canonicalBytes(manifest));
  return {
    basisDigest,
    manifestDigest,
    inputs: records.length,
    unresolvedVerdictSlots: requiredRoles,
    accepted: false,
  };
}
