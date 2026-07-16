// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import {
  DEPENDENCY_VERSION,
  assertDependencyEndpoints,
  assertNoDependencyCycle,
  canonicalDependencyDigest,
  listDependenciesByWorkItem,
  listDependencyBlockers,
  orderDependencies,
  validateDependencyRecord,
} from "../dist/build/packages/core/src/index.js";
import { canonicalJson, canonicalSha256 } from "../dist/build/packages/protocol/src/index.js";

const fixture = JSON.parse(await readFile(new URL("../packages/core/fixtures/dependency-cases.json", import.meta.url), "utf8"));
const clone = structuredClone;

function reason(code, operation) { assert.throws(operation, (error) => error?.reasonCode === code, code); }

function dependency(overrides = {}) {
  return {
    schemaVersion: DEPENDENCY_VERSION,
    id: "dependency:one",
    projectId: "project:alpha",
    fromWorkId: "work:a",
    toWorkId: "work:b",
    kind: "blocks",
    status: "active",
    revision: 1,
    updatedAt: "2026-07-16T00:00:00Z",
    tombstone: false,
    extensions: {},
    ...overrides,
  };
}

const works = [
  { id: "work:a", projectId: "project:alpha", tombstone: false },
  { id: "work:b", projectId: "project:alpha", tombstone: false },
  { id: "work:c", projectId: "project:alpha", tombstone: false },
  { id: "work:dead", projectId: "project:alpha", tombstone: true },
  { id: "work:x", projectId: "project:beta", tombstone: false },
];

function permutations(values) {
  const output = [];
  const visit = (prefix, rest) => { if (rest.length === 0) output.push(prefix); else rest.forEach((value, index) => visit([...prefix, value], [...rest.slice(0, index), ...rest.slice(index + 1)])); };
  visit([], values); return output;
}

test("valid dependencies validate across kinds and statuses", () => {
  const positives = [
    dependency(),
    dependency({ id: "dependency:informs", kind: "informs" }),
    dependency({ id: "dependency:resolved", status: "resolved" }),
    dependency({ id: "dependency:waived", status: "waived", waivedReason: "superseded by direct rework", waivedByActorId: "actor:owner" }),
    dependency({ id: "dependency:tomb", tombstone: true }),
    dependency({ id: "dependency:beta", projectId: "project:beta", fromWorkId: "work:x", toWorkId: "work:y" }),
  ];
  assert.equal(positives.length, fixture.positiveCases);
  for (const value of positives) {
    const validated = validateDependencyRecord(value);
    assert.equal(validated.schemaVersion, DEPENDENCY_VERSION);
    assert.equal(Object.isFrozen(validated), true);
  }
});

test("canonical digest is stable across key order and covers unknown optional extensions", () => {
  const base = dependency({ extensions: { "extension:risk": { required: false, value: { level: 2 } }, "extension:note": { required: false, value: { text: "keep" } } } });
  const reordered = Object.fromEntries(Object.entries(base).reverse());
  const withReorderedExtensions = dependency({ extensions: { "extension:note": { required: false, value: { text: "keep" } }, "extension:risk": { required: false, value: { level: 2 } } } });
  const cases = [
    [base, reordered],
    [base, withReorderedExtensions],
    [dependency({ status: "waived", waivedReason: "r", waivedByActorId: "actor:o" }), Object.fromEntries(Object.entries(dependency({ status: "waived", waivedReason: "r", waivedByActorId: "actor:o" })).reverse())],
  ];
  assert.equal(cases.length, fixture.hashStabilityCases);
  for (const [left, right] of cases) assert.equal(canonicalDependencyDigest(left), canonicalDependencyDigest(right));
  // digest changes when an extension value changes
  assert.notEqual(canonicalDependencyDigest(base), canonicalDependencyDigest(dependency({ extensions: { "extension:risk": { required: false, value: { level: 3 } }, "extension:note": { required: false, value: { text: "keep" } } } })));
});

