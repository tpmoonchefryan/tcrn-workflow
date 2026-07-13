// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { canonicalJson, canonicalSha256 } from "../dist/build/packages/protocol/src/index.js";
import {
  PUBLIC_AOS_REQUIREMENTS_REASON_CODES,
  parsePublicAosRequirementsLedger,
  publicAosRequirementsReadback,
  validatePublicAosRequirementsLedger,
} from "../dist/build/packages/core/src/index.js";

const fixtureText = await readFile(new URL("../packages/core/fixtures/p7-public-aos-requirements-ledger.json", import.meta.url), "utf8");
const fixture = JSON.parse(fixtureText);
const fixtureCanonical = canonicalJson(fixture);
const clone = (value) => structuredClone(value);
const reason = (code, operation) => assert.throws(operation, (error) => error?.reasonCode === code, code);
function reseal(value) { const copy = clone(value); delete copy.ledgerDigest; copy.ledgerDigest = canonicalSha256({ schemaVersion: copy.schemaVersion, requirements: [...copy.requirements].sort((a, b) => a.requirementId.localeCompare(b.requirementId)) }); return copy; }

test("public AOS requirements ledger is closed, generic, deterministic and read-only", () => {
  const ledger = parsePublicAosRequirementsLedger(fixtureCanonical);
  assert.equal(ledger.requirements.length, 8);
  const readback = publicAosRequirementsReadback(ledger);
  assert.deepEqual({ liveCompatibility: readback.liveCompatibility, runtimeMutation: readback.runtimeMutation, supportedReleaseClaims: readback.supportedReleaseClaims, network: readback.network }, { liveCompatibility: false, runtimeMutation: false, supportedReleaseClaims: false, network: false });
  assert.equal(publicAosRequirementsReadback(clone(ledger)).readbackDigest, readback.readbackDigest);
  for (const entry of ledger.requirements) assert.ok(["specified", "fixture_verified"].includes(entry.maturity));
});

test("schema and runtime share the exact frozen public source boundary", async () => {
  const schema = JSON.parse(await readFile(new URL("../packages/core/schema/public-aos-requirements-v1.schema.json", import.meta.url), "utf8"));
  const validate = new Ajv2020({ strict: true }).compile(schema);
  assert.equal(validate(fixture), true);
  const vectors = [
    ["unknown", (value) => { value.unexpected = true; return value; }, "AOS_REQUIREMENTS_UNKNOWN_FIELD", false],
    ["duplicate", (value) => { value.requirements[1] = clone(value.requirements[0]); return reseal(value); }, "AOS_REQUIREMENTS_DUPLICATE", false],
    ["private", (value) => { value.requirements[0].workflowBehavior = "tcrn priority"; return reseal(value); }, "AOS_REQUIREMENTS_PRIVATE_FIELD", false],
    ["mode", (value) => { value.requirements[0].requiredForMode = "connected_live"; return reseal(value); }, "AOS_REQUIREMENTS_SOURCE_MISMATCH", false],
    ["semantic", (value) => { value.requirements[0].workflowBehavior = "changed generic behavior"; return reseal(value); }, "AOS_REQUIREMENTS_SOURCE_MISMATCH", false],
    ["status", (value) => { value.requirements[0].status = "candidate"; return reseal(value); }, "AOS_REQUIREMENTS_SOURCE_MISMATCH", false],
    ["maturity", (value) => { value.requirements[0].maturity = "fixture_verified"; return reseal(value); }, "AOS_REQUIREMENTS_SOURCE_MISMATCH", false],
    ["known-source-transplant", (value) => { value.requirements[0].workflowBehavior = value.requirements[1].workflowBehavior; return reseal(value); }, "AOS_REQUIREMENTS_SOURCE_MISMATCH", false],
    ["transplant", (value) => { value.requirements[0].requirementId = "aos-requirement:unreviewed-transplant"; return reseal(value); }, "AOS_REQUIREMENTS_INPUT_INVALID", false],
    ["tamper", (value) => { value.requirements[0].workflowBehavior = "changed generic behavior"; return value; }, "AOS_REQUIREMENTS_SOURCE_MISMATCH", false],
  ];
  for (const [name, mutate, code, schemaValid] of vectors) {
    const candidate = mutate(clone(fixture)) ?? fixture;
    assert.equal(validate(candidate), schemaValid, name);
    reason(code, () => validatePublicAosRequirementsLedger(candidate));
  }
  reason("AOS_REQUIREMENTS_CANONICAL_INVALID", () => parsePublicAosRequirementsLedger(JSON.stringify(fixture)));
});

