#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-381 — read-only V2 compaction research prototype.
//
// The prototype freezes ordinary CLI read surfaces, estimates moving older event
// segments to a generated-artifacts archive, and compares real status timings with
// an explicitly labelled in-process tail-load simulation. It never writes the
// workspace, an archive, or a second workspace.
//
// Usage:
//   node scripts/compaction-prototype.mjs --workspace <path> [--runs 20]
//       [--cold-segments <count>] [--at <instant>]

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(repositoryRoot, "scripts", "tcrn-workflow.mjs");
const schemaVersion = "tcrn.compaction-research-prototype.v1";

class PrototypeError extends Error {
  constructor(reasonCode, message) {
    super(message);
    this.name = "PrototypeError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode, message) {
  throw new PrototypeError(reasonCode, message);
}

function assert(condition, reasonCode, message) {
  if (!condition) fail(reasonCode, message);
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function bytes(value) {
  return Buffer.byteLength(canonical(value), "utf8");
}

function numberArgument(name, fallback, minimum, maximum) {
  const raw = argument(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  assert(Number.isSafeInteger(value) && value >= minimum && value <= maximum, "PROTOTYPE_ARGUMENT_INVALID", `--${name} must be an integer from ${minimum} to ${maximum}`);
  return value;
}

function readJson(argv) {
  const started = process.hrtime.bigint();
  const result = spawnSync(process.execPath, [cliPath, ...argv], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const output = String(result.stdout || result.stderr || "").trim();
  let body;
  try {
    body = JSON.parse(output);
  } catch {
    fail("PROTOTYPE_READ_FAILED", `${argv[0]} did not return JSON: ${output.slice(0, 240)}`);
  }
  if (result.status !== 0) fail(body.reasonCode ?? "PROTOTYPE_READ_FAILED", `${argv[0]} refused: ${body.error ?? body.reasonCode ?? "unknown error"}`);
  return { body, elapsedMs };
}

function readEventPages(workspace) {
  const pageLimit = 200;
  let offset = 0;
  let total = null;
  let headEventHash = null;
  const records = [];
  while (total === null || offset < total) {
    const page = readJson(["event-list", "--workspace", workspace, "--limit", String(pageLimit), "--offset", String(offset)]).body;
    assert(Array.isArray(page.records), "PROTOTYPE_INPUT_NOT_FROZEN", "event-list page has no records");
    if (total === null) total = page.total;
    assert(Number.isSafeInteger(total) && total >= 0, "PROTOTYPE_INPUT_NOT_FROZEN", "event-list total is invalid");
    assert(headEventHash === null || headEventHash === page.headEventHash, "PROTOTYPE_INPUT_NOT_FROZEN", "event-list page head changed");
    headEventHash = page.headEventHash ?? headEventHash;
    records.push(...page.records);
    assert(page.records.length > 0 || offset >= total, "PROTOTYPE_INPUT_NOT_FROZEN", "event-list page made no progress");
    offset += page.records.length;
  }
  assert(records.length === total, "PROTOTYPE_INPUT_NOT_FROZEN", "event-list pagination did not cover the chain");
  return { headEventHash, total, records };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function percentile95(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

function timingSummary(values) {
  return {
    runs: values.length,
    medianMs: Number(median(values).toFixed(1)),
    p95Ms: Number(percentile95(values).toFixed(1)),
    minMs: Number(Math.min(...values).toFixed(1)),
    maxMs: Number(Math.max(...values).toFixed(1)),
  };
}

function manifestFileMap(manifest) {
  assert(Array.isArray(manifest.files), "PROTOTYPE_MANIFEST_INVALID", "snapshot manifest files are missing");
  return new Map(manifest.files.map((entry) => [entry.path, entry]));
}

function segmentFiles(manifest) {
  return [...manifestFileMap(manifest).values()]
    .filter((entry) => /^events\/\d{6}\.(?:idx|ndjson)$/u.test(entry.path))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function archiveIntegrity(expected, actual) {
  const actualByPath = new Map(actual.map((entry) => [entry.path, entry]));
  const missing = expected.filter((entry) => !actualByPath.has(entry.path)).map((entry) => entry.path);
  const mismatched = expected.filter((entry) => {
    const candidate = actualByPath.get(entry.path);
    return candidate !== undefined && (candidate.bytes !== entry.bytes || candidate.sha256 !== entry.sha256);
  }).map((entry) => entry.path);
  return { ok: missing.length === 0 && mismatched.length === 0, missing, mismatched };
}

export function simulateTailLoad(records) {
  const hash = createHash("sha256");
  for (const record of records) hash.update(canonical(record));
  return { records: records.length, digest: hash.digest("hex") };
}

export function archiveProjection(manifest, status, records, coldSegmentCount) {
  const segments = segmentFiles(manifest);
  const ndjsonSegments = segments.filter((entry) => entry.path.endsWith(".ndjson"));
  assert(coldSegmentCount >= 0 && coldSegmentCount < ndjsonSegments.length + 1, "PROTOTYPE_ARGUMENT_INVALID", `--cold-segments must be from 0 to ${ndjsonSegments.length}`);
  const coldNdjson = ndjsonSegments.slice(0, coldSegmentCount);
  const coldPaths = new Set(coldNdjson.map((entry) => entry.path.replace(/\.ndjson$/u, ".idx")));
  for (const entry of coldNdjson) coldPaths.add(entry.path);
  const cold = segments.filter((entry) => coldPaths.has(entry.path));
  const totalEventSegmentBytes = segments.reduce((sum, entry) => sum + entry.bytes, 0);
  const coldBytes = cold.reduce((sum, entry) => sum + entry.bytes, 0);
  const controlBytes = manifest.files.reduce((sum, entry) => sum + entry.bytes, 0);
  const retainedBytes = controlBytes - coldBytes;
  const archiveIndex = {
    schemaVersion: "tcrn.workspace-cold-segment-archive-research.v1",
    workspaceId: status.workspaceId,
    sourceVersion: status.version,
    sourceHeadEventHash: status.headEventHash,
    segments: cold,
  };
  const headRoot = {
    schemaVersion: "tcrn.workspace-compaction-head-root-research.v1",
    workspaceId: status.workspaceId,
    version: status.version,
    headEventHash: status.headEventHash,
    genesisRule: "retain the V1 genesis-anchored verification root; no chain rewrite is performed",
  };
  const archiveIndexBytes = bytes(archiveIndex);
  const headRootBytes = bytes(headRoot);
  const archiveBytes = coldBytes + archiveIndexBytes;
  const retainedEventBytes = totalEventSegmentBytes - coldBytes;
  const tailRecordCount = retainedEventBytes === 0 || totalEventSegmentBytes === 0
    ? 0
    : Math.max(1, Math.round(records.length * retainedEventBytes / totalEventSegmentBytes));
  return {
    source: {
      version: status.version,
      headEventHash: status.headEventHash,
      eventCount: records.length,
      controlBytes,
      eventSegmentBytes: totalEventSegmentBytes,
    },
    archive: {
      destination: "workspace.generatedArtifactsPath (research estimate only; nothing written)",
      coldSegmentCount: coldNdjson.length,
      coldFiles: cold,
      coldBytes,
      indexBytes: archiveIndexBytes,
      estimatedBytes: archiveBytes,
      retainedEventSegmentBytes: retainedEventBytes,
      estimatedControlBytesAfterMove: retainedBytes + headRootBytes,
      headRootBytes,
      headRoot,
      archiveIndex,
    },
    simulation: {
      method: "proportional event selection from frozen event-list records using manifest event-segment bytes; not a V2 status measurement",
      tailRecordCount,
      tailSegmentCount: ndjsonSegments.length - coldNdjson.length,
      missingColdSegment: archiveIntegrity(cold, cold.slice(1)),
      tamperedColdSegment: archiveIntegrity(cold, cold.length === 0 ? cold : [{ ...cold[0], sha256: "0".repeat(64) }, ...cold.slice(1)]),
    },
  };
}

function frozenDigest(status, events, manifest) {
  return digest({
    status: { workspaceId: status.workspaceId, version: status.version, headEventHash: status.headEventHash },
    events: { total: events.total, records: events.records },
    manifest: { workspaceId: manifest.workspaceId, version: manifest.version, files: manifest.files },
  });
}

function viewBudgetSummary(status) {
  const views = status.budgets?.views ?? [];
  return views.map((view) => ({ name: view.name, bytes: view.bytes, limit: view.limit, headroomBytes: view.headroomBytes }));
}

function backfillPlan(status) {
  const limit = status.budgets?.events?.limit ?? null;
  const eventCount = status.version;
  return {
    liveWrites: false,
    rule: "one summary backfill is one governed work.updated event; it is not performed by this prototype",
    currentEventCount: eventCount,
    eventLimit: limit,
    currentHeadroomEvents: status.budgets?.events?.headroomEvents ?? null,
    oneEventProjection: limit === null ? null : { eventCountAfter: eventCount + 1, headroomAfter: limit - eventCount - 1 },
    viewImpact: viewBudgetSummary(status).map((view) => ({
      ...view,
      bytesAfter: null,
      headroomAfterBytes: null,
      reason: "materialized view size must be measured in an isolated scratch write; this research run does not extrapolate it or touch the live chain",
    })),
  };
}

export async function runPrototype() {
  const workspaceInput = argument("workspace");
  assert(typeof workspaceInput === "string" && workspaceInput.length > 0, "PROTOTYPE_ARGUMENT_MISSING", "--workspace is required");
  const workspace = resolve(workspaceInput);
  assert(workspace.endsWith("/workspace"), "PROTOTYPE_ARGUMENT_INVALID", "--workspace must point at a workspace root ending in /workspace");
  const runs = numberArgument("runs", 20, 3, 100);
  const at = argument("at") ?? new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");
  const initialStatus = readJson(["status", "--workspace", workspace]).body;
  const initialEvents = readEventPages(workspace);
  const initialManifest = readJson(["snapshot-manifest", "--workspace", workspace, "--at", at]).body;
  assert(Array.isArray(initialEvents.records) && initialEvents.records.length === initialEvents.total, "PROTOTYPE_INPUT_NOT_FROZEN", "event-list did not return the complete chain");
  assert(initialEvents.total === initialStatus.version, "PROTOTYPE_INPUT_NOT_FROZEN", "status version and event-list total differ");
  const ndjsonCount = segmentFiles(initialManifest).filter((entry) => entry.path.endsWith(".ndjson")).length;
  const coldSegments = numberArgument("cold-segments", Math.max(0, ndjsonCount - 1), 0, ndjsonCount);
  const beforeDigest = frozenDigest(initialStatus, initialEvents, initialManifest);
  const projection = archiveProjection(initialManifest, initialStatus, initialEvents.records, coldSegments);

  // The first status call is deliberately outside the sample. It warms the same
  // CLI process boundary used by the 20 serial observations below.
  const warmup = readJson(["status", "--workspace", workspace]);
  const statusTimings = [];
  for (let index = 0; index < runs; index += 1) statusTimings.push(readJson(["status", "--workspace", workspace]).elapsedMs);
  const simulatedTailTimings = [];
  const tailRecords = initialEvents.records.slice(-projection.simulation.tailRecordCount);
  for (let index = 0; index < runs; index += 1) {
    const started = process.hrtime.bigint();
    simulateTailLoad(tailRecords);
    simulatedTailTimings.push(Number(process.hrtime.bigint() - started) / 1e6);
  }

  const finalStatus = readJson(["status", "--workspace", workspace]).body;
  const finalManifest = readJson(["snapshot-manifest", "--workspace", workspace, "--at", at]).body;
  const afterDigest = frozenDigest(finalStatus, initialEvents, finalManifest);
  const sameFiles = canonical(initialManifest.files) === canonical(finalManifest.files);
  const sameHead = initialStatus.version === finalStatus.version && initialStatus.headEventHash === finalStatus.headEventHash;
  const eventLimit = initialStatus.budgets?.events?.limit ?? null;

  return {
    schemaVersion,
    ok: true,
    readOnly: true,
    workspace,
    at,
    source: {
      inputDigestBefore: beforeDigest,
      inputDigestAfter: afterDigest,
      liveChainUnchanged: sameFiles && sameHead && beforeDigest === afterDigest,
      workspaceId: initialStatus.workspaceId,
      version: initialStatus.version,
      headEventHash: initialStatus.headEventHash,
      eventCount: initialEvents.total,
      eventCountBasis: "workspace.version and event-list total; the cap counts chain events, not live records",
    },
    limits: {
      events: {
        current: initialStatus.version,
        limit: eventLimit,
        headroom: initialStatus.budgets?.events?.headroomEvents ?? null,
        enforcement: "assertWorkspaceRecordCount(state.version + 1) before append and assertWorkspaceRecordCount(events.length) during replay",
        capTreatment: "V1 refuses at the limit; this prototype does not raise the limit or rewrite the chain",
      },
      views: viewBudgetSummary(initialStatus),
      backfillPlan: backfillPlan(initialStatus),
    },
    estimate: projection,
    timings: {
      currentStatus: { warmupMs: Number(warmup.elapsedMs.toFixed(1)), ...timingSummary(statusTimings) },
      simulatedTailLoad: { ...timingSummary(simulatedTailTimings), records: tailRecords.length, method: projection.simulation.method },
    },
    integrity: {
      missingColdSegmentProbe: projection.simulation.missingColdSegment,
      tamperedColdSegmentProbe: projection.simulation.tamperedColdSegment,
      liveChainBytesUnchanged: sameFiles,
      liveChainHeadUnchanged: sameHead,
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(`${JSON.stringify(await runPrototype(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, reasonCode: error.reasonCode ?? "PROTOTYPE_INTERNAL_ERROR", error: error.message })}\n`);
    process.exitCode = 1;
  }
}