test("hostile records fail closed", () => {
  const hostile = [
    () => reason("DEPENDENCY_UNKNOWN_FIELD", () => validateDependencyRecord({ ...dependency(), extra: true })),
    () => reason("DEPENDENCY_SCHEMA_INVALID", () => validateDependencyRecord(Object.fromEntries(Object.entries(dependency()).filter(([field]) => field !== "kind")))),
    () => reason("DEPENDENCY_SELF_EDGE", () => validateDependencyRecord(dependency({ toWorkId: "work:a" }))),
    () => reason("DEPENDENCY_WAIVED_AUDIT_REQUIRED", () => validateDependencyRecord(dependency({ status: "waived", waivedByActorId: "actor:o" }))),
    () => reason("DEPENDENCY_WAIVED_AUDIT_REQUIRED", () => validateDependencyRecord(dependency({ status: "waived", waivedReason: "r" }))),
    () => reason("DEPENDENCY_WAIVED_AUDIT_FORBIDDEN", () => validateDependencyRecord(dependency({ waivedReason: "r", waivedByActorId: "actor:o" }))),
    () => reason("DEPENDENCY_SCHEMA_INVALID", () => validateDependencyRecord(dependency({ kind: "requires" }))),
    () => reason("DEPENDENCY_SCHEMA_INVALID", () => validateDependencyRecord(dependency({ status: "open" }))),
    () => reason("DEPENDENCY_SCHEMA_INVALID", () => validateDependencyRecord(dependency({ revision: 0 }))),
    () => reason("DEPENDENCY_SCHEMA_INVALID", () => validateDependencyRecord(dependency({ updatedAt: "2026-07-16" }))),
    () => reason("DEPENDENCY_SCHEMA_INVALID", () => validateDependencyRecord(dependency({ id: "NotAnId" }))),
    () => reason("DEPENDENCY_SCHEMA_INVALID", () => validateDependencyRecord(dependency({ tombstone: "false" }))),
    () => reason("DEPENDENCY_UNICODE_INVALID", () => validateDependencyRecord(dependency({ status: "waived", waivedReason: "\ud800", waivedByActorId: "actor:o" }))),
    () => reason("DEPENDENCY_BUDGET_EXCEEDED", () => validateDependencyRecord(dependency({ status: "waived", waivedReason: "x".repeat(513), waivedByActorId: "actor:o" }))),
    () => reason("DEPENDENCY_SCHEMA_INVALID", () => validateDependencyRecord(dependency({ extensions: { "extension:bad": { required: "yes", value: {} } } }))),
    () => reason("DEPENDENCY_SCHEMA_INVALID", () => validateDependencyRecord(dependency({ extensions: [] }))),
  ];
  assert.equal(hostile.length, fixture.hostileCases);
  for (const operation of hostile) operation();
});

test("endpoint rules require live same-project work records", () => {
  const cases = [
    () => assert.equal(assertDependencyEndpoints(dependency(), works).id, "dependency:one"),
    () => reason("DEPENDENCY_ENDPOINT_MISSING", () => assertDependencyEndpoints(dependency({ toWorkId: "work:ghost" }), works)),
    () => reason("DEPENDENCY_ENDPOINT_TOMBSTONED", () => assertDependencyEndpoints(dependency({ toWorkId: "work:dead" }), works)),
    () => reason("DEPENDENCY_CROSS_PROJECT", () => assertDependencyEndpoints(dependency({ toWorkId: "work:x" }), works)),
    () => reason("DEPENDENCY_CROSS_PROJECT", () => assertDependencyEndpoints(dependency({ projectId: "project:beta", fromWorkId: "work:x", toWorkId: "work:a" }), works)),
    () => assert.equal(assertDependencyEndpoints(dependency({ tombstone: true, toWorkId: "work:ghost" }), works).tombstone, true),
  ];
  assert.equal(cases.length, fixture.endpointCases);
  for (const operation of cases) operation();
});

test("cycle detection covers only active blocks edges", () => {
  const cycle = [
    dependency({ id: "dependency:ab", fromWorkId: "work:a", toWorkId: "work:b" }),
    dependency({ id: "dependency:bc", fromWorkId: "work:b", toWorkId: "work:c" }),
    dependency({ id: "dependency:ca", fromWorkId: "work:c", toWorkId: "work:a" }),
  ];
  const cases = [
    () => reason("DEPENDENCY_CYCLE", () => assertNoDependencyCycle(cycle)),
    () => assert.equal(assertNoDependencyCycle(cycle.slice(0, 2)).length, 2),
    () => assert.equal(assertNoDependencyCycle([...cycle.slice(0, 2), dependency({ id: "dependency:ca2", fromWorkId: "work:c", toWorkId: "work:a", kind: "informs" })]).length, 3),
    () => assert.equal(assertNoDependencyCycle([...cycle.slice(0, 2), dependency({ id: "dependency:ca3", fromWorkId: "work:c", toWorkId: "work:a", status: "resolved" })]).length, 3),
    () => assert.equal(assertNoDependencyCycle([...cycle.slice(0, 2), dependency({ id: "dependency:ca4", fromWorkId: "work:c", toWorkId: "work:a", tombstone: true })]).length, 3),
  ];
  assert.equal(cases.length, fixture.cycleCases);
  for (const operation of cases) operation();
});