test("schema and runtime reject UTF-8, malformed-Unicode and safe-integer boundary substitutions", async () => {
  const schema = JSON.parse(await readFile(new URL("../packages/core/schema/public-aos-requirements-v1.schema.json", import.meta.url), "utf8"));
  const validate = new Ajv2020({ strict: true }).compile(schema);
  const astral = String.fromCodePoint(0x1f600);
  const vectors = [
    ["astral-min", 127, "AOS_REQUIREMENTS_SOURCE_MISMATCH"],
    ["astral-max", 128, "AOS_REQUIREMENTS_SOURCE_MISMATCH"],
    ["astral-max-plus-one", 129, "AOS_REQUIREMENTS_INPUT_INVALID"],
    ["malformed-unicode", "\ud800", "AOS_REQUIREMENTS_UNICODE_INVALID"],
    ["safe-integer", Number.MAX_SAFE_INTEGER, "AOS_REQUIREMENTS_SOURCE_MISMATCH"],
    ["unsafe-integer", Number.MAX_SAFE_INTEGER + 1, "AOS_REQUIREMENTS_PROTOCOL_INVALID"],
  ];
  for (const [name, replacement, code] of vectors) {
    const candidate = clone(fixture);
    if (typeof replacement === "number" && name.includes("integer")) candidate.requirements[0].protocolVersion = replacement;
    else candidate.requirements[0].workflowBehavior = typeof replacement === "number" ? astral.repeat(replacement) : replacement;
    const sealed = name === "unsafe-integer" || typeof replacement === "string" ? candidate : reseal(candidate);
    assert.equal(validate(sealed), false, name);
    reason(code, () => validatePublicAosRequirementsLedger(sealed));
  }
});

test("raw parser and governed CLI preserve frozen protocol and Unicode reason codes", async () => {
  const rawLedger = (replacement) => JSON.stringify({ ...clone(fixture), requirements: clone(fixture.requirements).map((entry, index) => index ? entry : { ...entry, ...replacement }) });
  const vectors = [
    ["unsafe-integer", { protocolVersion: Number.MAX_SAFE_INTEGER + 1 }, "AOS_REQUIREMENTS_PROTOCOL_INVALID"],
    ["lone-high-surrogate", { workflowBehavior: "\ud800" }, "AOS_REQUIREMENTS_UNICODE_INVALID"],
    ["lone-low-surrogate", { workflowBehavior: "\udc00" }, "AOS_REQUIREMENTS_UNICODE_INVALID"],
  ];
  for (const [name, replacement, code] of vectors) {
    const raw = rawLedger(replacement);
    reason(code, () => parsePublicAosRequirementsLedger(raw));
    await assert.rejects(runCli(["aos-requirements-validate", "--ledger", raw], { write() {} }), (error) => error?.reasonCode === code, name);
  }
});

test("all deterministic requirement-order permutations preserve validation and digest", () => {
  const source = fixture.requirements;
  const orders = [];
  const visit = (prefix, rest) => { if (orders.length >= 64) return; if (!rest.length) { orders.push(prefix); return; } for (let index = 0; index < rest.length; index += 1) visit([...prefix, rest[index]], [...rest.slice(0, index), ...rest.slice(index + 1)]); };
  visit([], source);
  assert.equal(orders.length, 64);
  for (const order of orders) assert.equal(validatePublicAosRequirementsLedger({ ...fixture, requirements: order }).ledgerDigest, fixture.ledgerDigest);
});

test("read-only CLI validates and returns a deterministic no-overclaim readback", async () => {
  const output = []; const io = { write: (value) => output.push(value) };
  await runCli(["aos-requirements-validate", "--ledger", fixtureCanonical], io);
  const valid = JSON.parse(output.pop());
  assert.deepEqual(valid, { ledgerDigest: fixture.ledgerDigest, reasonCode: "AOS_REQUIREMENTS_VALID", requirements: 8 });
  assert.ok(PUBLIC_AOS_REQUIREMENTS_REASON_CODES.includes(valid.reasonCode));
  const resealedMode = reseal({ ...clone(fixture), requirements: clone(fixture.requirements).map((entry, index) => index ? entry : { ...entry, requiredForMode: "connected_live" }) });
  await assert.rejects(runCli(["aos-requirements-validate", "--ledger", canonicalJson(resealedMode)], io), (error) => error?.reasonCode === "AOS_REQUIREMENTS_SOURCE_MISMATCH");
  await runCli(["aos-requirements-readback", "--ledger", fixtureCanonical], io);
  assert.equal(JSON.parse(output.pop()).readbackDigest, publicAosRequirementsReadback(fixture).readbackDigest);
});
