// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import {
  CANONICAL_EXCHANGE_LIMITS,
  dryRunCanonicalExchange,
  planCanonicalExchange,
  readCanonicalExchangeBundle,
  validateCanonicalExchangeBundle,
  writeCanonicalExchangeBundle,
} from "../dist/build/packages/core/src/index.js";
import { canonicalJson, canonicalSha256, compareCanonicalText } from "../dist/build/packages/protocol/src/index.js";

const fixture = JSON.parse(await readFile(new URL("../packages/core/fixtures/p7-canonical-exchange-cases.json", import.meta.url), "utf8"));
const clone = (value) => structuredClone(value);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function reason(code, operation) {
  assert.throws(operation, (error) => error?.reasonCode === code, code);
}

function deepWellFormed(value) {
  if (typeof value === "string") return value.isWellFormed();
  if (Array.isArray(value)) return value.every(deepWellFormed);
  if (value && typeof value === "object") return Object.entries(value).every(([key, item]) => key.isWellFormed() && deepWellFormed(item));
  return true;
}

async function reasonAsync(code, operation) {
  await assert.rejects(operation, (error) => error?.reasonCode === code, code);
}

function jsonChunk(path, value) {
  const bytes = Buffer.from(canonicalJson(value));
  return { logicalPath: path, mediaType: "application/json", contentBase64: bytes.toString("base64"), semanticDigest: canonicalSha256(value), bytes };
}

function textChunk(path, value) {
  const bytes = Buffer.from(value, "utf8");
  return { logicalPath: path, mediaType: "text/plain; charset=utf-8", contentBase64: bytes.toString("base64"), semanticDigest: sha256(bytes), bytes };
}

function request(order) {
  const source = [
    jsonChunk("data/initiative.json", { id: "work:initiative", status: "active" }),
    jsonChunk("data/story.json", { id: "work:story", status: "ready" }),
    jsonChunk("data/subtask.json", { id: "work:subtask", status: "planned" }),
    textChunk("notes/readme.txt", "Offline canonical exchange fixture.\n"),
    jsonChunk("receipts/checkpoint.json", { accepted: false, checkpoint: "P7-A" }),
  ];
  const chunks = order ? order.map((index) => source[index]) : source;
  const entries = [...source].sort((left, right) => compareCanonicalText(left.logicalPath, right.logicalPath)).map((chunk) => ({ path: chunk.logicalPath, mediaType: chunk.mediaType, size: chunk.bytes.length, sha256: sha256(chunk.bytes) }));
  return {
    schemaVersion: "tcrn.canonical-exchange-request.v1",
    exchange: { schemaVersion: "tcrn.exchange.v1", id: "exchange:p7-fixture", createdAt: "2026-07-12T13:00:00Z", protocolVersion: 1, entries, extensions: {} },
    transactionId: "exchange-transaction:p7-fixture",
    sourceWorkspaceId: "workspace:p7-source",
    targetWorkspaceId: "workspace:p7-target",
    idempotencyKey: "exchange-idempotency:p7-fixture",
    semanticSubjectDigest: canonicalSha256({ projectId: "project:p7-fixture", workId: "work:p7-exchange" }),
    chunks: chunks.map(({ bytes: _bytes, ...chunk }) => chunk),
  };
}

function permutations(values, maximum) {
  const result = [];
  const visit = (prefix, remaining) => {
    if (result.length >= maximum) return;
    if (remaining.length === 0) { result.push(prefix); return; }
    for (let index = 0; index < remaining.length; index += 1) visit([...prefix, remaining[index]], [...remaining.slice(0, index), ...remaining.slice(index + 1)]);
  };
  visit([], values);
  return result;
}

async function temporary(label) {
  return realpath(await mkdtemp(join(tmpdir(), `workflow-p7-${label}-`)));
}

async function writtenBundle(label = "bundle") {
  const directory = await temporary(label);
  const output = join(directory, "exchange-bundle");
  const readback = await writeCanonicalExchangeBundle(output, request());
  return { directory, output, readback, close: () => rm(directory, { recursive: true, force: true }) };
}

