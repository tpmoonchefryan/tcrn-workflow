// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { relative, resolve } from "node:path";

import Ajv2020 from "ajv/dist/2020.js";

import { CanonicalJsonError, canonicalDocumentBytes, canonicalJson } from "./canonical-json.mjs";
import { compareCanonicalText } from "./canonical-order.mjs";
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

export function canonicalProofBytes(value) {
  try {
    // OD-16 F1: the trailing newline is `canonicalDocumentBytes`'s business now. This
    // wrapper adds an RC1 reason code, not a byte.
    return canonicalDocumentBytes(value);
  } catch (error) {
    if (error instanceof CanonicalJsonError) {
      fail("RC1_CANONICAL_VALUE_INVALID", error.message);
    }
    throw error;
  }
}

function withPathValue(value, path, replacement) {
  const copy = structuredClone(value);
  let target = copy;
  for (const segment of path.slice(0, -1)) {
    target = target[segment];
  }
  target[path.at(-1)] = replacement;
  return copy;
}

function assertExactObjectFields(value, expected, reasonCode, label) {
  assertion(value !== null && typeof value === "object" && !Array.isArray(value), reasonCode, `${label} must be an object`);
  const actual = Object.keys(value).sort(compareCanonicalText);
  const required = [...expected].sort(compareCanonicalText);
  assertion(JSON.stringify(actual) === JSON.stringify(required), reasonCode,
    `${label} fields=${actual.join(",")};required=${required.join(",")}`);
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
    assertion(Object.keys(requirement).sort(compareCanonicalText).join("\0") === ["id", "maturity", "subject"].sort(compareCanonicalText).join("\0"), "AOS_REQUIREMENT_FIELDS", requirement.id);
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
  let resolvedLocalRefs = 0;
  const p2Documents = [];
  for (const path of schemas) {
    const name = toPosixPath(relative(repositoryRoot, path));
    const document = await readJson(path);
    assertion(document.$schema === "https://json-schema.org/draft/2020-12/schema", "P2_SCHEMA_DIALECT", name);
    assertion(typeof document.$id === "string" && document.$id.endsWith(name.slice("schemas/".length)), "P2_SCHEMA_ID", name);
    assertion(document.type === "object" && document.additionalProperties === false, "P2_SCHEMA_CLOSED", name);
    const content = (await readSourceFile(path)).toString("utf8");
    for (const match of content.matchAll(/"\$ref": "\.\/([^"#]+)(?:#[^"]*)?"/gu)) {
      assertion(schemas.some((candidate) => candidate.endsWith(`/${match[1]}`)), "P2_SCHEMA_REF_MISSING", `${name}:${match[1]}`);
      resolvedLocalRefs += 1;
    }
    if (p2SchemaNames.has(name.slice("schemas/".length))) {
      assertion(Array.isArray(document["x-tcrn-aos-requirementIds"]), "AOS_REQUIREMENT_LINK_MISSING", name);
      p2Documents.push(document);
      p2Schemas += 1;
    }
  }
  assertion(p2Schemas === p2SchemaNames.size, "P2_SCHEMA_SET_INCOMPLETE", `${p2Schemas}/${p2SchemaNames.size}`);

  const ajv = new Ajv2020({ allErrors: true, strict: true, validateSchema: true });
  ajv.addKeyword({ keyword: "x-tcrn-aos-requirementIds", schemaType: "array" });
  let metaSchemasValidated = 0;
  for (const document of p2Documents) {
    assertion(ajv.validateSchema(document), "P2_SCHEMA_META_INVALID", `${document.$id}:${ajv.errorsText()}`);
    ajv.addSchema(document);
    metaSchemasValidated += 1;
  }

  const schemaCases = await readJson(resolve(repositoryRoot, "fixtures/protocol/v1/schema-cases.json"));
  assertion(schemaCases.schemaVersion === "tcrn.schema-cases.v1" && schemaCases.simulationOnly === true &&
    schemaCases.p3CapabilityClaimed === false && Array.isArray(schemaCases.cases), "P2_SCHEMA_CASES_INVALID", "Schema cases contract");
  let schemaPositiveCases = 0;
  let schemaNegativeCases = 0;
  const seenSchemas = new Set();
  for (const schemaCase of schemaCases.cases) {
    assertion(p2SchemaNames.has(schemaCase.schema), "P2_SCHEMA_CASE_UNKNOWN", schemaCase.schema);
    assertion(!seenSchemas.has(schemaCase.schema), "P2_SCHEMA_CASE_DUPLICATE", schemaCase.schema);
    seenSchemas.add(schemaCase.schema);
    const schema = p2Documents.find((entry) => entry.$id.endsWith(schemaCase.schema));
    const validate = schema ? ajv.getSchema(schema.$id) : undefined;
    assertion(typeof validate === "function", "P2_SCHEMA_COMPILE_FAILED", schemaCase.schema);
    assertion(validate(schemaCase.valid), "P2_SCHEMA_POSITIVE_REJECTED", `${schemaCase.schema}:${ajv.errorsText(validate.errors)}`);
    schemaPositiveCases += 1;
    assertion(Array.isArray(schemaCase.invalid) && schemaCase.invalid.length >= 2, "P2_SCHEMA_NEGATIVE_MISSING", schemaCase.schema);
    for (const invalid of schemaCase.invalid) {
      assertion(!validate(invalid), "P2_SCHEMA_NEGATIVE_ADMITTED", schemaCase.schema);
      schemaNegativeCases += 1;
    }
  }
  assertion(seenSchemas.size === p2SchemaNames.size, "P2_SCHEMA_CASE_SET_INCOMPLETE", `${seenSchemas.size}/${p2SchemaNames.size}`);

  const idBoundaryCases = schemaCases.idBoundaryCases;
  assertion(idBoundaryCases?.maximumLength === 161 && idBoundaryCases.maximumId.length === 161 &&
    idBoundaryCases.overlongId.length === 162 && Array.isArray(idBoundaryCases.targets),
  "P2_ID_BOUNDARY_CASES_INVALID", "Stable ID boundary fixture");
  let stableIdBoundaryCases = 0;
  for (const boundaryCase of idBoundaryCases.targets) {
    const schemaCase = schemaCases.cases.find((entry) => entry.schema === boundaryCase.schema);
    const schema = p2Documents.find((entry) => entry.$id.endsWith(boundaryCase.schema));
    const validate = schema ? ajv.getSchema(schema.$id) : undefined;
    assertion(schemaCase && typeof validate === "function" && Array.isArray(boundaryCase.path),
      "P2_ID_BOUNDARY_TARGET_INVALID", boundaryCase.schema);
    assertion(validate(withPathValue(schemaCase.valid, boundaryCase.path, idBoundaryCases.maximumId)),
      "P2_ID_MAXIMUM_REJECTED", `${boundaryCase.schema}:${boundaryCase.path.join(".")}:${ajv.errorsText(validate.errors)}`);
    assertion(!validate(withPathValue(schemaCase.valid, boundaryCase.path, idBoundaryCases.overlongId)),
      "P2_ID_OVERLONG_ADMITTED", `${boundaryCase.schema}:${boundaryCase.path.join(".")}`);
    stableIdBoundaryCases += 1;
  }

  const commonSchema = p2Documents.find((entry) => entry.$id.endsWith("protocol-common-v1.schema.json"));
  const validateExtensionMap = ajv.compile({ $ref: `${commonSchema.$id}#/$defs/extensionMap` });
  const extensionNameCases = schemaCases.extensionNameCases;
  assertion(typeof extensionNameCases?.valid === "string" && Array.isArray(extensionNameCases.invalid),
    "P2_EXTENSION_NAME_CASES_INVALID", "Extension-name fixture");
  assertion(validateExtensionMap({ [extensionNameCases.valid]: { required: false, value: null } }),
    "P2_EXTENSION_NAME_MAXIMUM_REJECTED", ajv.errorsText(validateExtensionMap.errors));
  for (const invalidName of extensionNameCases.invalid) {
    assertion(!validateExtensionMap({ [invalidName]: { required: false, value: null } }),
      "P2_EXTENSION_NAME_INVALID_ADMITTED", invalidName);
  }

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
  return {
    schemas: p2Schemas,
    fixtures: fixtures.length,
    metaSchemasValidated,
    schemaPositiveCases,
    schemaNegativeCases,
    stableIdMaximumLength: idBoundaryCases.maximumLength,
    stableIdBoundaryCases,
    extensionNameCases: 1 + extensionNameCases.invalid.length,
    resolvedLocalRefs,
    evaluator: "ajv@8.17.1-draft-2020-12",
    p3Marker: "absent",
  };
}

export async function normativeInputPaths() {
  const policy = await readJson(resolve(repositoryRoot, "scripts/policy/rc1-inputs.json"));
  assertion(Array.isArray(policy.normativeInputs), "RC1_INPUT_POLICY", "normativeInputs must be an array");
  const discovered = (await walkFiles())
    .map((path) => toPosixPath(relative(repositoryRoot, path)))
    .filter((path) => path === "extensions/aos-requirements-v1.json" || path.startsWith("schemas/") || path.startsWith("specs/") ||
      (path.startsWith("fixtures/") && !path.startsWith("fixtures/rc1/")) || path === "verification-map.yaml")
    .sort(compareCanonicalText);
  const declared = [...policy.normativeInputs].sort(compareCanonicalText);
  assertion(JSON.stringify(discovered) === JSON.stringify(declared), "RC1_INPUT_SET_MISMATCH", "Normative input policy is stale");
  return declared;
}

export async function calculateRc1InputRecords() {
  const paths = await normativeInputPaths();
  const records = await Promise.all(paths.map((path) => fileRecord(resolve(repositoryRoot, path))));
  records.sort((left, right) => compareCanonicalText(left.path, right.path));
  return records;
}

export function validateRc1ManifestShape(manifest) {
  canonicalProofBytes(manifest);
  assertExactObjectFields(
    manifest,
    ["schemaVersion", "status", "accepted", "basisDigest", "inputs", "roleVerdictSlots"],
    "RC1_MANIFEST_FIELDS",
    "RC1 candidate manifest",
  );
  const requiredRoles = [
    "platform-workflow-architect",
    "workflow-verification-engineer",
    "security-risk-reviewer",
    "reality-checker",
  ];
  assertExactObjectFields(manifest.roleVerdictSlots, requiredRoles, "RC1_VERDICT_SLOTS", "RC1 role verdict slots");
  for (const role of requiredRoles) {
    assertExactObjectFields(
      manifest.roleVerdictSlots[role],
      ["status", "verdict", "basisDigest"],
      "RC1_VERDICT_SLOT_FIELDS",
      role,
    );
  }
  return requiredRoles;
}

export async function validateRc1Candidate() {
  const manifestPath = resolve(repositoryRoot, "fixtures/rc1/rc1-candidate-proof-manifest.json");
  const manifest = await readJson(manifestPath);
  const requiredRoles = validateRc1ManifestShape(manifest);
  assertion(manifest.schemaVersion === "tcrn.rc1-candidate-proof-manifest.v1", "RC1_MANIFEST_SCHEMA", manifest.schemaVersion);
  assertion(manifest.status === "candidate_unreviewed" && manifest.accepted === false, "RC1_ACCEPTANCE_OVERCLAIM", manifest.status);
  const records = await calculateRc1InputRecords();
  const recordBytes = canonicalProofBytes(records);
  assertion(JSON.stringify(manifest.inputs) === JSON.stringify(records), "RC1_MANIFEST_INPUT_MISMATCH", "Input hashes changed");
  const basisDigest = sha256(recordBytes);
  assertion(manifest.basisDigest === basisDigest, "RC1_MANIFEST_BASIS_DIGEST", basisDigest);
  for (const role of requiredRoles) {
    const slot = manifest.roleVerdictSlots[role];
    assertion(slot.status === "unresolved" && slot.verdict === null && slot.basisDigest === null, "RC1_VERDICT_FABRICATED", role);
  }
  const manifestDigest = sha256(canonicalProofBytes(manifest));
  return {
    basisDigest,
    manifestDigest,
    inputs: records.length,
    unresolvedVerdictSlots: requiredRoles,
    accepted: false,
  };
}