test("list-blockers and list-by-work-item return canonical-ordered edges", () => {
  const graph = [
    dependency({ id: "dependency:ab", fromWorkId: "work:a", toWorkId: "work:b" }),
    dependency({ id: "dependency:cb", fromWorkId: "work:c", toWorkId: "work:b" }),
    dependency({ id: "dependency:cb-inform", fromWorkId: "work:c", toWorkId: "work:b", kind: "informs" }),
    dependency({ id: "dependency:cb-resolved", fromWorkId: "work:c", toWorkId: "work:b", status: "resolved" }),
    dependency({ id: "dependency:bd", fromWorkId: "work:b", toWorkId: "work:d" }),
  ];
  const blockers = listDependencyBlockers("work:b", graph);
  const cases = [
    () => assert.deepEqual(blockers.map((edge) => edge.id), ["dependency:ab", "dependency:cb"]),
    () => assert.equal(listDependenciesByWorkItem("work:b", graph).length, 5),
    () => assert.equal(listDependencyBlockers("work:d", graph).length, 1),
  ];
  assert.equal(cases.length, fixture.blockerReadCases);
  for (const operation of cases) operation();
});

test("deterministic ordering over projectId then id across all permutations", () => {
  const records = [
    dependency({ id: "dependency:2", projectId: "project:alpha" }),
    dependency({ id: "dependency:1", projectId: "project:alpha" }),
    dependency({ id: "dependency:1", projectId: "project:beta", fromWorkId: "work:x", toWorkId: "work:y" }),
    dependency({ id: "dependency:9", projectId: "project:alpha" }),
  ];
  const orders = permutations(records);
  assert.equal(orders.length, fixture.orderingPermutations);
  const digests = new Set();
  const corpus = [];
  for (let index = 0; index < orders.length; index += 1) {
    const ordered = orderDependencies(orders[index]);
    digests.add(canonicalSha256(ordered.map((edge) => `${edge.projectId}|${edge.id}`)));
    corpus.push(ordered.map((edge) => edge.id));
  }
  assert.equal(digests.size, 1);
  const first = orderDependencies(records);
  assert.deepEqual(first.map((edge) => `${edge.projectId}|${edge.id}`), ["project:alpha|dependency:1", "project:alpha|dependency:2", "project:alpha|dependency:9", "project:beta|dependency:1"]);
  assert.equal(canonicalSha256(corpus), fixture.orderingCorpusDigest);
});

test("Draft 2020-12 schema and runtime agree", async () => {
  const dependencySchema = JSON.parse(await readFile(new URL("../schemas/dependency-v1.schema.json", import.meta.url), "utf8"));
  const protocolSchema = JSON.parse(await readFile(new URL("../schemas/protocol-common-v1.schema.json", import.meta.url), "utf8"));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  ajv.addKeyword({ keyword: "x-tcrn-maxUtf8Bytes", type: "string", schemaType: "number", validate: (limit, value) => Buffer.byteLength(value, "utf8") <= limit });
  ajv.addSchema(protocolSchema);
  const validate = ajv.compile(dependencySchema);
  const valid = dependency();
  assert.equal(validate(valid), true); validateDependencyRecord(valid);
  const waived = dependency({ status: "waived", waivedReason: "r", waivedByActorId: "actor:o" });
  assert.equal(validate(waived), true); validateDependencyRecord(waived);
  const vectors = [
    { ...valid, extra: true },
    dependency({ kind: "requires" }),
    dependency({ status: "open" }),
    dependency({ revision: 0 }),
    dependency({ id: "NotAnId" }),
    dependency({ status: "waived", waivedReason: "r" }),
    dependency({ waivedReason: "r", waivedByActorId: "actor:o" }),
    dependency({ updatedAt: "2026-07-16" }),
  ];
  assert.equal(vectors.length, fixture.schemaParityCases);
  for (const vector of vectors) {
    assert.equal(validate(vector), false);
    assert.throws(() => validateDependencyRecord(vector));
  }
});

test("extension registration record binds appliesTo work and the dependency schema digest", async () => {
  const registrationSchema = JSON.parse(await readFile(new URL("../schemas/extension-registration-v1.schema.json", import.meta.url), "utf8"));
  const protocolSchema = JSON.parse(await readFile(new URL("../schemas/protocol-common-v1.schema.json", import.meta.url), "utf8"));
  const schemaBytes = await readFile(new URL("../schemas/dependency-v1.schema.json", import.meta.url));
  const schemaDigest = createHash("sha256").update(schemaBytes).digest("hex");
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  ajv.addKeyword({ keyword: "x-tcrn-aos-requirementIds", schemaType: "array" });
  ajv.addSchema(protocolSchema);
  const validate = ajv.compile(registrationSchema);
  const registration = {
    schemaVersion: "tcrn.extension-registration.v1",
    id: "extension:dependency",
    version: 1,
    requiredByDefault: fixture.requiredByDefault,
    appliesTo: [fixture.registrationAppliesTo],
    schemaDigest,
  };
  assert.equal(validate(registration), true);
  assert.equal(canonicalJson(registration).includes(schemaDigest), true);
});