async function rewriteDocument(path, mutate, resealField) {
  const document = JSON.parse(await readFile(path, "utf8"));
  const changed = mutate(clone(document));
  if (resealField) {
    delete changed[resealField];
    changed[resealField] = canonicalSha256(changed);
  }
  await writeFile(path, canonicalJson(changed));
}

test("P7 canonical exchange plan, write, read, validate, dry-run and CLI surfaces are deterministic", async () => {
  const planned = planCanonicalExchange(request());
  assert.equal(planned.reasonCode, "EXCHANGE_PLAN_READY");
  assert.equal(planned.fileCount, 8);
  assert.equal(planned.manifest.chunks.length, 5);
  assert.equal(planned.manifest.chunks.map((entry) => entry.logicalPath).join("\n"), [...planned.manifest.chunks].sort((a, b) => compareCanonicalText(a.logicalPath, b.logicalPath)).map((entry) => entry.logicalPath).join("\n"));
  const directory = await temporary("positive");
  const output = join(directory, "exchange-bundle");
  try {
    const dry = dryRunCanonicalExchange(request(), output);
    assert.deepEqual({ mutation: dry.mutation, network: dry.network, codeExecution: dry.codeExecution }, { mutation: false, network: false, codeExecution: false });
    assert.equal(await realpath(directory), directory);
    const written = await writeCanonicalExchangeBundle(output, request());
    const read = await readCanonicalExchangeBundle(output);
    const validated = await validateCanonicalExchangeBundle(output);
    assert.equal(written.bundleDigest, planned.bundleDigest);
    assert.equal(read.bundleDigest, planned.bundleDigest);
    assert.equal(validated.planDigest, planned.planDigest);
    let cliPlan = "", cliDry = "", cliValidate = "";
    await runCli(["exchange-plan", "--request", canonicalJson(request())], { write: (value) => { cliPlan = value; } });
    await runCli(["exchange-dry-run", "--request", canonicalJson(request()), "--output", join(directory, "other")], { write: (value) => { cliDry = value; } });
    await runCli(["exchange-validate", "--bundle", output], { write: (value) => { cliValidate = value; } });
    assert.equal(JSON.parse(cliPlan).bundleDigest, planned.bundleDigest);
    assert.equal(JSON.parse(cliDry).mutation, false);
    assert.equal(JSON.parse(cliValidate).reasonCode, "EXCHANGE_BUNDLE_VERIFIED");
    await reasonAsync("CLI_ARGUMENT_MISSING", () => runCli(["exchange-plan"], { write() {} }));
    await reasonAsync("CLI_ARGUMENT_DUPLICATE", () => runCli(["exchange-plan", "--request", "{}", "--request", "{}"], { write() {} }));
    await reasonAsync("CLI_ARGUMENT_UNKNOWN", () => runCli(["exchange-plan", "--unknown", "{}"], { write() {} }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("64 distinct real chunk insertion orders produce identical plans and corpus digest", () => {
  const orders = permutations([0, 1, 2, 3, 4], fixture.propertyPermutations);
  assert.equal(new Set(orders.map((order) => order.join(","))).size, 64);
  const plans = orders.map((order) => planCanonicalExchange(request(order)));
  assert.equal(new Set(plans.map((plan) => canonicalJson(plan))).size, 1);
  assert.equal(new Set(plans.map((plan) => plan.planDigest)).size, 1);
  const corpusDigest = canonicalSha256(orders);
  assert.equal(corpusDigest, fixture.permutationCorpusDigest);
});

test("request/schema parity and hostile in-memory admission fail closed", async () => {
  const schema = JSON.parse(await readFile(new URL("../packages/core/schema/canonical-exchange-v1.schema.json", import.meta.url), "utf8"));
  const exchangeSchema = JSON.parse(await readFile(new URL("../schemas/exchange-v1.schema.json", import.meta.url), "utf8"));
  const commonSchema = JSON.parse(await readFile(new URL("../schemas/protocol-common-v1.schema.json", import.meta.url), "utf8"));
  const ajv = new Ajv2020({ strict: true });
  ajv.addKeyword({ keyword: "x-tcrn-maxUtf8Bytes", schemaType: "number", type: "string", validate: (maximum, value) => Buffer.byteLength(value, "utf8") <= maximum });
  ajv.addKeyword({ keyword: "x-tcrn-deepWellFormedUnicode", schemaType: "boolean", validate: (enabled, value) => !enabled || deepWellFormed(value) });
  ajv.addKeyword({ keyword: "x-tcrn-aos-requirementIds", schemaType: "array" });
  ajv.addSchema(commonSchema); ajv.addSchema(exchangeSchema); const validate = ajv.compile(schema);
  const base = request();
  const vectors = [
    { ...base, extra: true },
    { ...base, transactionId: "bad id" },
    { ...base, chunks: [] },
    { ...base, chunks: [{ ...base.chunks[0], extra: true }] },
    { ...base, chunks: [{ ...base.chunks[0], logicalPath: "../escape" }] },
    { ...base, chunks: [{ ...base.chunks[0], logicalPath: "a\\b" }] },
    { ...base, chunks: [{ ...base.chunks[0], contentBase64: "A===" }] },
    { ...base, chunks: [{ ...base.chunks[0], logicalPath: "\ud800" }] },
  ];
  assert.equal(vectors.length, fixture.schemaParityCases);
  for (const vector of vectors) {
    assert.equal(validate(vector), false, JSON.stringify(validate.errors));
    assert.throws(() => planCanonicalExchange(vector));
  }
  assert.equal(validate(base), true, JSON.stringify(validate.errors));

  reason("EXCHANGE_CHUNK_DUPLICATE", () => planCanonicalExchange({ ...base, chunks: [base.chunks[0], base.chunks[0]] }));
  reason("EXCHANGE_CHUNK_MISSING", () => planCanonicalExchange({ ...base, chunks: base.chunks.slice(1) }));
  reason("EXCHANGE_CHUNK_SUBSTITUTED", () => planCanonicalExchange({ ...base, exchange: { ...base.exchange, entries: base.exchange.entries.map((entry, index) => index === 0 ? { ...entry, sha256: "0".repeat(64) } : entry) } }));
  reason("EXCHANGE_CHUNK_SUBSTITUTED", () => planCanonicalExchange({ ...base, exchange: { ...base.exchange, entries: base.exchange.entries.map((entry, index) => index === 0 ? { ...entry, size: entry.size + 1 } : entry) } }));
  reason("EXCHANGE_SEMANTIC_MISMATCH", () => planCanonicalExchange({ ...base, chunks: base.chunks.map((entry, index) => index === 0 ? { ...entry, semanticDigest: "0".repeat(64) } : entry) }));
  const noncanonical = Buffer.from('{"z":1,"a":2}\n').toString("base64");
  reason("EXCHANGE_CANONICAL_INVALID", () => planCanonicalExchange({ ...base, chunks: base.chunks.map((entry, index) => index === 0 ? { ...entry, contentBase64: noncanonical } : entry) }));
  reason("EXCHANGE_LIMIT_EXCEEDED", () => planCanonicalExchange({ ...base, chunks: Array.from({ length: 129 }, () => base.chunks[0]) }));
  reason("EXCHANGE_PATH_INVALID", () => planCanonicalExchange({ ...base, chunks: base.chunks.map((entry, index) => index === 0 ? { ...entry, logicalPath: "/absolute" } : entry) }));
  const large = textChunk("large.txt", "a".repeat(CANONICAL_EXCHANGE_LIMITS.maximumChunkBytes + 1));
  const { bytes: largeBytes, ...largeInput } = large;
  reason("EXCHANGE_LIMIT_EXCEEDED", () => planCanonicalExchange({ ...base, chunks: [largeInput], exchange: { ...base.exchange, entries: [{ path: large.logicalPath, mediaType: large.mediaType, size: largeBytes.length, sha256: sha256(largeBytes) }] } }));
  const aggregateChunks = Array.from({ length: 9 }, (_, index) => textChunk(`aggregate/${index}.txt`, "a".repeat(CANONICAL_EXCHANGE_LIMITS.maximumChunkBytes)));
  reason("EXCHANGE_LIMIT_EXCEEDED", () => planCanonicalExchange({
    ...base,
    chunks: aggregateChunks.map(({ bytes: _bytes, ...chunk }) => chunk),
    exchange: {
      ...base.exchange,
      entries: aggregateChunks.map((chunk) => ({ path: chunk.logicalPath, mediaType: chunk.mediaType, size: chunk.bytes.length, sha256: sha256(chunk.bytes) })).sort((left, right) => compareCanonicalText(left.path, right.path)),
    },
  }));
});

test("reader rejects missing, extra, link, replacement and tampered bundle states", async () => {
  const cases = [];
  {
    const bundle = await writtenBundle("missing");
    try { const path = join(bundle.output, bundle.readback.manifest.chunks[0].storedPath); await rm(path); await reasonAsync("EXCHANGE_CHUNK_MISSING", () => readCanonicalExchangeBundle(bundle.output)); cases.push("missing-chunk-file"); } finally { await bundle.close(); }
  }
  {
    const bundle = await writtenBundle("missing-control");
    try { await rm(join(bundle.output, "transaction.json")); await reasonAsync("EXCHANGE_INCOMPLETE", () => readCanonicalExchangeBundle(bundle.output)); cases.push("missing-control-file"); } finally { await bundle.close(); }
  }
  {
    const bundle = await writtenBundle("extra-root");
    try { await writeFile(join(bundle.output, "unexpected.json"), "{}\n"); await reasonAsync("EXCHANGE_INCOMPLETE", () => readCanonicalExchangeBundle(bundle.output)); cases.push("extra-root-file"); } finally { await bundle.close(); }
  }
  {
    const bundle = await writtenBundle("extra");
    try { await writeFile(join(bundle.output, "chunks/extra.chunk"), "extra"); await reasonAsync("EXCHANGE_INCOMPLETE", () => readCanonicalExchangeBundle(bundle.output)); cases.push("extra-chunk-file"); } finally { await bundle.close(); }
  }
  {
    const bundle = await writtenBundle("symlink");
    try { const path = join(bundle.output, bundle.readback.manifest.chunks[0].storedPath); const backup = join(bundle.directory, "symlink-target"); await rename(path, backup); await symlink(backup, path); await reasonAsync("EXCHANGE_LINK_INVALID", () => readCanonicalExchangeBundle(bundle.output)); cases.push("symlink-chunk"); } finally { await bundle.close(); }
  }
  {
    const bundle = await writtenBundle("hardlink");
    try { const path = join(bundle.output, bundle.readback.manifest.chunks[0].storedPath); await link(path, `${path}.linked`); await reasonAsync("EXCHANGE_INCOMPLETE", () => readCanonicalExchangeBundle(bundle.output)); await rm(`${path}.linked`); await link(path, join(bundle.directory, "external-link")); await reasonAsync("EXCHANGE_LINK_INVALID", () => readCanonicalExchangeBundle(bundle.output)); cases.push("hardlink-chunk"); } finally { await bundle.close(); }
  }
  {
    const bundle = await writtenBundle("special");
    try { const path = join(bundle.output, bundle.readback.manifest.chunks[0].storedPath); await rm(path); await mkdir(path); await reasonAsync("EXCHANGE_FILE_INVALID", () => readCanonicalExchangeBundle(bundle.output)); cases.push("special-file-chunk"); } finally { await bundle.close(); }
  }
  {
    const bundle = await writtenBundle("replace");
    try {
      const path = join(bundle.output, "manifest.json");
      let replaced = false;
      await reasonAsync("EXCHANGE_CHANGED", () => readCanonicalExchangeBundle(bundle.output, { afterLstatForTest: async (observed) => { if (!replaced && observed === path) { replaced = true; const bytes = await readFile(path); await rm(path); await writeFile(path, bytes); } } }));
      cases.push("descriptor-replacement");
    } finally { await bundle.close(); }
  }
  {
    const bundle = await writtenBundle("manifest");
    try { await rewriteDocument(join(bundle.output, "manifest.json"), (doc) => ({ ...doc, manifestDigest: "0".repeat(64) })); await reasonAsync("EXCHANGE_CHUNK_SUBSTITUTED", () => readCanonicalExchangeBundle(bundle.output)); cases.push("tampered-manifest"); } finally { await bundle.close(); }
  }
  {
    const bundle = await writtenBundle("noncanonical");
    try { const path = join(bundle.output, "manifest.json"); const doc = JSON.parse(await readFile(path, "utf8")); await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`); await reasonAsync("EXCHANGE_CANONICAL_INVALID", () => readCanonicalExchangeBundle(bundle.output)); cases.push("noncanonical-manifest"); } finally { await bundle.close(); }
  }
  {
    const bundle = await writtenBundle("transaction");
    try { await rewriteDocument(join(bundle.output, "transaction.json"), (doc) => ({ ...doc, totalBytes: doc.totalBytes + 1 }), "transactionDigest"); await reasonAsync("EXCHANGE_TRANSACTION_MISMATCH", () => readCanonicalExchangeBundle(bundle.output)); cases.push("transaction-mismatch"); } finally { await bundle.close(); }
  }
  {
    const bundle = await writtenBundle("resume");
    try { await rewriteDocument(join(bundle.output, "resume.json"), (doc) => ({ ...doc, completedChunkIds: [...doc.completedChunkIds].reverse() }), "resumeDigest"); await reasonAsync("EXCHANGE_RESUME_MISMATCH", () => readCanonicalExchangeBundle(bundle.output)); cases.push("out-of-order-resume-id"); } finally { await bundle.close(); }
  }
  {
    const bundle = await writtenBundle("resume-duplicate");
    try { await rewriteDocument(join(bundle.output, "resume.json"), (doc) => ({ ...doc, completedChunkIds: [doc.completedChunkIds[0], ...doc.completedChunkIds] }), "resumeDigest"); await reasonAsync("EXCHANGE_RESUME_MISMATCH", () => readCanonicalExchangeBundle(bundle.output)); cases.push("duplicate-resume-id"); } finally { await bundle.close(); }
  }
  assert.equal(cases.length, 13);
});

test("writer crash points, partial state and overwrite boundaries fail closed", async () => {
  for (const faultPointForTest of ["after-first-chunk", "before-commit-rename"]) {
    const directory = await temporary(faultPointForTest);
    const output = join(directory, "exchange-bundle");
    const plan = planCanonicalExchange(request());
    const stage = join(directory, `.exchange-bundle.partial-${plan.manifest.manifestDigest.slice(0, 16)}`);
    try {
      await reasonAsync("EXCHANGE_WRITE_CRASH", () => writeCanonicalExchangeBundle(output, request(), { faultPointForTest }));
      await reasonAsync(faultPointForTest === "after-first-chunk" ? "EXCHANGE_PATH_INVALID" : "EXCHANGE_PATH_INVALID", () => readCanonicalExchangeBundle(stage));
      assert.equal(await readFile(join(stage, "chunks", (await readdirSafe(join(stage, "chunks")))[0])).then((bytes) => bytes.length > 0), true);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  const bundle = await writtenBundle("overwrite");
  try { await reasonAsync("EXCHANGE_OUTPUT_EXISTS", () => writeCanonicalExchangeBundle(bundle.output, request())); } finally { await bundle.close(); }
  await reasonAsync("EXCHANGE_PATH_INVALID", () => writeCanonicalExchangeBundle("relative-output", request()));
});

async function readdirSafe(path) {
  const { readdir } = await import("node:fs/promises");
  return readdir(path);
}

test("source and runtime boundary contain no network or candidate-code execution surface", async () => {
  const source = await readFile(new URL("../packages/core/src/canonical-exchange.ts", import.meta.url), "utf8");
  for (const pattern of [/node:http/u, /node:https/u, /node:net/u, /node:tls/u, /child_process/u, /\bfetch\s*\(/u, /\beval\s*\(/u, /new Function/u, /import\s*\(\s*[^"']/u]) assert.doesNotMatch(source, pattern);
  const dry = dryRunCanonicalExchange(request(), "/tmp/p7-offline-dry-run");
  assert.deepEqual({ network: dry.network, codeExecution: dry.codeExecution, mutation: dry.mutation }, { network: false, codeExecution: false, mutation: false });
  assert.equal(fixture.networkAccess, false);
  assert.equal(fixture.codeExecution, false);
  assert.equal(fixture.liveAosMutation, false);
});
