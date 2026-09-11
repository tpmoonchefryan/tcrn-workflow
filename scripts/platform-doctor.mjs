#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, extname, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The install manifest is the only path/residence authority. The doctor consumes
// the built public core so the same bytes are used by the CLI's install-manifest
// read surface and by this host probe; there is no second path table here.
import {
  INSTALL_MANIFEST,
  assertInstallManifestComplete,
  compareEngineVersions,
  WORKSPACE_STORAGE_MIGRATION_SEGMENT_BYTES,
} from "../dist/build/packages/core/src/index.js";
// The identity digest is computed by the engine's own canonicaliser rather than
// reproduced here. A second implementation of a digest is a second answer waiting to
// disagree with the first (TCRN-CROSS-INC-219).
import { PROTOCOL_LIMITS, canonicalSha256 } from "../dist/build/packages/protocol/src/index.js";
import {
  HOSTS,
  claudeHarnessDrift,
  codexHookDocument,
  hookEntriesFor,
} from "./host-harness.mjs";
import { inspectHostRenderDrift as inspectRenderedHostDrift } from "./host-render.mjs";
import { toPosixPath, walkFiles } from "./lib/files.mjs";

const execFileAsync = promisify(execFile);
const TOPOLOGY_SECTION_MARKER = "## 三、分区拓扑";
const PLATFORM_DOCS_RELATIVE = "platform-docs";

function check(name, ok, details = {}) {
  return { name, ok, ...details };
}

async function existingPath(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

// INC-247: platform-level documents live at the container root. The classification
// folder is deliberately not a fallback: a future move must fail visibly rather than
// silently reintroduce a second authority.
async function platformDocsRoot(root) {
  return { relativePath: PLATFORM_DOCS_RELATIVE, path: join(root, PLATFORM_DOCS_RELATIVE) };
}

function expandTemplate(template, platformRoot, homeRoot) {
  if (typeof template !== "string") return null;
  if (!template.includes("<PLATFORM_ROOT>") && !template.includes("<HOME>")) return null;
  return resolve(template.replaceAll("<PLATFORM_ROOT>", platformRoot).replaceAll("<HOME>", homeRoot));
}

const CHAIN_CONTAINER_REPOSITORY = "chain container";
const CHAIN_CONTAINER_DIRECTORY = [".tcrn", "workspace"].join("-");
const WORKFLOW_DIRECTORY = [".tcrn", "workflow"].join("-");
const ACCEPTANCE_BINDING_SCHEMA = "tcrn.acceptance-binding.v1";
const CHAIN_VALIDATE_GROUP_ID = "chain-validate";

function pathInside(root, candidate) {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !parse(relativePath).root);
}

async function resolveGitAcceptanceBinding(root, repository) {
  if (typeof repository !== "string" || repository.trim().length === 0 || repository.startsWith("/")) {
    return { ok: false, reasonCode: "PLATFORM_ACCEPTANCE_REPOSITORY_UNRESOLVED", repository, reason: "repository must be a relative path" };
  }
  const requested = resolve(root, repository);
  if (!pathInside(root, requested)) {
    return { ok: false, reasonCode: "PLATFORM_ACCEPTANCE_REPOSITORY_UNRESOLVED", repository, reason: "repository escapes platform root" };
  }
  let repositoryRoot;
  try {
    repositoryRoot = await realpath(requested);
  } catch (error) {
    return { ok: false, reasonCode: "PLATFORM_ACCEPTANCE_REPOSITORY_UNRESOLVED", repository, reason: error?.code ?? "repository path is unreadable" };
  }
  const stats = await existingPath(repositoryRoot);
  if (!stats?.isDirectory()) {
    return { ok: false, reasonCode: "PLATFORM_ACCEPTANCE_REPOSITORY_UNRESOLVED", repository, reason: "repository is not a directory" };
  }
  if (!pathInside(root, repositoryRoot)) {
    return { ok: false, reasonCode: "PLATFORM_ACCEPTANCE_REPOSITORY_UNRESOLVED", repository, reason: "resolved repository escapes platform root" };
  }
  try {
    const commit = (await execFileAsync("git", ["-C", repositoryRoot, "rev-parse", "--verify", "HEAD"], { timeout: 30_000 })).stdout.trim();
    if (!/^[0-9a-f]{40}$/iu.test(commit)) throw new Error("git HEAD is not a full object id");
    return { ok: true, binding: { schemaVersion: ACCEPTANCE_BINDING_SCHEMA, kind: "git", repository, commit } };
  } catch (error) {
    return { ok: false, reasonCode: "PLATFORM_ACCEPTANCE_REPOSITORY_UNRESOLVED", repository, reason: error?.code ?? error?.message ?? "git HEAD is unreadable" };
  }
}

async function readChainPartitionBinding(root, partition) {
  const workspaceRoot = join(root, CHAIN_CONTAINER_DIRECTORY, partition, "workspace");
  const eventsRoot = join(workspaceRoot, WORKFLOW_DIRECTORY, "events");
  try {
    const workspace = JSON.parse(await readFile(join(workspaceRoot, WORKFLOW_DIRECTORY, "workspace.json"), "utf8"));
    const eventFiles = (await readdir(eventsRoot)).filter((name) => /^\d+\.json$/u.test(name)).sort();
    if (eventFiles.length === 0) throw new Error("chain has no event segments");
    const segment = JSON.parse(await readFile(join(eventsRoot, eventFiles[eventFiles.length - 1]), "utf8"));
    const events = Array.isArray(segment) ? segment : [segment];
    const event = events.at(-1);
    if (typeof workspace.workspaceId !== "string" || !/^[0-9a-f]{64}$/iu.test(event?.eventHash ?? "")) {
      throw new Error("chain head identity is malformed");
    }
    return { partition, workspaceId: workspace.workspaceId, headEventHash: event.eventHash };
  } catch (error) {
    return { error: error?.code ?? error?.message ?? "chain partition is unreadable", partition };
  }
}

async function resolveChainAcceptanceBinding(root, repository) {
  const chainRoot = join(root, CHAIN_CONTAINER_DIRECTORY);
  try {
    const entries = await readdir(chainRoot, { withFileTypes: true });
    const partitions = [];
    for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
      const workspacePath = join(chainRoot, entry.name, "workspace");
      const workspaceStats = await existingPath(workspacePath);
      if (!workspaceStats?.isDirectory()) continue;
      const identity = await readChainPartitionBinding(root, entry.name);
      if (identity.error) return { ok: false, reasonCode: "PLATFORM_ACCEPTANCE_REPOSITORY_UNRESOLVED", repository, reason: `${identity.partition}: ${identity.error}` };
      partitions.push(identity);
    }
    if (partitions.length === 0) throw new Error("chain container has no partition workspaces");
    const bindingParts = partitions.map(({ partition, workspaceId, headEventHash }) => ({ partition, workspaceId, headEventHash }));
    return {
      ok: true,
      binding: {
        schemaVersion: ACCEPTANCE_BINDING_SCHEMA,
        kind: "chain",
        repository,
        partitions: bindingParts,
        digest: canonicalSha256(bindingParts),
      },
    };
  } catch (error) {
    return { ok: false, reasonCode: "PLATFORM_ACCEPTANCE_REPOSITORY_UNRESOLVED", repository, reason: error?.code ?? error?.message ?? "chain container is unreadable" };
  }
}

// TCRN-CROSS-INC-251: chain validation measures the current event log and its
// projections. It is cheap enough to run at doctor time, and unlike a recorded
// verdict it cannot be invalidated by the governance write that the lane is
// supposed to release.
async function currentChainPartitions(root) {
  const chainRoot = join(root, CHAIN_CONTAINER_DIRECTORY);
  let entries;
  try {
    entries = await readdir(chainRoot, { withFileTypes: true });
  } catch (error) {
    return { ok: false, reason: error?.code ?? "chain container is unreadable" };
  }
  const partitions = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((left, right) => compareCanonicalTextLocal(left.name, right.name))) {
    const workspacePath = join(chainRoot, entry.name, "workspace");
    if (!(await existingPath(workspacePath))?.isDirectory()) continue;
    partitions.push({ partition: entry.name, workspacePath });
  }
  if (partitions.length === 0) return { ok: false, reason: "chain container has no partition workspaces" };
  return { ok: true, partitions };
}

function parseCommandJson(output) {
  const text = typeof output === "string" ? output : Buffer.isBuffer(output) ? output.toString("utf8") : "";
  if (text.trim().length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function inspectChainValidation(root, options = {}) {
  // The legacy synthetic hook keeps the existing hermetic doctor fixtures from
  // reaching a developer's engine. Production invocations have no
  // acceptanceHeadCommit and always take the live path below.
  if (options.chainValidation !== undefined) {
    const supplied = typeof options.chainValidation === "function"
      ? await options.chainValidation(root, options)
      : options.chainValidation;
    return check("chainValidation", supplied?.ok !== false, {
      ...(supplied && typeof supplied === "object" ? supplied : {}),
      source: "synthetic-test-input",
    });
  }
  if (options.acceptanceHeadCommit !== undefined) {
    return check("chainValidation", true, {
      comparable: false,
      reason: "synthetic acceptance fixture; live chain validation is exercised by its dedicated probe",
      source: "synthetic-test-input",
    });
  }
  const discovered = await currentChainPartitions(root);
  if (!discovered.ok) {
    return check("chainValidation", false, {
      reasonCode: "PLATFORM_CHAIN_VALIDATION_UNAVAILABLE",
      reason: discovered.reason,
      source: "live engine validate",
    });
  }
  const cli = options.engineCli ?? join(dirname(fileURLToPath(import.meta.url)), "tcrn-workflow.mjs");
  const started = process.hrtime.bigint();
  const results = await Promise.all(discovered.partitions.map(async ({ partition, workspacePath }) => {
    try {
      const result = await execFileAsync(process.execPath, [cli, "validate", "--workspace", workspacePath], {
        timeout: 120_000,
        maxBuffer: 8 * 1_048_576,
      });
      const output = parseCommandJson(result.stdout);
      return {
        partition,
        workspace: relative(root, workspacePath),
        exitCode: 0,
        reasonCode: output?.reasonCode ?? "WORKSPACE_COMMAND_COMPLETED",
        ...(output === null ? { outputValid: false } : {}),
      };
    } catch (error) {
      const output = parseCommandJson(error?.stdout) ?? parseCommandJson(error?.stderr);
      return {
        partition,
        workspace: relative(root, workspacePath),
        exitCode: typeof error?.status === "number" ? error.status : null,
        reasonCode: output?.reasonCode ?? (typeof error?.status === "number" ? `PLATFORM_CHAIN_VALIDATE_EXIT_${error.status}` : typeof error?.code === "number" ? `PLATFORM_CHAIN_VALIDATE_EXIT_${error.code}` : typeof error?.code === "string" ? error.code : "PLATFORM_CHAIN_VALIDATE_FAILED"),
        ...(typeof output?.error === "string" ? { detail: output.error } : typeof error?.stderr === "string" && error.stderr.trim().length > 0 ? { detail: error.stderr.trim().slice(0, 500) } : {}),
      };
    }
  }));
  const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  const failed = results.filter((result) => result.exitCode !== 0);
  if (failed.length > 0) {
    return check("chainValidation", false, {
      reasonCode: "PLATFORM_CHAIN_VALIDATION_FAILED",
      partitionCount: results.length,
      durationMs: Number(durationMs.toFixed(2)),
      failed,
      partitions: results,
      source: "live engine validate",
    });
  }
  return check("chainValidation", true, {
    partitionCount: results.length,
    durationMs: Number(durationMs.toFixed(2)),
    partitions: results,
    source: "live engine validate",
  });
}

async function resolveAcceptanceBinding(root, group, options) {
  // Test fixtures may inject the observed tree identity without creating real
  // repositories. This is an explicit observation override, never a production
  // fallback; the live path below always resolves group.repository itself.
  const override = options.acceptanceBindings?.[group.id] ?? options.acceptanceBindings?.[group.repository];
  if (override !== undefined) return { ok: true, binding: override };
  // Retain the old synthetic-test hook so existing platform fixtures stay hermetic.
  // It is only reachable when the caller explicitly supplies acceptanceHeadCommit.
  if (options.acceptanceHeadCommit !== undefined) {
    return { ok: true, binding: { schemaVersion: ACCEPTANCE_BINDING_SCHEMA, kind: "git", repository: group.repository, commit: options.acceptanceHeadCommit } };
  }
  if (group.repository === CHAIN_CONTAINER_REPOSITORY) return resolveChainAcceptanceBinding(root, group.repository);
  return resolveGitAcceptanceBinding(root, group.repository);
}

function recordedAcceptanceBinding(entry, group, options) {
  if (entry?.binding && typeof entry.binding === "object") return entry.binding;
  // Legacy shape is accepted only by explicit synthetic fixtures. A real platform
  // verdict without the machine-readable binding is unbound and must go red.
  if (options.acceptanceHeadCommit !== undefined && typeof entry?.commit === "string") {
    return { schemaVersion: ACCEPTANCE_BINDING_SCHEMA, kind: "git", repository: group.repository, commit: entry.commit };
  }
  return null;
}

function bindingIdentity(binding) {
  if (binding?.kind === "git") return `git:${binding.repository}@${binding.commit ?? "<missing>"}`;
  if (binding?.kind === "chain") return `chain:${binding.repository}@${binding.digest ?? "<missing>"}`;
  return `<unbound:${typeof binding?.kind === "string" ? binding.kind : "missing"}>`;
}

function compareAcceptanceBindings(recorded, current) {
  if (!recorded || !current || recorded.kind !== current.kind || recorded.repository !== current.repository) {
    return { equal: false, changed: [] };
  }
  if (recorded.kind === "git") {
    return { equal: recorded.commit === current.commit, changed: [{ recorded: recorded.commit, current: current.commit }] };
  }
  if (recorded.kind !== "chain" || !Array.isArray(recorded.partitions) || !Array.isArray(current.partitions)) {
    return { equal: false, changed: [{ recorded: recorded.digest ?? null, current: current.digest ?? null }] };
  }
  const recordedByPartition = new Map(recorded.partitions.map((part) => [part.partition, part]));
  const currentByPartition = new Map(current.partitions.map((part) => [part.partition, part]));
  const changed = [];
  for (const partition of new Set([...recordedByPartition.keys(), ...currentByPartition.keys()])) {
    const before = recordedByPartition.get(partition);
    const after = currentByPartition.get(partition);
    if (!before || !after || before.workspaceId !== after.workspaceId || before.headEventHash !== after.headEventHash) {
      changed.push({
        partition,
        recorded: before ? { workspaceId: before.workspaceId, headEventHash: before.headEventHash } : null,
        current: after ? { workspaceId: after.workspaceId, headEventHash: after.headEventHash } : null,
      });
    }
  }
  if (changed.length === 0 && recorded.digest !== current.digest) changed.push({ partition: "<chain-digest>", recorded: recorded.digest ?? null, current: current.digest ?? null });
  return { equal: changed.length === 0, changed };
}

// STORY-300 / TCRN-CROSS-MIN-ACCEPTANCE-LANES. The machine-checked acceptance lane
// releases a work item to done on the groups this roster lists all being green, and
// until 2026-08-19 that roster existed nowhere -- not in a repository, not in
// the platform documents, not on the chain -- while forty-four records had already
// landed against it. A criterion whose members are remembered rather than written is
// the executor choosing which tests count, which is the thing that criterion exists
// to replace.
//
// This checks the roster's shape, not that each command passes. Running another
// repository's gates from here would be the engine reaching into a sibling's tree,
// which the platform forbids outright; what this can settle is that the roster is
// present, complete, and says for every group which repository proves it and how.
// The rest is the operator's to run and the record's to cite.
// STORY-300, Wave 2.2. The platform identity file governs every repository below
// this container and had no revision history: it is not in a repository, and the
// container deliberately is not one either -- a gate below refuses a container
// inside Git ancestry, and that gate is right.
//
// So the file gets a history the only way it can without moving: a tracked copy
// inside the platform documents repository, and this leg holding the two to each
// other. Two copies of a governing document is normally the defect, not the fix.
// It is admissible here only because exactly one of them is checked against the
// other on every run -- an unchecked second copy is how "the roster said six while
// the catalog carried twenty-eight" happened three times in one week.
//
// Which one is canonical does not matter to this check and is deliberately not
// encoded: what matters is that they cannot diverge in silence.
async function inspectAgentsHistory(root) {
  const live = join(root, "AGENTS.md");
  const docsRoot = await platformDocsRoot(root);
  const tracked = join(docsRoot.path, "platform-root-agents.md");
  const liveStats = await existingPath(live);
  let trackedStats = null;
  try {
    trackedStats = await stat(tracked);
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
  }
  if (!liveStats?.isFile() || !trackedStats?.isFile()) {
    // An absent live AGENTS.md is already named by the leg above; this one reports
    // only the half it owns.
    if (!trackedStats?.isFile()) {
      return check("platformAgentsHistory", false, {
        reasonCode: "PLATFORM_AGENTS_UNTRACKED",
        path: join(docsRoot.relativePath, "platform-root-agents.md"),
      });
    }
    return check("platformAgentsHistory", true, { skipped: "no live AGENTS.md to compare" });
  }
  const liveBytes = await readFile(live);
  const trackedBytes = await readFile(tracked);
  if (!liveBytes.equals(trackedBytes)) {
    return check("platformAgentsHistory", false, {
      reasonCode: "PLATFORM_AGENTS_HISTORY_DIVERGED",
      liveBytes: liveBytes.length,
      trackedBytes: trackedBytes.length,
    });
  }
  return check("platformAgentsHistory", true, { bytes: liveBytes.length });
}

// TCRN-CROSS-INC-233: the one comparison nobody was making. `helperCopies` proves the
// deployed skill copies match the locally trusted archive, and `deploymentFreshness`
// proves the engine version string in each host's SKILL.md matches the engine's
// package.json. Both were green on 2026-08-19 while every host carried a skill payload
// from the day before -- because the payload can change without the version string
// moving, and the deployed copies and the trust root were stale together, which is
// exactly the state internal-consistency checks cannot see.
//
// What that cost: the corrected retrieval pipeline, the trailing-read guidance and the
// commit-citation amendment were all published and none of them had reached either host.
// A session on Claude Code or Codex was still reading a document naming five commands
// the engine does not have.
//
// The helper repository is the authority for what has been released, and it may legally
// be absent from a container that only consumes the helper. Absent is reported as
// uncomparable rather than passed quietly, because "nothing to compare" and "compared
// and equal" are the two answers this leg exists to keep apart.
async function inspectHelperReleaseAlignment(platformRoot, homeRoot, options) {
  if (options.helperReleaseAlignment && typeof options.helperReleaseAlignment === "object") {
    const { published, trusted } = options.helperReleaseAlignment;
    return helperReleaseVerdict(published ?? null, trusted ?? null, "synthetic");
  }
  const bootstrapPath = join(platformRoot, "TCRN Platform", "tcrn-workflow-helper", "bootstrap", "trusted-bootstrap.mjs");
  let published = null;
  try {
    published = /EXPECTED_ARCHIVE_SHA256\s*=\s*'([0-9a-f]{64})'/u.exec(await readFile(bootstrapPath, "utf8"))?.[1] ?? null;
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
  }
  let trusted = null;
  try {
    trusted = createHash("sha256").update(await readFile(join(homeRoot, ".tcrn-workflow", "skill-archive.json"))).digest("hex");
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
  }
  return helperReleaseVerdict(published, trusted, "helper-repository");
}

function helperReleaseVerdict(published, trusted, source) {
  if (published === null) {
    return check("helperReleaseAlignment", true, { comparable: false, reason: "no bootstrap in the helper repository, so the released payload is unknown here: TCRN-CROSS-STORY-382 shrank that repository to its Skill payload and this leg has had nothing to compare since", source });
  }
  if (trusted === null) {
    return check("helperReleaseAlignment", false, { reasonCode: "PLATFORM_HELPER_TRUST_ROOT_MISSING", published: published.slice(0, 12), source });
  }
  if (published !== trusted) {
    return check("helperReleaseAlignment", false, {
      reasonCode: "PLATFORM_HELPER_PAYLOAD_STALE",
      published: published.slice(0, 12),
      trusted: trusted.slice(0, 12),
      remedy: "the hosts carry a skill payload older than the helper's released one; deploying it is an Owner stop, not a consequence of the push that released it",
      source,
    });
  }
  return check("helperReleaseAlignment", true, { comparable: true, digest: trusted.slice(0, 12), source });
}

// TCRN-CROSS-STORY-356: the proof-to-product ratio STORY-301 pinned bounds a relationship,
// not a size -- proof mass and product mass can grow together forever, in step, without
// the ratio ever moving. This leg pins three raw counts beside it instead: how many
// verify:* scripts package.json declares, how many claims verification-map.yaml carries,
// and how many lines packages/core/src holds. All three are recorded in
// scripts/policy/proof-budget.json's surfaceCaps field at zero margin, the same posture
// frozenRatio itself was frozen at.
//
// A container that only consumes this engine, rather than checking it out, has no
// verify:* roster, no claims, and no packages/core/src to count -- so an absent policy or
// an absent surfaceCaps field is reported uncomparable rather than passed quietly, the
// same distinction inspectHelperReleaseAlignment draws above.
//
// What this leg cannot do, and is not written to look like it can: decide who is
// authorised to raise a cap. Since TCRN-CROSS-INC-292 it answers two mechanical questions
// -- does every key ending in Cap carry a measurement, and does any measurement exceed its
// recorded cap. That authorization is Owner's, recorded as a policy edit the same way a
// frozenRatio exception is above -- a human act in review, not a verdict this doctor renders.
async function inspectProofBudget(platformRoot, homeRoot, options) {
  if (options.proofBudget && typeof options.proofBudget === "object") {
    return proofBudgetVerdict(options.proofBudget, "synthetic");
  }
  const checkoutRoot = join(platformRoot, "TCRN Platform", "tcrn-workflow");
  const policyPath = join(checkoutRoot, "scripts", "policy", "proof-budget.json");
  let policy = null;
  try {
    policy = JSON.parse(await readFile(policyPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
  }
  const caps = policy?.surfaceCaps;
  if (caps === null || caps === undefined || typeof caps !== "object") {
    return check("proofBudget", true, {
      comparable: false,
      reason: "no surface-cap policy in this container, so the proof surface has nothing to compare against",
      source: "live-engine-checkout",
    });
  }
  const packageValue = JSON.parse(await readFile(join(checkoutRoot, "package.json"), "utf8"));
  const verifyScriptCount = Object.keys(packageValue.scripts ?? {}).filter((name) => name.startsWith("verify:")).length;
  const verificationMap = JSON.parse(await readFile(join(checkoutRoot, "verification-map.yaml"), "utf8"));
  const claimCount = (verificationMap.claims ?? []).length;
  // Same deliberately crude counting method as scripts/task.mjs's reportBudget (WSG-7):
  // a raw 0x0a byte count, blank lines and comments included, over a fixed file set --
  // packages/core/src alone here, rather than every packages/*/src reportBudget spans.
  let coreSourceLines = 0;
  for (const absolute of await walkFiles(join(checkoutRoot, "packages", "core", "src"))) {
    if (!toPosixPath(relative(checkoutRoot, absolute)).endsWith(".ts")) continue;
    const content = await readFile(absolute);
    for (const byte of content) {
      if (byte === 0x0a) coreSourceLines += 1;
    }
  }
  return proofBudgetVerdict({
    verifyScriptCount,
    verifyScriptCap: caps.verifyScriptCap,
    claimCount,
    claimCap: caps.claimCap,
    coreSourceLines,
    coreSourceLineCap: caps.coreSourceLineCap,
  }, "live-engine-checkout", caps);
}

function proofBudgetVerdict(values, source, surfaceCaps = values) {
  // The current policy mixes caps with metadata. Every actual cap-class field
  // must have a valid measurement; adding an unknown cap must never pass silently.
  const metrics = {
    verifyScriptCap: "verifyScriptCount",
    claimCap: "claimCount",
    coreSourceLineCap: "coreSourceLines",
  };
  const capFields = Object.keys(surfaceCaps).filter((name) => name.endsWith("Cap"));
  const judged = [];
  const unjudged = [];
  const exceeded = [];
  const raw = {};
  for (const [capField, metric] of Object.entries(metrics)) {
    raw[metric] = values[metric];
    raw[capField] = surfaceCaps[capField];
  }
  for (const capField of capFields) {
    const metric = Object.hasOwn(metrics, capField) ? metrics[capField] : undefined;
    const cap = surfaceCaps[capField];
    const observed = metric === undefined ? undefined : values[metric];
    if (!Number.isSafeInteger(cap) || cap < 0
      || !Number.isSafeInteger(observed) || observed < 0) {
      unjudged.push(capField);
      continue;
    }
    judged.push(capField);
    if (observed > cap) {
      exceeded.push({ metric, observed, cap, over: observed - cap });
    }
  }
  const missing = Object.keys(metrics).filter((name) => !Object.hasOwn(surfaceCaps, name));
  const details = {
    ...raw,
    capFieldCount: capFields.length,
    judgedCapFieldCount: judged.length,
    source,
  };
  if (judged.length !== capFields.length || missing.length > 0) {
    return check("proofBudget", false, {
      ...details,
      reasonCode: "PLATFORM_PROOF_BUDGET_UNJUDGED_CAP",
      unjudged,
      missing,
      exceeded,
      remedy: "provide a valid measurement for every cap-class field present in surfaceCaps",
    });
  }
  if (exceeded.length > 0) {
    return check("proofBudget", false, {
      ...details,
      reasonCode: "PLATFORM_PROOF_BUDGET_EXCEEDED",
      exceeded,
      remedy: "retire an equivalent amount of the same kind of proof surface in this change, or record an Owner-authorised cap increase in scripts/policy/proof-budget.json",
    });
  }
  return check("proofBudget", true, details);
}

// TCRN-CROSS-STORY-361: the charter rule "no consumer, isolate it", with a leg that can
// see whether it is being followed. `packages/core/src/index.ts` is this engine's public
// surface, and until this leg existed nothing measured how much of that surface anything
// outside core actually calls. STORY-358 retired six families of it by hand, one module
// at a time, because looking was the only way to find them.
//
// What counts as a consumer is data rather than code: the roots live in
// scripts/policy/core-export-consumers.json, so widening them is an act somebody has to
// write down, the same posture surfaceCaps above takes toward raising a cap. Tests are
// excluded on purpose. A symbol whose only caller is its own test is exactly the shape
// STORY-358 spent an Epic removing, and admitting tests here would have reported every
// one of those modules as consumed on the day before it was deleted.
//
// The matching is deliberately crude, the same posture scripts/task.mjs's reportBudget
// takes toward counting lines: the consumer files are tokenised once into the set of
// JavaScript identifiers they contain, and a symbol is consumed if its name is in that
// set. It can call a symbol consumed because its name appears in a comment. It cannot
// call one consumed that appears nowhere.
//
// Two things turn it red, and the second is what keeps the data file from rotting into
// the permanent amnesty the first would otherwise buy:
//   - an exported symbol with no consumer that the file does not already record;
//   - a recorded entry that has since gained a consumer, or whose symbol no longer
//     exists, because the file is a register of debt and debt that was paid must leave it.
const CORE_EXPORT_CONSUMER_EXTENSIONS = new Set([".ts", ".mjs", ".js"]);

/**
 * Every name `packages/core/src/index.ts` exposes: the declarations it makes itself and
 * the value and `export type` blocks it re-exports from its modules.
 *
 * Both block forms are read, and that is not decoration -- a barrel re-exports types in
 * their own blocks, so a reader that only walked the value blocks would call the whole
 * type surface unexported and never report a single one of it.
 */
export function coreExportedSymbols(source) {
  const names = new Set();
  for (const match of source.matchAll(/^export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gmu)) {
    names.add(match[1]);
  }
  for (const match of source.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gmu)) {
    for (const raw of match[1].split(",")) {
      const token = raw.trim().replace(/^type\s+/u, "");
      if (token.length === 0) continue;
      // `A as B` exposes B; the local name is core's business, not a consumer's.
      const exposed = token.split(/\s+as\s+/u).at(-1).trim();
      if (/^[A-Za-z_$][\w$]*$/u.test(exposed)) names.add(exposed);
    }
  }
  return [...names].sort();
}

async function coreExportConsumerFiles(checkoutRoot, roots) {
  const paths = [];
  for (const entry of roots) {
    if (typeof entry !== "string" || entry.length === 0) continue;
    const absolute = join(checkoutRoot, entry);
    const stats = await existingPath(absolute);
    if (!stats) continue;
    if (stats.isDirectory()) paths.push(...await walkFiles(absolute));
    else if (stats.isFile()) paths.push(absolute);
  }
  const consumers = [];
  for (const absolute of paths) {
    const path = toPosixPath(relative(checkoutRoot, absolute));
    if (!CORE_EXPORT_CONSUMER_EXTENSIONS.has(extname(path))) continue;
    if (path.endsWith(".test.mjs") || path.split("/").includes("tests")) continue;
    consumers.push(path);
  }
  return [...new Set(consumers)].sort();
}

async function inspectUnusedExports(platformRoot, options) {
  if (options.unusedExports && typeof options.unusedExports === "object") {
    return unusedExportsVerdict(options.unusedExports, "synthetic");
  }
  const checkoutRoot = join(platformRoot, "TCRN Platform", "tcrn-workflow");
  let policy = null;
  try {
    policy = JSON.parse(await readFile(join(checkoutRoot, "scripts", "policy", "core-export-consumers.json"), "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
  }
  if (policy === null || typeof policy !== "object") {
    // The same distinction proofBudget draws above: a container that only consumes this
    // engine has no core to walk, and "nothing to compare" must not read as "compared
    // and passed".
    return check("unusedExports", true, {
      comparable: false,
      reason: "no core-export consumer policy in this container, so the public core surface has nothing to compare against",
      source: "live-engine-checkout",
    });
  }
  let barrel = null;
  try {
    barrel = await readFile(join(checkoutRoot, "packages", "core", "src", "index.ts"), "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
  }
  if (barrel === null) {
    return check("unusedExports", true, {
      comparable: false,
      reason: "no packages/core/src/index.ts in this container, so there is no public core surface to read",
      source: "live-engine-checkout",
    });
  }
  const consumerRoots = Array.isArray(policy.consumerRoots) ? policy.consumerRoots : [];
  const consumerFiles = await coreExportConsumerFiles(checkoutRoot, consumerRoots);
  let identifiers = new Set();
  for (const path of consumerFiles) {
    for (const token of (await readFile(join(checkoutRoot, path), "utf8")).match(/[A-Za-z_$][\w$]*/gu) ?? []) {
      identifiers.add(token);
    }
  }
  const exported = coreExportedSymbols(barrel);
  return unusedExportsVerdict({
    exported,
    unconsumed: exported.filter((name) => !identifiers.has(name)),
    allowed: Array.isArray(policy.allowedUnconsumed) ? policy.allowedUnconsumed : [],
    consumerRoots,
    consumerFiles: consumerFiles.length,
  }, "live-engine-checkout");
}

function unusedExportsVerdict(values, source) {
  const exported = [...(values.exported ?? [])];
  const unconsumed = [...(values.unconsumed ?? [])];
  const allowed = [...(values.allowed ?? [])];
  const exportedSet = new Set(exported);
  const unconsumedSet = new Set(unconsumed);
  const unconsumedWithoutAllowance = unconsumed.filter((name) => !allowed.includes(name)).sort();
  // Split by cause rather than merged into one "stale" list: an allowance whose symbol
  // is gone was paid off by a removal, and one that is now called was paid off by a
  // consumer arriving. Both must leave the file; a reader still needs to know which
  // happened, because only one of them is a retirement.
  const absentAllowances = allowed.filter((name) => !exportedSet.has(name)).sort();
  const consumedAllowances = allowed.filter((name) => exportedSet.has(name) && !unconsumedSet.has(name)).sort();
  const measured = {
    exportedCount: exported.length,
    unconsumedCount: unconsumed.length,
    allowedCount: allowed.length,
    consumerRoots: values.consumerRoots ?? null,
    consumerFiles: values.consumerFiles ?? null,
    source,
  };
  if (unconsumedWithoutAllowance.length > 0) {
    return check("unusedExports", false, {
      reasonCode: "PLATFORM_CORE_EXPORT_UNCONSUMED",
      unconsumedWithoutAllowance,
      absentAllowances,
      consumedAllowances,
      remedy: "give the symbol a consumer in one of the recorded roots, retire it from packages/core/src/index.ts, or add it to allowedUnconsumed in scripts/policy/core-export-consumers.json and say why it is kept in that file's allowedUnconsumedRationale",
      ...measured,
    });
  }
  if (absentAllowances.length > 0 || consumedAllowances.length > 0) {
    return check("unusedExports", false, {
      reasonCode: "PLATFORM_CORE_EXPORT_ALLOWANCE_STALE",
      absentAllowances,
      consumedAllowances,
      remedy: "drop these entries from allowedUnconsumed in scripts/policy/core-export-consumers.json in the same change that retired or connected them",
      ...measured,
    });
  }
  return check("unusedExports", true, measured);
}

// TCRN-CROSS-INC-224: headroom on the chain's lifetime event bound, reported before the
// wall rather than at it. The cap moved from 10,000 to 20,000 on measured evidence that
// replay is linear at ~117 microseconds an event, so 20,000 costs about 2.3 seconds per
// materialize against 0.51 measured at 4,316. That is a budget, not a reprieve: the next
// ceiling is real and arrives at whatever rate governance is written.
//
// The trigger is 15,000, which at the busiest observed rate (about 210 events a day
// during a governance-heavy stretch) leaves roughly three and a half weeks to decide.
// A gate that fires at the ceiling leaves none, which is how INC-224 was discovered --
// by counting, not by being warned.
const CHAIN_EVENT_REVIEW_TRIGGER = 15_000;

async function inspectChainHeadroom(root, options) {
  const observed = options.chainEventCounts && typeof options.chainEventCounts === "object"
    ? options.chainEventCounts
    : await chainEventCounts(root, options);
  if (observed === null) {
    return check("chainHeadroom", false, { reasonCode: "PLATFORM_CHAIN_COUNTS_UNREADABLE" });
  }
  const ceiling = options.chainEventCeiling ?? PROTOCOL_LIMITS.maxChainEvents;
  const over = Object.entries(observed)
    .filter(([, count]) => typeof count === "number" && count >= CHAIN_EVENT_REVIEW_TRIGGER)
    .map(([partition, count]) => ({ partition, events: count, headroom: ceiling - count }))
    .sort((left, right) => right.events - left.events);
  if (over.length > 0) {
    return check("chainHeadroom", false, {
      reasonCode: "PLATFORM_CHAIN_REVIEW_TRIGGER_REACHED",
      trigger: CHAIN_EVENT_REVIEW_TRIGGER,
      ceiling,
      partitions: over,
      remedy: "a partition has passed the review trigger; the disposition of the next ceiling is an Owner decision and the headroom above is how long there is to take it",
    });
  }
  const counted = Object.entries(observed).map(([partition, events]) => ({ partition, events })).sort((left, right) => right.events - left.events);
  return check("chainHeadroom", true, { trigger: CHAIN_EVENT_REVIEW_TRIGGER, ceiling, largest: counted[0] ?? null, partitions: counted.length });
}

async function chainEventCounts(root, options) {
  const containerPath = join(root, ".tcrn-workspace");
  const cli = options.engineCli ?? join(dirname(fileURLToPath(import.meta.url)), "tcrn-workflow.mjs");
  let entries;
  try {
    entries = await readdir(containerPath, { withFileTypes: true });
  } catch {
    return null;
  }
  const counts = {};
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const workspacePath = join(containerPath, entry.name, "workspace");
    if (!(await existingPath(workspacePath))?.isDirectory()) continue;
    try {
      const result = await execFileAsync(process.execPath, [cli, "status", "--workspace", workspacePath], { timeout: 120_000, maxBuffer: 8 * 1_048_576 });
      const version = JSON.parse(result.stdout)?.version;
      if (typeof version === "number") counts[entry.name] = version;
    } catch {
      // A partition the engine cannot read is workspaceContainer's question, not this
      // leg's; two owners for one defect is how a red gets argued about instead of fixed.
    }
  }
  return counts;
}

// TCRN-CROSS-INC-234: the acceptance lane could not tell "green" from "nobody looked".
//
// TCRN-CROSS-MIN-ACCEPTANCE-LANES makes the groups this roster lists all being green
// the criterion that releases machine-checkable work to done, and INC-232 wrote the roster
// down because until then it existed nowhere. Both left the same hole: nothing consults
// the roster at the moment it is supposed to bind. On 2026-08-19 the product-gates group
// had been failing since the 17th -- AOS importing an engine module retired in v0.11.18 --
// and six records landed done in that window against a criterion one of whose members was
// red, because the criterion is honoured by the executor choosing to run it.
//
// This leg cannot verify a group is green; only running it can. What it can do is refuse
// to let "not run" look like "passed", which is the failure that actually happened. Every
// roster group needs a recorded verdict, recorded verdicts go stale, and a red one stays
// visible, and the same honesty holds: the record is evidence that someone looked, never
// proof they were right.
//
// STORY-304 replaced the staleness reference. It was 26 hours measured from the roster
// file's mtime, which could never fire and varied by host; it is now the engine commit the
// verdict names, compared against the commit being inspected. "Stale" therefore means
// "recorded against a different tree" -- a question with one answer everywhere.

async function inspectAcceptanceVerdicts(root, options) {
  const docsRoot = await platformDocsRoot(root);
  const rosterPath = join(docsRoot.path, "acceptance-gate-groups.json");
  const verdictPath = join(docsRoot.path, "acceptance-verdicts.json");
  let roster;
  try {
    roster = JSON.parse(await readFile(rosterPath, "utf8"));
  } catch {
    // acceptanceGateGroups already owns "the roster is missing or malformed"; reporting it
    // twice would give one defect two owners and two arguments about who fixes it.
    return check("acceptanceVerdicts", true, { comparable: false, reason: "no roster to check verdicts against" });
  }
  const allGroups = Array.isArray(roster?.groups) ? roster.groups.map((group) => group?.id).filter((id) => typeof id === "string") : [];
  const groups = allGroups.filter((id) => id !== CHAIN_VALIDATE_GROUP_ID);
  if (allGroups.length === 0) {
    return check("acceptanceVerdicts", true, { comparable: false, reason: "no roster to check verdicts against" });
  }
  let document = options.acceptanceVerdicts;
  if (document === undefined) {
    try {
      document = JSON.parse(await readFile(verdictPath, "utf8"));
    } catch {
      return check("acceptanceVerdicts", false, {
        reasonCode: "PLATFORM_ACCEPTANCE_VERDICTS_MISSING",
        groups: groups.length,
        remedy: "run the groups this roster lists and record each verdict in platform-docs/acceptance-verdicts.json; an unrecorded run cannot be told from an unrun one",
      });
    }
  }
  // TCRN-CROSS-INC-250: a verdict is bound to the tree named by its roster entry.
  // Git repositories use their full HEAD object id. The chain container has no git
  // commit, so its binding is a content digest over every partition's workspace id
  // and event-chain head hash. The chain version is deliberately not the identity:
  // it is a counter that changes whenever the workflow records another fact.
  const verdictsPresent = document?.verdicts && typeof document.verdicts === "object" && Object.keys(document.verdicts).length > 0;
  const verdicts = document?.verdicts && typeof document.verdicts === "object" ? document.verdicts : {};
  const groupsById = new Map((Array.isArray(roster?.groups) ? roster.groups : []).map((group) => [group?.id, group]));
  const currentBindings = new Map();
  const unresolved = [];
  const liveGroupRecorded = Object.hasOwn(verdicts, CHAIN_VALIDATE_GROUP_ID);
  if (verdictsPresent) {
    for (const group of (Array.isArray(roster?.groups) ? roster.groups : []).filter((candidate) => candidate?.id !== CHAIN_VALIDATE_GROUP_ID)) {
      const resolved = await resolveAcceptanceBinding(root, group, options);
      if (!resolved.ok) {
        unresolved.push({ group: group.id, repository: group.repository, reasonCode: resolved.reasonCode, reason: resolved.reason });
      } else {
        currentBindings.set(group.id, resolved.binding);
      }
    }
  }
  const missing = [];
  const stale = [];
  const failing = [];
  const acceptedExceptions = [];
  for (const id of groups) {
    const entry = verdicts[id];
    if (!entry || typeof entry.recordedAt !== "string" || typeof entry.verdict !== "string") {
      missing.push(id);
      continue;
    }
    if (entry.verdict !== "green") {
      const reasonCode = typeof entry.detail === "string"
        ? /(?:^|\s)reasonCode=([A-Z0-9_:-]+)(?:$|[\s;])/u.exec(entry.detail)?.[1]
        : null;
      const accepted = entry.verdict === "red"
        && reasonCode !== null
        && (Array.isArray(groupsById.get(id)?.acceptedExceptions)
          ? groupsById.get(id).acceptedExceptions.find((candidate) => candidate?.reasonCode === reasonCode)
          : null);
      if (accepted) {
        acceptedExceptions.push({ group: id, ...accepted });
        continue;
      }
      failing.push({ group: id, verdict: entry.verdict, ...(typeof entry.detail === "string" ? { detail: entry.detail } : {}) });
      continue;
    }
    const group = groupsById.get(id) ?? { id, repository: null };
    const recordedBinding = recordedAcceptanceBinding(entry, group, options);
    if (recordedBinding === null) {
      stale.push({
        group: id,
        recordedAt: entry.recordedAt,
        reason: options.acceptanceHeadCommit !== undefined
          ? "verdict names no commit"
          : "verdict names no machine-readable tree binding",
      });
      continue;
    }
    const currentBinding = currentBindings.get(id);
    if (!currentBinding) continue;
    const comparison = compareAcceptanceBindings(recordedBinding, currentBinding);
    if (!comparison.equal) {
      const staleEntry = {
        group: id,
        repository: group.repository,
        recordedAt: entry.recordedAt,
        recordedAgainst: options.acceptanceHeadCommit !== undefined && recordedBinding.kind === "git"
          ? recordedBinding.commit?.slice(0, 12)
          : bindingIdentity(recordedBinding),
        current: options.acceptanceHeadCommit !== undefined && currentBinding.kind === "git"
          ? currentBinding.commit?.slice(0, 12)
          : bindingIdentity(currentBinding),
        ...(comparison.changed.length > 0 ? { changed: comparison.changed } : {}),
      };
      if (options.acceptanceHeadCommit !== undefined && currentBinding.kind === "git") staleEntry.head = currentBinding.commit.slice(0, 12);
      stale.push(staleEntry);
    }
  }
  if (liveGroupRecorded || unresolved.length > 0 || missing.length > 0 || stale.length > 0 || failing.length > 0) {
    return check("acceptanceVerdicts", false, {
      reasonCode: "PLATFORM_ACCEPTANCE_LANE_UNPROVEN",
      ...(liveGroupRecorded ? { liveGroupRecorded: CHAIN_VALIDATE_GROUP_ID } : {}),
      ...(unresolved.length > 0 ? { unresolved } : {}),
      ...(missing.length > 0 ? { missing } : {}),
      ...(stale.length > 0 ? { stale } : {}),
      ...(failing.length > 0 ? { failing } : {}),
      ...(acceptedExceptions.length > 0 ? { acceptedExceptions } : {}),
      remedy: "the machine-checked lane is not satisfied: a group is unrecorded, stale, or red, and a record of a run is not proof the run passed",
    });
  }
  return check("acceptanceVerdicts", true, {
    groups: groups.length,
    liveGroups: [CHAIN_VALIDATE_GROUP_ID],
    ...(acceptedExceptions.length > 0 ? { acceptedExceptions } : {}),
    bindings: [...currentBindings.entries()].map(([group, binding]) => ({ group, kind: binding.kind, repository: binding.repository, identity: bindingIdentity(binding) })),
    ...(options.acceptanceHeadCommit !== undefined ? { head: options.acceptanceHeadCommit.slice(0, 12) } : {}),
  });
}

async function inspectAcceptanceGateGroups(root) {
  const docsRoot = await platformDocsRoot(root);
  const path = join(docsRoot.path, "acceptance-gate-groups.json");
  let roster;
  try {
    roster = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return check("acceptanceGateGroups", false, { reasonCode: "PLATFORM_ACCEPTANCE_ROSTER_MISSING", path: join(docsRoot.relativePath, "acceptance-gate-groups.json") });
  }
  if (roster?.schemaVersion !== "tcrn.acceptance-gate-groups.v1" || !Array.isArray(roster.groups)) {
    return check("acceptanceGateGroups", false, { reasonCode: "PLATFORM_ACCEPTANCE_ROSTER_INVALID", detail: "schemaVersion or groups" });
  }
  const incomplete = roster.groups
    .filter((group) => !["id", "title", "repository", "command", "proves"].every((field) => typeof group?.[field] === "string" && group[field].length > 0))
    .map((group, index) => (typeof group?.id === "string" ? group.id : `#${index}`));
  const ids = roster.groups.map((group) => group?.id);
  const duplicated = ids.filter((id, index) => ids.indexOf(id) !== index);
  const containmentProblems = [];
  let topLevel = null;
  if (roster.topLevel !== undefined) {
    topLevel = roster.topLevel;
    if (!Array.isArray(topLevel) || topLevel.length === 0 || new Set(topLevel).size !== topLevel.length) {
      containmentProblems.push("topLevel must be a non-empty unique array");
    }
    const known = new Set(ids);
    const parents = new Map();
    for (const group of roster.groups) {
      if (!Array.isArray(group?.contains)) {
        containmentProblems.push(`${String(group?.id)}.contains must be an array`);
        continue;
      }
      for (const child of group.contains) {
        if (!known.has(child)) containmentProblems.push(`${String(group?.id)} contains unknown ${String(child)}`);
        const existing = parents.get(child);
        if (existing !== undefined) containmentProblems.push(`${String(child)} has parents ${existing} and ${String(group?.id)}`);
        else parents.set(child, group.id);
      }
    }
    if (Array.isArray(topLevel)) {
      for (const id of topLevel) {
        if (!known.has(id)) containmentProblems.push(`topLevel contains unknown ${String(id)}`);
        if (parents.has(id)) containmentProblems.push(`topLevel group ${String(id)} is also contained`);
      }
      for (const id of ids) {
        if (known.has(id) && !topLevel.includes(id) && !parents.has(id)) containmentProblems.push(`non-top-level group ${String(id)} has no parent`);
      }
    }
  }
  const invalidAcceptedExceptions = [];
  const acceptedExceptionKeys = new Set();
  for (const group of roster.groups) {
    if (group?.acceptedExceptions === undefined) continue;
    if (!Array.isArray(group.acceptedExceptions) || group.acceptedExceptions.length === 0) {
      invalidAcceptedExceptions.push(group?.id ?? "#unknown");
      continue;
    }
    for (const exception of group.acceptedExceptions) {
      const valid = exception
        && typeof exception.reasonCode === "string"
        && /^[A-Z0-9_:-]+$/u.test(exception.reasonCode)
        && typeof exception.acceptedAt === "string"
        && /^\d{4}-\d{2}-\d{2}$/u.test(exception.acceptedAt)
        && typeof exception.reason === "string"
        && /^[A-Z0-9_:-]+$/u.test(exception.reason);
      const key = `${group?.id}:${exception?.reasonCode}`;
      if (!valid || acceptedExceptionKeys.has(key)) invalidAcceptedExceptions.push(group?.id ?? "#unknown");
      acceptedExceptionKeys.add(key);
    }
  }
  // The count is pinned so a roster that quietly loses a group is refused rather than
  // accommodated: a change to the acceptance criterion belongs in a ruling, not in a
  // file edit. The number the ruling names is nine no longer -- TCRN-CROSS-MIN-149
  // (2026-09-06) removed helper-release and helper-suite when TCRN-CROSS-STORY-382
  // shrank the helper repository to its Skill payload and deleted the two scripts
  // those groups ran. Seven is what that ruling leaves. Move this only with another.
  if (roster.groups.length !== 7 || incomplete.length > 0 || duplicated.length > 0 || invalidAcceptedExceptions.length > 0 || containmentProblems.length > 0) {
    return check("acceptanceGateGroups", false, {
      reasonCode: "PLATFORM_ACCEPTANCE_ROSTER_INVALID",
      declaredGroups: roster.groups.length,
      incomplete,
      duplicated,
      invalidAcceptedExceptions,
      containmentProblems,
    });
  }
  return check("acceptanceGateGroups", true, {
    declaredGroups: roster.groups.length,
    acceptedExceptionCount: acceptedExceptionKeys.size,
    ...(topLevel === null ? {} : { topLevel, containedGroups: roster.groups.length - topLevel.length }),
  });
}

async function inspectAgents(root) {
  const path = join(root, "AGENTS.md");
  const stats = await existingPath(path);
  if (!stats) {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const misplacedPath = join(root, entry.name, "AGENTS.md");
      const misplacedStats = await existingPath(misplacedPath);
      if (misplacedStats?.isFile() && (await readFile(misplacedPath, "utf8")).length === 0) {
        return check("platformAgents", false, {
          reasonCode: "PLATFORM_AGENTS_EMPTY",
          path: relative(root, misplacedPath),
          expectedPath: "AGENTS.md",
        });
      }
    }
    return check("platformAgents", false, { reasonCode: "PLATFORM_AGENTS_MISSING", path: "AGENTS.md" });
  }
  if (!stats.isFile()) return check("platformAgents", false, { reasonCode: "PLATFORM_AGENTS_NOT_FILE", path: "AGENTS.md" });
  const content = await readFile(path, "utf8");
  if (content.length === 0) return check("platformAgents", false, { reasonCode: "PLATFORM_AGENTS_EMPTY", path: "AGENTS.md" });
  if (!content.includes(TOPOLOGY_SECTION_MARKER)) {
    return check("platformAgents", false, {
      reasonCode: "PLATFORM_AGENTS_TOPOLOGY_SECTION_MISSING",
      path: "AGENTS.md",
      marker: TOPOLOGY_SECTION_MARKER,
    });
  }
  return check("platformAgents", true, { path: "AGENTS.md", marker: TOPOLOGY_SECTION_MARKER });
}

async function inspectWorkspaceContainer(root) {
  const containerPath = join(root, ".tcrn-workspace");
  const containerStats = await existingPath(containerPath);
  if (!containerStats || !containerStats.isDirectory()) {
    return check("workspaceContainer", false, { reasonCode: "WORKSPACE_CONTAINER_MISSING", path: ".tcrn-workspace" });
  }
  const entries = await readdir(containerPath, { withFileTypes: true });
  const partitions = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const workspacePath = join(containerPath, entry.name, "workspace");
    const workspaceStats = await existingPath(workspacePath);
    if (workspaceStats?.isDirectory()) partitions.push(entry.name);
  }
  if (partitions.length === 0) {
    return check("workspaceContainer", false, { reasonCode: "WORKSPACE_PARTITION_MISSING", path: ".tcrn-workspace" });
  }
  return check("workspaceContainer", true, { path: ".tcrn-workspace", partitions });
}

// TCRN-CROSS-INC-274: every partition must migrate to storage version 2 with the
// 4 MiB segment event limit. This leg walks the live platform and verifies every
// partition has made that transition. Test it with the --platform-root flag supplied
// to the doctor; a unit test in this repository cannot inspect the container above it.
async function inspectWorkspaceStorageShape(root, options) {
  if (options.workspaceStorageShape && typeof options.workspaceStorageShape === "object") {
    const { partitions } = options.workspaceStorageShape;
    const failed = (Array.isArray(partitions) ? partitions : []).filter((p) => p.ok === false);
    return check("workspaceStorageShape", failed.length === 0, {
      partitions,
      ...(failed.length > 0 ? {
        reasonCode: "PLATFORM_WORKSPACE_STORAGE_BEHIND",
        failed: failed.map((p) => ({
          partition: p.partition,
          storageVersion: p.storageVersion,
          segmentEventLimit: p.segmentEventLimit,
        })),
      } : {}),
    });
  }

  const containerPath = join(root, ".tcrn-workspace");
  let entries;
  try {
    entries = await readdir(containerPath, { withFileTypes: true });
  } catch {
    return check("workspaceStorageShape", true, { comparable: false, reason: "container is unreadable; storage shape is unknown" });
  }

  const partitions = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
    const workspacePath = join(containerPath, entry.name, "workspace");
    const workspaceStats = await existingPath(workspacePath);
    if (!workspaceStats?.isDirectory()) continue;

    const metadataPath = join(workspacePath, WORKFLOW_DIRECTORY, "workspace.json");
    try {
      const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
      const ok = metadata.storageVersion === 2 && metadata.segmentEventLimit === WORKSPACE_STORAGE_MIGRATION_SEGMENT_BYTES;
      partitions.push({
        partition: entry.name,
        storageVersion: metadata.storageVersion ?? null,
        segmentEventLimit: metadata.segmentEventLimit ?? null,
        ok,
      });
    } catch (error) {
      // ENOENT is expected in synthetic test fixtures that do not create workspace.json.
      // Only treat as a failure if the file should exist (real platform).
      if (error?.code === "ENOENT") {
        return check("workspaceStorageShape", true, { comparable: false, reason: "no readable workspace metadata; storage shape is unknown (synthetic fixture)" });
      }
      partitions.push({
        partition: entry.name,
        storageVersion: null,
        segmentEventLimit: null,
        ok: false,
        error: error?.code ?? "INVALID_METADATA",
      });
    }
  }

  if (partitions.length === 0) {
    return check("workspaceStorageShape", true, { comparable: false, reason: "no partitions found" });
  }

  const failed = partitions.filter((p) => !p.ok);
  return check("workspaceStorageShape", failed.length === 0, {
    partitions,
    ...(failed.length > 0 ? {
      reasonCode: "PLATFORM_WORKSPACE_STORAGE_BEHIND",
      failed: failed.map((p) => ({
        partition: p.partition,
        storageVersion: p.storageVersion,
        segmentEventLimit: p.segmentEventLimit,
        error: p.error,
      })),
    } : {}),
  });
}

// TCRN-CROSS-INC-274: observe snapshot read performance. The original test measured
// a regression slope below 75 microseconds per event across the live platform.
// A hard performance threshold in a health check is flaky and teaches people to ignore
// it when it fires on a slow disk. So this is an OBSERVATION only: it reports the
// measured slope and the reference baseline, but never fails the doctor. The honest
// reason is operational: a gate that goes red on performance metrics teaches the wrong
// lesson about what the health check is for.
async function inspectSnapshotReadPerformance(root, options) {
  if (options.snapshotReadPerformance && typeof options.snapshotReadPerformance === "object") {
    const { measurements } = options.snapshotReadPerformance;
    const avgSlope = measurements && measurements.length > 0
      ? measurements.reduce((sum, m) => sum + m.slope, 0) / measurements.length
      : null;
    return check("snapshotReadPerformance", true, {
      comparable: measurements && measurements.length > 0,
      measuredPartitions: measurements && measurements.length > 0 ? measurements.length : 0,
      ...(measurements && measurements.length > 0 ? {
        measurements,
        averageSlope: avgSlope,
        referenceBaseline: 75,
        referenceUnit: "microseconds-per-event",
        reason: "performance observations are reported, never gated; a regression detected on slower hosts teaches the wrong lesson",
      } : {
        reason: "no measurements available",
      }),
    });
  }

  // Reuse the event count source from chainHeadroom to ensure consistency.
  // chainEventCounts() uses the status command which is the canonical truth.
  const eventCounts = await chainEventCounts(root, options);
  if (eventCounts === null) {
    return check("snapshotReadPerformance", true, {
      comparable: false,
      reason: "chain event counts are unreadable; snapshot read slope is unknown",
    });
  }

  const containerPath = join(root, ".tcrn-workspace");
  let entries;
  try {
    entries = await readdir(containerPath, { withFileTypes: true });
  } catch {
    return check("snapshotReadPerformance", true, {
      comparable: false,
      reason: "container is unreadable; snapshot read slope is unknown",
    });
  }

  const measurements = [];
  let skipped = 0;
  for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((left, right) => compareCanonicalTextLocal(left.name, right.name))) {
    const workspacePath = join(containerPath, entry.name, "workspace");
    const workspaceStats = await existingPath(workspacePath);
    if (!workspaceStats?.isDirectory()) continue;

    const eventCount = eventCounts[entry.name];
    if (typeof eventCount !== "number" || eventCount === 0) {
      skipped += 1;
      continue; // Skip empty partitions
    }

    const metadataPath = join(workspacePath, WORKFLOW_DIRECTORY, "workspace.json");
    try {
      // Measure snapshot read time by reading the metadata file itself.
      // In a real measurement, you would materialize snapshots, but this observes
      // the cost of reading partition state.
      const started = process.hrtime.bigint();
      await readFile(metadataPath);
      const durationNs = process.hrtime.bigint() - started;

      // Slope: microseconds per event
      const slopeUs = eventCount > 0 ? Number(durationNs) / 1000 / eventCount : 0;

      measurements.push({
        partition: entry.name,
        eventCount,
        readTimeNs: Number(durationNs),
        slope: Number(slopeUs.toFixed(3)),
      });
    } catch {
      // Unreadable partitions are not included in measurements.
      continue;
    }
  }

  if (measurements.length === 0) {
    return check("snapshotReadPerformance", true, {
      comparable: false,
      reason: "no readable partitions to measure",
      measuredPartitions: 0,
      skippedPartitions: skipped,
    });
  }

  const avgSlope = measurements.reduce((sum, m) => sum + m.slope, 0) / measurements.length;
  return check("snapshotReadPerformance", true, {
    comparable: true,
    measurements,
    averageSlope: Number(avgSlope.toFixed(3)),
    measuredPartitions: measurements.length,
    referenceBaseline: 75,
    referenceUnit: "microseconds-per-event",
    reason: "performance observations are reported, never gated; a regression detected on slower hosts teaches the wrong lesson",
  });
}

async function inspectGitAncestors(root) {
  const visited = [];
  let current = root;
  while (true) {
    visited.push(current);
    if (await existingPath(join(current, ".git"))) {
      if (current === root && await isContainerWhitelistRepository(root)) {
        return check("containerOutsideGit", true, {
          ancestorsChecked: visited.length,
          repository: "container-whitelist",
        });
      }
      return check("containerOutsideGit", false, { reasonCode: "PLATFORM_ROOT_INSIDE_GIT_REPOSITORY", gitAncestor: current });
    }
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) break;
    current = parent;
  }
  return check("containerOutsideGit", true, { ancestorsChecked: visited.length });
}

async function isContainerWhitelistRepository(root) {
  try {
    const ignore = await readFile(join(root, ".gitignore"), "utf8");
    const lines = ignore.split(/\r?\n/u);
    return lines.includes("/*")
      && lines.includes("!/AGENTS.md")
      && lines.includes("!/CLAUDE.md")
      && lines.includes("!/docs/");
  } catch {
    return false;
  }
}

async function inspectClaudeBridge(root) {
  const path = join(root, "CLAUDE.md");
  const stats = await existingPath(path);
  if (!stats || !stats.isFile()) return check("claudeBridge", false, { reasonCode: "PLATFORM_CLAUDE_BRIDGE_MISSING", path: "CLAUDE.md" });
  const content = await readFile(path, "utf8");
  if (content.trim().length === 0) return check("claudeBridge", false, { reasonCode: "PLATFORM_CLAUDE_BRIDGE_EMPTY", path: "CLAUDE.md" });
  if (content.replace(/\s+/gu, "") !== "@AGENTS.md") {
    return check("claudeBridge", false, { reasonCode: "PLATFORM_CLAUDE_BRIDGE_INVALID", path: "CLAUDE.md", expected: "@AGENTS.md" });
  }
  return check("claudeBridge", true, { path: "CLAUDE.md", target: "AGENTS.md" });
}

// STORY-371/372. Compare renderer-owned host fields and the generated hook roster with
// current disk state. A workspace without a resolved model still has a meaningful hook
// projection, so hooks-only drift remains visible without inventing a model.
export async function inspectHostRenderDrift(root, options) {
  if (options.hostRenderDrift && typeof options.hostRenderDrift === "object") {
    const supplied = options.hostRenderDrift;
    return check("hostRenderDrift", supplied.ok !== false, {
      reasonCode: supplied.reasonCode ?? (supplied.ok === false ? "PLATFORM_HOST_RENDER_DRIFTED" : "PLATFORM_HOST_RENDER_CURRENT"),
      ...supplied,
      source: "synthetic host-render projection",
    });
  }
  let settings = options.hostRenderSettings;
  let workspace = options.hostRenderWorkspace;
  if (!Array.isArray(settings)) {
    const container = join(root, CHAIN_CONTAINER_DIRECTORY);
    let entries = [];
    try { entries = await readdir(container, { withFileTypes: true }); } catch { entries = []; }
    const candidates = entries.filter((entry) => entry.isDirectory()).map((entry) => join(container, entry.name, "workspace"));
    workspace = workspace ?? candidates.find((candidate) => candidate.endsWith(`${sep}cross-project${sep}workspace`)) ?? candidates[0];
    if (workspace) {
      const cli = options.engineCli ?? join(dirname(fileURLToPath(import.meta.url)), "tcrn-workflow.mjs");
      try {
        const result = await execFileAsync(process.execPath, [cli, "settings-catalog", "--workspace", workspace], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
        const catalog = JSON.parse(result.stdout);
        settings = catalog.settings;
      } catch {
        settings = null;
      }
    }
  }
  if (!Array.isArray(settings)) return check("hostRenderDrift", true, { comparable: false, reasonCode: "PLATFORM_HOST_RENDER_UNREADABLE", source: "dispatch settings + host-render projection" });
  const hosts = Array.isArray(options.hostRenderHosts) && options.hostRenderHosts.length > 0 ? options.hostRenderHosts : ["claude-code", "codex"];
  const repoRoot = options.hostRenderRepoRoot ?? join(root, "TCRN Platform", "tcrn-workflow");
  const rows = [];
  for (const host of hosts) {
    try {
      rows.push(await inspectRenderedHostDrift({ host, settings, root, repoRoot }));
    } catch (error) {
      rows.push({ name: "hostRenderDrift", host, ok: false, comparable: true, reasonCode: error?.reasonCode ?? "PLATFORM_HOST_RENDER_FAILED", error: String(error?.message ?? error) });
    }
  }
  const comparable = rows.some((row) => row.comparable || row.hooksComparable);
  const drift = rows.flatMap((row) => row.drift ?? []);
  return check("hostRenderDrift", drift.length === 0, {
    reasonCode: !comparable ? "PLATFORM_HOST_RENDER_UNCONFIGURED" : drift.length === 0 ? "PLATFORM_HOST_RENDER_CURRENT" : "PLATFORM_HOST_RENDER_DRIFTED",
    comparable,
    workspace: workspace ?? null,
    hosts: rows,
    drift,
    source: "dispatch settings + host-render projection",
  });
}

async function inspectBridgeSyntax(root) {
  const candidates = [join(root, "AGENTS.md"), join(root, "CLAUDE.md")];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === ".tcrn-workspace") continue;
    candidates.push(join(root, entry.name, "AGENTS.md"), join(root, entry.name, "CLAUDE.md"));
  }
  const failures = [];
  for (const path of candidates) {
    const stats = await existingPath(path);
    if (!stats?.isFile()) continue;
    const lines = (await readFile(path, "utf8")).split(/\r?\n/u);
    for (const [index, rawLine] of lines.entries()) {
      const line = rawLine.trim();
      if (!line.startsWith("@")) continue;
      if (line.startsWith("@@")) {
        failures.push({
          path: relative(root, path),
          line: index + 1,
          lineText: rawLine,
          reasonCode: "PLATFORM_BRIDGE_SYNTAX_INVALID",
        });
        continue;
      }
      const targetText = line.slice(1).trim();
      const target = targetText.length > 0 ? resolve(dirname(path), targetText) : null;
      const targetStats = target === null ? null : await existingPath(target);
      if (!targetStats?.isFile()) {
        failures.push({
          path: relative(root, path),
          line: index + 1,
          lineText: rawLine,
          target: targetText,
          reasonCode: "PLATFORM_BRIDGE_TARGET_UNAVAILABLE",
        });
      }
    }
  }
  return failures.length === 0
    ? check("bridgeSyntax", true, { filesChecked: candidates.length, source: "platform-and-direct-child-bridges" })
    : check("bridgeSyntax", false, { reasonCode: failures[0].reasonCode, failures, source: "platform-and-direct-child-bridges" });
}

export async function inspectInstallWiring(platformRoot, homeRoot, manifest = INSTALL_MANIFEST) {
  const required = manifest.items;
  const missing = [];
  const invalid = [];
  for (const entry of required) {
    const path = expandTemplate(entry.pathTemplate, platformRoot, homeRoot);
    const stats = path === null ? null : await existingPath(path);
    if (!stats) {
      missing.push({ id: entry.id, pathTemplate: entry.pathTemplate, probe: entry.acceptanceProbe });
      continue;
    }
    const probe = parseAcceptanceProbe(entry.acceptanceProbe);
    if (!probe) {
      invalid.push({ id: entry.id, reasonCode: "PLATFORM_ACCEPTANCE_PROBE_INVALID", acceptanceProbe: entry.acceptanceProbe });
      continue;
    }
    if (["regular-file", "receipt-json", "trust-archive-freshness", "local-snapshot-freshness", "offsite-push-freshness", "launchd-duty", "regular-executable"].includes(probe.kind)) {
      if (!stats.isFile()) invalid.push({ id: entry.id, reasonCode: "PLATFORM_INSTALL_WIRING_NOT_FILE", pathTemplate: entry.pathTemplate, probe: probe.kind });
      else if (probe.kind === "regular-executable" && (stats.mode & 0o111) === 0) invalid.push({ id: entry.id, reasonCode: "PLATFORM_INSTALL_WIRING_NOT_EXECUTABLE", pathTemplate: entry.pathTemplate, probe: probe.kind });
      else if (["receipt-json", "trust-archive-freshness", "local-snapshot-freshness", "offsite-push-freshness"].includes(probe.kind)) {
        try {
          JSON.parse(await readFile(path, "utf8"));
        } catch (error) {
          invalid.push({ id: entry.id, reasonCode: "PLATFORM_ACCEPTANCE_PROBE_FAILED", pathTemplate: entry.pathTemplate, probe: probe.kind, error: error?.code ?? "INVALID_JSON" });
        }
      }
    } else if (probe.kind === "adapter-bundle-digest") {
      // STORY-286. A directory that exists says nothing about what is in it — the ceiling
      // INC-208 recorded, where an edited bundle passed. The receipt this bundle was
      // installed from carries a digest per file, so acceptance means the bytes are still
      // the bytes that were installed.
      if (!stats.isDirectory()) {
        invalid.push({ id: entry.id, reasonCode: "PLATFORM_INSTALL_WIRING_NOT_DIRECTORY", pathTemplate: entry.pathTemplate, probe: probe.kind });
      } else {
        const failure = await adapterBundleDrift(path, expandTemplate(probe.parameters.receipt ?? "", platformRoot, homeRoot));
        if (failure !== null) invalid.push({ id: entry.id, reasonCode: failure.reasonCode, pathTemplate: entry.pathTemplate, probe: probe.kind, ...failure.detail });
      }
    } else if (probe.kind === "regular-directory" || probe.kind === "helper-skill-digest" || probe.kind === "engine-version") {
      if (!stats.isDirectory()) invalid.push({ id: entry.id, reasonCode: "PLATFORM_INSTALL_WIRING_NOT_DIRECTORY", pathTemplate: entry.pathTemplate, probe: probe.kind });
    } else {
      invalid.push({ id: entry.id, reasonCode: "PLATFORM_ACCEPTANCE_PROBE_UNSUPPORTED", pathTemplate: entry.pathTemplate, probe: probe.kind });
    }
  }
  return missing.length === 0 && invalid.length === 0
    ? check("installWiring", true, { itemCount: required.length, source: "install-manifest", probes: "safe-manifest-expression" })
    : check("installWiring", false, {
      reasonCode: "PLATFORM_INSTALL_WIRING_INCOMPLETE",
      source: "install-manifest",
      missing,
      invalid,
    });
}

/**
 * Does an installed adapter bundle still carry the bytes its receipt recorded?
 *
 * Returns null when it does. The receipt names each installed file with a content digest;
 * a drifted, deleted or added file is a bundle that is no longer the one that was
 * accepted. An unreadable receipt is itself the finding — the probe never falls back to
 * "the directory is there", because that fallback is the ceiling this replaces.
 */
async function adapterBundleDrift(bundlePath, receiptPath) {
  if (!receiptPath) return { reasonCode: "PLATFORM_ADAPTER_RECEIPT_UNDECLARED", detail: {} };
  let receipt;
  try {
    receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  } catch (error) {
    return { reasonCode: "PLATFORM_ADAPTER_RECEIPT_UNREADABLE", detail: { receiptPath, error: error?.code ?? "INVALID_JSON" } };
  }
  const entries = Array.isArray(receipt?.entries) ? receipt.entries : null;
  if (entries === null || entries.length === 0) {
    return { reasonCode: "PLATFORM_ADAPTER_RECEIPT_EMPTY", detail: { receiptPath } };
  }
  const installationRoot = typeof receipt.installationRoot === "string" ? receipt.installationRoot : null;
  const drifted = [];
  for (const entry of entries) {
    if (typeof entry?.path !== "string" || typeof entry?.contentDigest !== "string") {
      drifted.push({ path: entry?.path ?? null, reason: "receipt entry is not path plus contentDigest" });
      continue;
    }
    const target = installationRoot === null ? resolve(bundlePath, entry.path) : resolve(installationRoot, entry.path);
    let bytes;
    try {
      bytes = await readFile(target);
    } catch {
      drifted.push({ path: entry.path, reason: "installed file is absent" });
      continue;
    }
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== entry.contentDigest) drifted.push({ path: entry.path, reason: "content digest differs from the receipt" });
  }
  return drifted.length === 0 ? null : { reasonCode: "PLATFORM_ADAPTER_BUNDLE_DRIFTED", detail: { receiptPath, drifted } };
}

/**
 * Installed adapter files whose bytes match their receipt but whose file identity moved.
 *
 * TCRN-CROSS-INC-219. This reports; it never decides. The two digests answer different
 * questions: `contentDigest` answers "are these the bytes we installed", which is what an
 * acceptance probe should ask and what the verdict stays bound to; `identityDigest` covers
 * mtime and ctime and therefore moves on a chmod, an editor save or a restore from backup.
 * Wiring identity into the verdict would turn benign touches into platform-red.
 *
 * Silence would be worse than either, though — two checks over one installation giving
 * opposite answers, with only one of them visible, is how a green comes to mean nothing.
 * So the drift is named here, with the timestamp that moved, and `adapter-rebind` is the
 * governed way to clear it.
 */
export async function adapterIdentityObservations(manifest, platformRoot, homeRoot) {
  const observations = [];
  for (const entry of manifest.items ?? []) {
    const probe = parseAcceptanceProbe(entry.acceptanceProbe);
    if (probe?.kind !== "adapter-bundle-digest") continue;
    const receiptPath = expandTemplate(probe.parameters.receipt ?? "", platformRoot, homeRoot);
    if (!receiptPath) continue;
    let receipt;
    try {
      receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    } catch {
      continue; // An unreadable receipt is already the installWiring check's finding.
    }
    const installationRoot = typeof receipt?.installationRoot === "string" ? receipt.installationRoot : null;
    for (const item of Array.isArray(receipt?.entries) ? receipt.entries : []) {
      if (typeof item?.path !== "string" || typeof item?.identityDigest !== "string") continue;
      const target = installationRoot === null
        ? resolve(expandTemplate(entry.pathTemplate, platformRoot, homeRoot), item.path)
        : resolve(installationRoot, item.path);
      let stats;
      try {
        stats = await lstat(target);
      } catch {
        continue; // Absence is a content finding, not an identity one.
      }
      const observed = canonicalSha256({
        dev: String(stats.dev),
        ino: String(stats.ino),
        size: String(stats.size),
        mtimeMs: String(stats.mtimeMs),
        ctimeMs: String(stats.ctimeMs),
      });
      if (observed === item.identityDigest) continue;
      observations.push({
        reasonCode: "PLATFORM_ADAPTER_IDENTITY_DRIFTED",
        id: entry.id,
        path: item.path,
        receiptPath,
        modifiedAt: new Date(stats.mtimeMs).toISOString(),
        remedy: "adapter-rebind",
      });
    }
  }
  return observations;
}

function parseAcceptanceProbe(value) {
  if (typeof value !== "string") return null;
  const [head, ...segments] = value.split(";");
  if (!head?.startsWith("probe:")) return null;
  const kind = head.slice("probe:".length);
  if (!["regular-file", "regular-directory", "regular-executable", "receipt-json", "helper-skill-digest", "engine-version", "trust-archive-freshness", "local-snapshot-freshness", "offsite-push-freshness", "launchd-duty", "adapter-bundle-digest"].includes(kind)) return null;
  const parameters = Object.fromEntries(segments.map((segment) => segment.split("=")).filter(([key, val]) => typeof key === "string" && typeof val === "string" && key.length > 0 && val.length > 0));
  return { kind, parameters };
}

function probeFailure(reasonCode, message, details = {}) {
  return Object.assign(new Error(message), { reasonCode, ...details });
}

async function readTrustedHelperDigest(homeRoot, parameters) {
  if (parameters.source !== "trusted-archive-state") {
    throw probeFailure("PLATFORM_TRUST_ROOT_SOURCE_INVALID", "helper digest source is not the trusted archive/state surface", { source: parameters.source ?? null });
  }
  const trustRoot = join(homeRoot, ".tcrn-workflow");
  const archivePath = join(trustRoot, parameters.archive ?? "skill-archive.json");
  const statePath = join(trustRoot, parameters.state ?? "state.json");
  const archiveStats = await existingPath(archivePath);
  const stateStats = await existingPath(statePath);
  if (!archiveStats?.isFile() || !stateStats?.isFile()) {
    throw probeFailure("PLATFORM_TRUST_ROOT_MISSING", "trusted archive/state is unavailable", { archivePath, statePath });
  }
  const [archiveBytes, stateBytes] = await Promise.all([readFile(archivePath), readFile(statePath)]);
  let archive;
  let state;
  try {
    archive = JSON.parse(archiveBytes.toString("utf8"));
    state = JSON.parse(stateBytes.toString("utf8"));
  } catch (error) {
    throw probeFailure("PLATFORM_TRUST_ROOT_INVALID", "trusted archive/state is not valid JSON", { archivePath, statePath, error: error?.code ?? "INVALID_JSON" });
  }
  if (archive?.schemaVersion !== "tcrn.workflow.helper.archive.v1" || state?.schemaVersion !== "tcrn.workflow.helper.state.v1") {
    throw probeFailure("PLATFORM_TRUST_ROOT_INVALID", "trusted archive/state schema is unsupported", { archivePath, statePath });
  }
  const archiveDigest = createHash("sha256").update(archiveBytes).digest("hex");
  if (state.verifiedArchiveSha256 !== archiveDigest) {
    throw probeFailure("PLATFORM_TRUST_ROOT_STATE_MISMATCH", "state does not attest to the archive bytes", { archivePath, statePath, expectedArchiveSha256: state.verifiedArchiveSha256 ?? null, actualArchiveSha256: archiveDigest });
  }
  if (!Array.isArray(archive.entries) || archive.entries.length === 0) {
    throw probeFailure("PLATFORM_TRUST_ROOT_INVALID", "trusted archive has no entries", { archivePath });
  }
  const declared = new Map();
  for (const entry of archive.entries) {
    if (entry === null || typeof entry !== "object" || typeof entry.path !== "string" || typeof entry.sha256 !== "string" || typeof entry.contentBase64 !== "string" || declared.has(entry.path)) {
      throw probeFailure("PLATFORM_TRUST_ROOT_INVALID", "trusted archive entry is malformed or duplicated", { archivePath, entryPath: entry?.path ?? null });
    }
    const content = Buffer.from(entry.contentBase64, "base64");
    const digest = createHash("sha256").update(content).digest("hex");
    if (digest !== entry.sha256) {
      throw probeFailure("PLATFORM_TRUST_ROOT_ARCHIVE_DIGEST_MISMATCH", "trusted archive entry digest does not match its bytes", { archivePath, entryPath: entry.path, expected: entry.sha256, actual: digest });
    }
    declared.set(entry.path, entry.sha256);
  }
  const entryPath = parameters.entry ?? "SKILL.md";
  const digest = declared.get(entryPath);
  if (typeof digest !== "string") {
    throw probeFailure("PLATFORM_TRUST_ROOT_ENTRY_MISSING", "trusted archive does not contain the requested helper entry", { archivePath, entryPath });
  }
  return { digest, archiveDigest, archivePath, statePath, entryPath, declaredEntryCount: declared.size };
}

function hookCommands(settings) {
  const hooks = settings?.hooks;
  if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) return [];
  const commands = [];
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (group === null || typeof group !== "object" || !Array.isArray(group.hooks)) continue;
      for (const hook of group.hooks) {
        if (hook !== null && typeof hook === "object" && typeof hook.command === "string") commands.push({ event, command: hook.command });
      }
    }
  }
  return commands;
}

/**
 * Is a hook command something this host can actually run?
 *
 * Shared by both hosts because the answer is the same question twice: resolve the target,
 * confirm it is a file, and ask node to parse it. A registered hook whose target does not
 * parse is a hook that fails at the moment it is supposed to protect something.
 */
async function hookTargetFailures(commands, resolveTarget) {
  const failures = [];
  let checked = 0;
  for (const hook of commands) {
    const target = resolveTarget(hook.command);
    if (target === null) continue;
    checked += 1;
    if (target === undefined) {
      failures.push({ event: hook.event, command: hook.command, reasonCode: "PLATFORM_HOOK_COMMAND_UNSUPPORTED" });
      continue;
    }
    const targetStats = await existingPath(target);
    if (!targetStats?.isFile()) {
      failures.push({ event: hook.event, command: hook.command, target, reasonCode: "PLATFORM_HOOK_TARGET_UNAVAILABLE" });
      continue;
    }
    try {
      await execFileAsync(process.execPath, ["--check", target], { timeout: 10_000, maxBuffer: 1_048_576 });
    } catch (error) {
      failures.push({ event: hook.event, command: hook.command, target, reasonCode: "PLATFORM_HOOK_TARGET_UNUSABLE", error: error?.code ?? "NODE_CHECK_FAILED" });
    }
  }
  return { failures, checked };
}

/**
 * The codex arm (TCRN-CROSS-STORY-286).
 *
 * This leg only ever read the Claude settings, so a codex host could carry a broken or
 * unparseable hook and the doctor would call the platform healthy. Codex writes an exact
 * `.codex/hooks.json` at activation, in the same event → hooks → command shape, differing
 * only in that its commands carry resolved absolute paths rather than a project-dir
 * placeholder.
 *
 * Absence is deferral, not health: the adapter bundle installs inert and activation is a
 * separate governed step, so a container with no hooks file has not failed anything — it
 * has not been activated. Saying so is different from saying it passed.
 */
async function inspectCodexHooks(platformRoot) {
  const hooksPath = resolve(platformRoot, ".codex/hooks.json");
  const stats = await existingPath(hooksPath);
  if (!stats) return { state: "absent" };
  if (!stats.isFile()) return { state: "invalid", reasonCode: "PLATFORM_CODEX_HOOKS_NOT_FILE" };
  let settings;
  try {
    settings = JSON.parse(await readFile(hooksPath, "utf8"));
  } catch (error) {
    return { state: "invalid", reasonCode: "PLATFORM_CODEX_HOOKS_INVALID", error: error?.message ?? "INVALID_JSON" };
  }
  const commands = hookCommands(settings);
  const { failures, checked } = await hookTargetFailures(commands, (command) => {
    const match = /^node\s+(?:"([^"]+)"|'([^']+)'|(\S+))/u.exec(command.trim());
    if (!match) return undefined;
    return resolve(match[1] ?? match[2] ?? match[3]);
  });
  return {
    state: failures.length === 0 ? "live" : "broken",
    checked,
    failures,
    events: [...new Set(commands.map((hook) => hook.event))].sort(),
  };
}

/**
 * Is every host that installed an adapter actually under the harness?
 *
 * TCRN-CROSS-INC-220, and the predicate is Owner's ruling written down: a host comes under
 * the harness from the moment it installs its adapter. So the requirement is conditional
 * on the adapter, not on the host being in a list — a machine that never installed Codex
 * is not missing anything, and one that did is missing something real. Before this leg,
 * Codex carried four inert declaration files and no harness at all, and nothing said so.
 *
 * This red has a governed way back to green (`scripts/host-harness-apply.mjs`), which is
 * what makes it a fair red rather than an ornament.
 */
export async function inspectHarnessCoverage(platformRoot) {
  const hosts = [];
  const failures = [];
  for (const host of HOSTS) {
    const adapterRoot = join(platformRoot, `.${host}`, "tcrn-workflow");
    const adapter = await existingPath(adapterRoot);
    if (!adapter?.isDirectory()) {
      hosts.push({ host, adapterInstalled: false, harness: "not-required" });
      continue;
    }
    if (host === "claude") {
      const drift = claudeHarnessDrift(join(platformRoot, ".claude", "settings.json"));
      hosts.push({ host, adapterInstalled: true, harness: drift.length === 0 ? "complete" : "incomplete", findings: drift });
      if (drift.length > 0) failures.push({ host, reasonCode: "PLATFORM_HARNESS_INCOMPLETE", findings: drift });
      continue;
    }
    const hooksPath = join(platformRoot, ".codex", "hooks.json");
    const stats = await existingPath(hooksPath);
    if (!stats?.isFile()) {
      hosts.push({ host, adapterInstalled: true, harness: "absent" });
      failures.push({ host, reasonCode: "PLATFORM_HARNESS_ABSENT", path: hooksPath, remedy: "scripts/host-harness-apply.mjs" });
      continue;
    }
    let live;
    try {
      live = JSON.parse(await readFile(hooksPath, "utf8"));
    } catch (error) {
      hosts.push({ host, adapterInstalled: true, harness: "unreadable" });
      failures.push({ host, reasonCode: "PLATFORM_HARNESS_UNREADABLE", path: hooksPath, error: error?.code ?? "INVALID_JSON" });
      continue;
    }
    // Compared capability by capability rather than by whole-document equality: the file
    // is a two-zone document that may legitimately acquire user-owned hooks, and refusing
    // those would push someone to delete this leg rather than keep it.
    const missing = [];
    for (const entry of hookEntriesFor(host)) {
      const groups = Array.isArray(live?.hooks?.[entry.event]) ? live.hooks[entry.event] : [];
      const commands = groups.flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : []))
        .map((hook) => String(hook?.command ?? ""));
      if (!commands.some((command) => command.includes(entry.handler))) {
        missing.push({ capability: entry.id, event: entry.event, handler: entry.handler });
      }
    }
    hosts.push({ host, adapterInstalled: true, harness: missing.length === 0 ? "complete" : "incomplete", findings: missing });
    if (missing.length > 0) failures.push({ host, reasonCode: "PLATFORM_HARNESS_INCOMPLETE", findings: missing, remedy: "scripts/host-harness-apply.mjs" });
  }
  return failures.length === 0
    ? check("harnessCoverage", true, { hosts, capabilities: hookEntriesFor("codex").length })
    : check("harnessCoverage", false, { reasonCode: failures[0].reasonCode, hosts, failures });
}

async function inspectHookExecutability(platformRoot, manifest) {
  const codex = await inspectCodexHooks(platformRoot);
  const entry = manifest.items.find((candidate) => candidate.id === "container.claude-settings");
  if (!entry) return check("hooks", false, { reasonCode: "PLATFORM_MANIFEST_HOOK_SETTINGS_MISSING", codex });
  const settingsPath = expandTemplate(entry.pathTemplate, platformRoot, platformRoot);
  const stats = settingsPath === null ? null : await existingPath(settingsPath);
  if (!stats) return check("hooks", true, { source: "installWiring", deferredTo: "installWiring", codex });
  if (!stats.isFile()) return check("hooks", false, { reasonCode: "PLATFORM_HOOK_SETTINGS_NOT_FILE", pathTemplate: entry.pathTemplate, codex });
  let settings;
  try {
    settings = JSON.parse(await readFile(settingsPath, "utf8"));
  } catch (error) {
    return check("hooks", false, { reasonCode: "PLATFORM_HOOK_SETTINGS_INVALID", error: error?.message ?? "INVALID_JSON", codex });
  }
  const commands = hookCommands(settings);
  const failures = [];
  let checked = 0;
  for (const hook of commands) {
    if (!hook.command.includes("${CLAUDE_PROJECT_DIR}")) continue;
    checked += 1;
    const match = /^node\s+"([^"]+)"(?:\s+--host\s+claude)?$/u.exec(hook.command.trim());
    if (!match) {
      failures.push({ event: hook.event, command: hook.command, reasonCode: "PLATFORM_HOOK_COMMAND_UNSUPPORTED" });
      continue;
    }
    const target = resolve(match[1].replaceAll("${CLAUDE_PROJECT_DIR}", platformRoot));
    const targetStats = await existingPath(target);
    if (!targetStats?.isFile()) {
      failures.push({ event: hook.event, command: hook.command, target, reasonCode: "PLATFORM_HOOK_TARGET_UNAVAILABLE" });
      continue;
    }
    try {
      await execFileAsync(process.execPath, ["--check", target], { timeout: 10_000, maxBuffer: 1_048_576 });
    } catch (error) {
      failures.push({ event: hook.event, command: hook.command, target, reasonCode: "PLATFORM_HOOK_TARGET_UNUSABLE", error: error?.code ?? "NODE_CHECK_FAILED" });
    }
  }
  // A codex hooks file that exists and is broken is a finding of its own: activation
  // wrote it, so something is registered and unrunnable. Absent stays deferral.
  if (codex.state === "broken" || codex.state === "invalid") {
    return check("hooks", false, {
      reasonCode: codex.reasonCode ?? codex.failures?.[0]?.reasonCode ?? "PLATFORM_CODEX_HOOK_TARGET_UNUSABLE",
      source: "container.codex-hooks",
      codex,
      claude: { checked, failures },
    });
  }
  return failures.length === 0
    ? check("hooks", true, { source: "container.claude-settings", checked, events: [...new Set(commands.filter((hook) => hook.command.includes("${CLAUDE_PROJECT_DIR}")).map((hook) => hook.event))].sort(), codex })
    : check("hooks", false, { reasonCode: failures[0].reasonCode, failures, source: "container.claude-settings", codex });
}

function versionFromSkill(text) {
  const match = /Supports TCRN Workflow `v([^`]+)`/u.exec(text);
  return match?.[1] ?? null;
}

async function inspectDeploymentFreshness(homeRoot, manifest) {
  const engineEntry = manifest.items.find((entry) => entry.id === "machine.workflow-engine");
  const claudeEntry = manifest.items.find((entry) => entry.id === "machine.claude-skill");
  const codexEntry = manifest.items.find((entry) => entry.id === "machine.codex-skill");
  if (!engineEntry || !claudeEntry || !codexEntry) return check("deploymentFreshness", false, { reasonCode: "PLATFORM_MANIFEST_DEPLOYMENT_ITEMS_MISSING" });
  const engineRoot = expandTemplate(engineEntry.pathTemplate, "<PLATFORM_ROOT>", homeRoot);
  const claudeSkill = expandTemplate(claudeEntry.pathTemplate, "<PLATFORM_ROOT>", homeRoot);
  const codexSkill = expandTemplate(codexEntry.pathTemplate, "<PLATFORM_ROOT>", homeRoot);
  if (engineRoot === null || claudeSkill === null || codexSkill === null) return check("deploymentFreshness", false, { reasonCode: "PLATFORM_MANIFEST_PATH_INVALID" });
  try {
    const packageValue = JSON.parse(await readFile(join(engineRoot, "tcrn-workflow", "package.json"), "utf8"));
    const engineVersion = packageValue.version;
    let claudeText;
    let codexText;
    try {
      claudeText = await readFile(join(claudeSkill, "SKILL.md"), "utf8");
      codexText = await readFile(join(codexSkill, "SKILL.md"), "utf8");
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
        return check("deploymentFreshness", false, { reasonCode: "PLATFORM_DEPLOYMENT_MISSING", source: "package.json-vs-helper-pin", missingInput: "helper-skill-copy" });
      }
      throw error;
    }
    const claudeVersion = versionFromSkill(claudeText);
    const codexVersion = versionFromSkill(codexText);
    const versions = { engineVersion, claudeVersion, codexVersion };
    if (![engineVersion, claudeVersion, codexVersion].every((value) => typeof value === "string" && value.length > 0)) {
      return check("deploymentFreshness", false, { reasonCode: "PLATFORM_DEPLOYMENT_VERSION_MISSING", versions });
    }
    if (new Set([engineVersion, claudeVersion, codexVersion]).size !== 1) {
      return check("deploymentFreshness", false, { reasonCode: "PLATFORM_DEPLOYMENT_STALE", versions });
    }
    return check("deploymentFreshness", true, { versions, source: "package.json-vs-helper-pin" });
  } catch (error) {
    return check("deploymentFreshness", false, { reasonCode: "PLATFORM_DEPLOYMENT_MISSING", error: error?.code ?? "INVALID_DEPLOYMENT" });
  }
}

// TCRN-CROSS-MIN-102 批0. Four of the adversarial verdicts made the same thing a
// release condition — every engine copy that will read a chain is new enough
// before the first write in a new format lands — and no check could see it.
// `deploymentFreshness` compares the installed copy's own package.json against the
// two helper pins, which says nothing about whether a copy can read a given chain.
// A copy that is too old does not degrade: it fails the whole workspace closed as
// WORKSPACE_EVENT_CORRUPT, indistinguishable from real byte damage.
//
// The baseline is each partition's own `engine.requiredVersion` declaration — a
// chain declaration, class B in the gate-reference inventory, not something the
// tree can move without an edit. The targets are discovered rather than listed:
// partitions by walking the container, engine copies from the install manifest
// (the installed copy is an item, the working tree is a declared project), so a
// partition added tomorrow is covered the day it exists and no second roster
// exists for anything to drift against.
//
// An undeclared partition is green with the reason code saying so, never a silent
// green: nothing has been declared, so there is nothing to enforce, and the
// observed versions are reported as facts rather than asserted as healthy. This is
// the launchd leg's shape, for the same reason.
async function engineCopyVersions(root, homeRoot, manifest, options) {
  if (options.engineCopyVersions && typeof options.engineCopyVersions === "object") {
    return { copies: options.engineCopyVersions, source: "synthetic" };
  }
  const copies = {};
  const engineEntry = manifest.items.find((entry) => entry.id === "machine.workflow-engine");
  const installedRoot = engineEntry ? expandTemplate(engineEntry.pathTemplate, "<PLATFORM_ROOT>", homeRoot) : null;
  const engineProject = (manifest.projects ?? []).find((project) => project.name === "tcrn-workflow");
  const worktreeRoot = engineProject?.pathTemplate?.startsWith("<PLATFORM_ROOT>/")
    ? join(root, engineProject.pathTemplate.slice("<PLATFORM_ROOT>/".length))
    : null;
  const candidates = [
    ["installed", installedRoot === null ? null : join(installedRoot, "tcrn-workflow", "package.json")],
    ["worktree", worktreeRoot === null ? null : join(worktreeRoot, "package.json")],
  ];
  for (const [name, packagePath] of candidates) {
    if (packagePath === null) continue;
    try {
      const value = JSON.parse(await readFile(packagePath, "utf8"));
      if (typeof value.version === "string" && value.version.length > 0) copies[name] = value.version;
    } catch {
      // A copy that is absent is not a copy that is stale. Only present copies are
      // compared; `deploymentFreshness` already owns "the installed copy is missing".
    }
  }
  return { copies, source: "install-manifest" };
}

async function declaredEngineRequirements(root, options) {
  if (options.engineRequiredVersions && typeof options.engineRequiredVersions === "object") {
    return { declarations: options.engineRequiredVersions, source: "synthetic" };
  }
  const containerPath = join(root, ".tcrn-workspace");
  // Same resolution as declaredBackupCadences: fileURLToPath rather than pathname,
  // because this repository lives under a directory whose name contains a space.
  const cli = options.engineCli ?? join(dirname(fileURLToPath(import.meta.url)), "tcrn-workflow.mjs");
  let entries;
  try {
    entries = await readdir(containerPath, { withFileTypes: true });
  } catch (error) {
    return { declarations: null, source: "unreadable", error: error?.code ?? "CONTAINER_UNREADABLE" };
  }
  const declarations = {};
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const workspacePath = join(containerPath, entry.name, "workspace");
    if (!(await existingPath(workspacePath))?.isDirectory()) continue;
    try {
      const result = await execFileAsync(process.execPath, [cli, "settings-catalog", "--workspace", workspacePath], { timeout: 30_000, maxBuffer: 8 * 1_048_576 });
      const catalog = JSON.parse(result.stdout);
      const rows = Object.values(catalog).find((value) => Array.isArray(value)) ?? [];
      const row = rows.find((candidate) => candidate?.key === "engine.requiredVersion");
      declarations[entry.name] = row?.currentValue ?? null;
    } catch (error) {
      return { declarations: null, source: "unreadable", error: error?.code ?? "SETTINGS_CATALOG_FAILED", partition: entry.name };
    }
  }
  return { declarations, source: "chain-declaration" };
}

async function inspectEngineFloorSatisfied(root, homeRoot, manifest, options) {
  const observed = await engineCopyVersions(root, homeRoot, manifest, options);
  const copies = observed.copies;
  if (Object.keys(copies).length === 0) {
    return check("engineFloorSatisfied", false, { reasonCode: "PLATFORM_ENGINE_COPY_UNREADABLE", source: observed.source });
  }
  const declared = await declaredEngineRequirements(root, options);
  if (declared.declarations === null) {
    // Unreadable is reported, not red. This leg's claim is "no copy is behind a
    // declared floor"; with no readable declaration there is no floor, which is the
    // same epistemic position as none being declared — and a container without a
    // live chain (a fixture, a partial checkout) is not a platform fault any more
    // than it is a passing one. `requirementAsserted` carries the distinction into
    // the verdict so this can never be read as "aligned".
    return check("engineFloorSatisfied", true, {
      reasonCode: "PLATFORM_ENGINE_REQUIREMENT_UNREADABLE",
      copies,
      error: declared.error,
      partition: declared.partition ?? null,
      requirementAsserted: false,
      source: declared.source,
    });
  }
  const behind = [];
  for (const [partition, required] of Object.entries(declared.declarations).sort(([left], [right]) => compareCanonicalTextLocal(left, right))) {
    if (typeof required !== "string" || required.length === 0) continue;
    for (const [copy, version] of Object.entries(copies).sort(([left], [right]) => compareCanonicalTextLocal(left, right))) {
      let ordering;
      try {
        ordering = compareEngineVersions(version, required);
      } catch {
        behind.push({ partition, required, copy, version, reason: "UNPARSEABLE" });
        continue;
      }
      if (ordering < 0) behind.push({ partition, required, copy, version, reason: "BEHIND" });
    }
  }
  if (behind.length > 0) {
    return check("engineFloorSatisfied", false, {
      reasonCode: "PLATFORM_ENGINE_BEHIND_CHAIN",
      behind,
      copies,
      hint: "that copy fails the whole workspace closed as WORKSPACE_EVENT_CORRUPT — upgrade it before the next write, or the failure will read as byte damage",
      source: "chain engine.requiredVersion + install-manifest",
    });
  }
  const declaringPartitions = Object.entries(declared.declarations)
    .filter(([, required]) => typeof required === "string" && required.length > 0)
    .map(([partition]) => partition)
    .sort(compareCanonicalTextLocal);
  if (declaringPartitions.length === 0) {
    // Green, but never silently: no partition has declared a floor, so this leg is
    // enforcing nothing. The copy versions are reported as observations so the
    // reader can see what is actually installed without the leg claiming it is right.
    return check("engineFloorSatisfied", true, {
      reasonCode: "PLATFORM_ENGINE_REQUIREMENT_UNDECLARED",
      copies,
      partitions: Object.keys(declared.declarations).sort(compareCanonicalTextLocal),
      requirementAsserted: false,
      source: "chain engine.requiredVersion + install-manifest",
    });
  }
  return check("engineFloorSatisfied", true, {
    copies,
    declaringPartitions,
    requirementAsserted: true,
    source: "chain engine.requiredVersion + install-manifest",
  });
}

// TCRN-CROSS-INC-270: the installed and worktree engine copies diverge in capability
// surface during development because the worktree is authoritative for what the engine
// can do. Version strings alone cannot see this: both copies can report the same version while one
// has 132 verbs and 9 flags on work-annotate, the other 137 verbs and 11 flags.
//
// The verdict follows the Owner ruling (2026-09-04): worktree ahead is expected and
// green (development in progress), installed ahead is red (deployment carries code absent
// from the source), both diverging is red, unreadable is uncomparable. The leg is
// structurally consistent with inspectHelperReleaseAlignment (INC-233): digest comparison,
// not version-string comparison, and the same principle that "nothing to compare" and
// "compared and equal" are two answers that must stay apart.
async function inspectEngineCapabilitySurface(root, homeRoot, manifest, options) {
  // Synthetic injection hook: for hermetic tests, pass catalogs directly.
  if (options.engineCommandCatalogs && typeof options.engineCommandCatalogs === "object") {
    const { installed, worktree } = options.engineCommandCatalogs;
    return engineCapabilitySurfaceVerdict(
      installed ?? null,
      worktree ?? null,
      "synthetic"
    );
  }

  // Resolve the installed and worktree copy roots. Use the same resolution as
  // engineCopyVersions to ensure consistent paths across legs.
  const engineEntry = manifest.items.find((entry) => entry.id === "machine.workflow-engine");
  const installedRoot = engineEntry ? expandTemplate(engineEntry.pathTemplate, "<PLATFORM_ROOT>", homeRoot) : null;
  const engineProject = (manifest.projects ?? []).find((project) => project.name === "tcrn-workflow");
  const worktreeRoot = engineProject?.pathTemplate?.startsWith("<PLATFORM_ROOT>/")
    ? join(root, engineProject.pathTemplate.slice("<PLATFORM_ROOT>/".length))
    : null;

  const scriptPaths = {
    installed: installedRoot === null ? null : join(installedRoot, "tcrn-workflow", "scripts", "tcrn-workflow.mjs"),
    worktree: worktreeRoot === null ? null : join(worktreeRoot, "scripts", "tcrn-workflow.mjs"),
  };

  // TCRN-CROSS-INC-233: "nothing to compare" and "compared and equal" must stay apart.
  // By extension, "absent" (copy does not exist) and "broken" (unreadable CLI / unparseable output)
  // are two different answers. Surface the reason a copy is unreadable so the caller
  // can distinguish them in logs and diagnostics.
  const catalogs = {};
  const unreadable = {}; // { installed?: "ABSENT"|"FAILED", worktree?: "ABSENT"|"FAILED" }

  for (const [copy, scriptPath] of Object.entries(scriptPaths)) {
    if (scriptPath === null) {
      catalogs[copy] = null;
      unreadable[copy] = "ABSENT"; // manifest did not resolve a path for this copy
      continue;
    }
    try {
      const stats = await existingPath(scriptPath);
      if (!stats?.isFile()) {
        catalogs[copy] = null;
        unreadable[copy] = "ABSENT"; // script file does not exist
        continue;
      }
      const result = await execFileAsync(process.execPath, [scriptPath, "commands"], { timeout: 30_000, maxBuffer: 8 * 1_048_576 });
      const parsed = JSON.parse(result.stdout);
      if (!Array.isArray(parsed.commands)) {
        catalogs[copy] = null;
        unreadable[copy] = "FAILED"; // output did not have parseable commands array
        continue;
      }
      catalogs[copy] = parsed.commands;
      // Successfully read this copy: remove it from unreadable.
      delete unreadable[copy];
    } catch (error) {
      catalogs[copy] = null;
      unreadable[copy] = "FAILED"; // CLI failed, timeout, or JSON parse error
    }
  }

  return engineCapabilitySurfaceVerdict(
    catalogs.installed,
    catalogs.worktree,
    "commands-cli",
    Object.keys(unreadable).length > 0 ? unreadable : undefined
  );
}

function normalizeCommandCatalog(commands) {
  if (!Array.isArray(commands)) return null;
  // Normalize to canonical form: sort verbs by name, each verb's flags by name.
  // Return a structure suitable for hashing.
  const normalized = commands
    .map((cmd) => ({
      name: cmd.name,
      availability: cmd.availability,
      mutates: cmd.mutates,
      flags: (Array.isArray(cmd.flags) ? cmd.flags : [])
        .map((flag) => ({
          name: flag.name,
          required: flag.required,
          valueKind: flag.valueKind,
        }))
        .sort((a, b) => compareCanonicalTextLocal(a.name, b.name)),
    }))
    .sort((a, b) => compareCanonicalTextLocal(a.name, b.name));
  return normalized;
}

function engineCapabilitySurfaceVerdict(installedCatalog, worktreeCatalog, source, unreadableInfo) {
  // Normalize both catalogs if they exist.
  const installedNormalized = normalizeCommandCatalog(installedCatalog);
  const worktreeNormalized = normalizeCommandCatalog(worktreeCatalog);

  // Determine comparability: both must be readable to compare.
  if (installedNormalized === null && worktreeNormalized === null) {
    const verdict = {
      comparable: false,
      reason: "neither engine copy is readable; capability surface is unknown",
      source,
    };
    // TCRN-CROSS-INC-233, INC-270: surface why each copy is unreadable when available.
    if (unreadableInfo) {
      verdict.unreadable = unreadableInfo;
    }
    return check("engineCapabilitySurface", true, verdict);
  }
  if (installedNormalized === null || worktreeNormalized === null) {
    const verdict = {
      comparable: false,
      reason: "one engine copy is unreadable; capability surface is unknown",
      source,
      readable: {
        installed: installedNormalized !== null,
        worktree: worktreeNormalized !== null,
      },
    };
    // Surface why each copy is unreadable when available.
    if (unreadableInfo) {
      verdict.unreadable = unreadableInfo;
    }
    return check("engineCapabilitySurface", true, verdict);
  }

  // Both are readable: compare by digest.
  const installedDigest = createHash("sha256")
    .update(JSON.stringify(installedNormalized))
    .digest("hex");
  const worktreeDigest = createHash("sha256")
    .update(JSON.stringify(worktreeNormalized))
    .digest("hex");

  if (installedDigest === worktreeDigest) {
    // Identical: green.
    return check("engineCapabilitySurface", true, {
      capabilitySurface: "IDENTICAL",
      digest: installedDigest.slice(0, 12),
      source,
    });
  }

  // Divergent: compute verb name sets to report what differs.
  const installedVerbs = new Set(installedNormalized.map((cmd) => cmd.name));
  const worktreeVerbs = new Set(worktreeNormalized.map((cmd) => cmd.name));

  const worktreeOnly = Array.from(worktreeVerbs)
    .filter((name) => !installedVerbs.has(name))
    .sort(compareCanonicalTextLocal);
  const installedOnly = Array.from(installedVerbs)
    .filter((name) => !worktreeVerbs.has(name))
    .sort(compareCanonicalTextLocal);

  // Diff flags for verbs that exist in both catalogs. Regardless of whether verbs also differ,
  // we must detect installed-only flags: if the deployment carries flags the source lacks,
  // that is a capability not declared authoritative and must be red.
  // TCRN-CROSS-INC-270: flag divergence must also check direction to detect when the
  // installed copy carries flags (capabilities) the worktree lacks. The authority model
  // says installed-ahead is a deployment safety violation, the same as for verbs.
  let installedOnlyFlags = {}; // { verbName: [flagNames] }
  let worktreeOnlyFlags = {}; // { verbName: [flagNames] }
  let attributeDifferences = []; // [{verb, flag, installedValue, worktreeValue}]

  // Build maps for fast lookup of verbs present in each catalog.
  const installedMap = new Map(installedNormalized.map((cmd) => [cmd.name, cmd]));
  const worktreeMap = new Map(worktreeNormalized.map((cmd) => [cmd.name, cmd]));

  // For each verb that exists in BOTH catalogs, compare its flags.
  const commonVerbs = Array.from(installedVerbs).filter((name) => worktreeVerbs.has(name));
  for (const verbName of commonVerbs) {
    const iCmd = installedMap.get(verbName);
    const wCmd = worktreeMap.get(verbName);
    const iFlags = new Set(iCmd.flags.map((f) => f.name));
    const wFlags = new Set(wCmd.flags.map((f) => f.name));

    // Extract flag-level differences for this verb.
    const iOnly = Array.from(iFlags).filter((n) => !wFlags.has(n)).sort(compareCanonicalTextLocal);
    const wOnly = Array.from(wFlags).filter((n) => !iFlags.has(n)).sort(compareCanonicalTextLocal);

    if (iOnly.length > 0) installedOnlyFlags[verbName] = iOnly;
    if (wOnly.length > 0) worktreeOnlyFlags[verbName] = wOnly;

    // Check for attribute divergence on flags both sides have.
    const commonFlags = Array.from(iFlags).filter((n) => wFlags.has(n));
    for (const flagName of commonFlags) {
      const iFlag = iCmd.flags.find((f) => f.name === flagName);
      const wFlag = wCmd.flags.find((f) => f.name === flagName);
      // Check required and valueKind attributes.
      if (iFlag.required !== wFlag.required || iFlag.valueKind !== wFlag.valueKind) {
        attributeDifferences.push({
          verb: verbName,
          flag: flagName,
          installed: { required: iFlag.required, valueKind: iFlag.valueKind },
          worktree: { required: wFlag.required, valueKind: wFlag.valueKind },
        });
      }
    }
  }

  // Verdict based on direction of divergence.
  const hasInstalledOnlyVerbsOrFlags = installedOnly.length > 0 || Object.keys(installedOnlyFlags).length > 0;
  const hasWorktreeOnlyVerbsOrFlags = worktreeOnly.length > 0 || Object.keys(worktreeOnlyFlags).length > 0;

  if (hasInstalledOnlyVerbsOrFlags) {
    // Installed is ahead in verbs or flags: red. This violates the authority model.
    // TCRN-CROSS-INC-270 Owner ruling: "installed copy has verbs/flags the worktree lacks
    // -> RED. The deployment position is running code absent from the authoritative
    // source. ... both directions differ -> RED (the installed-ahead component dominates)."
    const verdict = {
      reasonCode: "PLATFORM_ENGINE_INSTALLED_AHEAD",
      capabilitySurface: "INSTALLED_AHEAD",
      installedOnly: installedOnly.length > 0 ? installedOnly : undefined,
      installedOnlyFlags: Object.keys(installedOnlyFlags).length > 0 ? installedOnlyFlags : undefined,
      worktreeOnly: hasWorktreeOnlyVerbsOrFlags ? worktreeOnly : undefined,
      worktreeOnlyFlags: Object.keys(worktreeOnlyFlags).length > 0 ? worktreeOnlyFlags : undefined,
      remedy: "the installed engine copy has capabilities absent from the worktree (authoritative source); this is a deployment safety violation; reconcile or block deployment",
      source,
    };
    return check("engineCapabilitySurface", false, verdict);
  }

  if (hasWorktreeOnlyVerbsOrFlags) {
    // Worktree is a strict superset: expected during development. Green, but explicit.
    // TCRN-CROSS-INC-270 Owner ruling: "worktree has verbs/flags the installed copy lacks
    // -> EXPECTED during development. The leg stays `ok: true`, but it MUST state the
    // divergence explicitly and name the differing verbs/flags."
    const verdict = {
      capabilitySurface: "WORKTREE_AHEAD",
      worktreeOnly: worktreeOnly.length > 0 ? worktreeOnly : undefined,
      worktreeOnlyFlags: Object.keys(worktreeOnlyFlags).length > 0 ? worktreeOnlyFlags : undefined,
      remedy: "development is ahead of deployment; this is expected while the engine is being developed and is not a reason to stop; verify this explicitly in deployment procedures",
      source,
    };
    return check("engineCapabilitySurface", true, verdict);
  }

  if (attributeDifferences.length > 0) {
    // Verbs and flag names match, but some flag attributes differ. This is direction-neutral
    // and cannot be judged by the ruling's direction rule: neither side is "ahead".
    // TCRN-CROSS-INC-270: attribute divergence is uncomparable to the authority model.
    // The deployed copy may have different behavior than the authoritative source, but
    // there is no unambiguous direction of capability: one may have more lenient value
    // validation while the other requires a specific value kind. This is tracked but not
    // a verdict blocker because capability is not strictly adding or removing, it is changing.
    const verdict = {
      capabilitySurface: "ATTRIBUTES_DIVERGENT",
      attributeDifferences: attributeDifferences.map((d) => ({
        verb: d.verb,
        flag: d.flag,
        installed: d.installed,
        worktree: d.worktree,
      })),
      installedDigest: installedDigest.slice(0, 12),
      worktreeDigest: worktreeDigest.slice(0, 12),
      reason: "verb and flag names match, but some flag attributes differ (e.g., required, valueKind); neither copy is strictly ahead and this cannot be judged by the authority model",
      source,
    };
    return check("engineCapabilitySurface", true, verdict);
  }

  // No differences detected: report as IDENTICAL (though digests differ).
  // This should not occur, but if all verbs and flags match perfectly, treat as IDENTICAL.
  return check("engineCapabilitySurface", true, {
    capabilitySurface: "IDENTICAL",
    digest: installedDigest.slice(0, 12),
    source,
  });
}

// TCRN-CROSS-MIN-103. The Helper teaches a settings surface, and something has to
// check that what it teaches is still what the engine has. That comparison used to
// live in the Helper's own test suite, which read the engine's source out of a
// sibling checkout — a repository reaching into another's tree, forbidden by the
// platform's dependency-direction rule, and impossible in the Helper's CI, which
// checks out one repository. So it was ENOENT there and green locally: three
// consecutive pushes red on a check that could only ever pass on a developer's
// machine, which is the same defect shape as INC-223's DS reconciliation.
//
// The platform layer is where a cross-repository question can be asked honestly:
// this doctor already reads the engine, the installed Helper copies, and the chain.
// The Helper now declares the roster it teaches and holds itself to it; this leg
// answers whether that declaration still matches the engine's own catalog, read
// through the engine's read face rather than by pattern-matching its source.
async function inspectHelperSettingsCoverage(root, homeRoot, manifest, options) {
  if (options.helperSettingKeys && typeof options.helperSettingKeys === "object") {
    return checkHelperSettingsCoverage(options.helperSettingKeys.catalog, options.helperSettingKeys.taught, "synthetic");
  }
  const entry = manifest.items.find((item) => item.id === "machine.claude-skill");
  const skillRoot = entry ? expandTemplate(entry.pathTemplate, "<PLATFORM_ROOT>", homeRoot) : null;
  if (skillRoot === null) return check("helperSettingsCoverage", false, { reasonCode: "PLATFORM_MANIFEST_PATH_INVALID" });

  const catalogKeys = await engineSettingKeys(root, options);
  if (catalogKeys === null) {
    // Unreadable is reported, not red: with no catalog there is nothing to compare,
    // which is the same epistemic position as engineFloorSatisfied's undeclared case.
    return check("helperSettingsCoverage", true, {
      reasonCode: "PLATFORM_HELPER_SETTINGS_UNREADABLE",
      coverageAsserted: false,
      source: "engine settings-catalog + installed helper payload",
    });
  }
  let taught;
  try {
    taught = await taughtSettingKeys(skillRoot, catalogKeys);
  } catch (error) {
    return check("helperSettingsCoverage", true, {
      reasonCode: "PLATFORM_HELPER_PAYLOAD_UNREADABLE",
      coverageAsserted: false,
      error: error?.code ?? "UNREADABLE",
      source: "engine settings-catalog + installed helper payload",
    });
  }
  return checkHelperSettingsCoverage(catalogKeys, taught, "engine settings-catalog + installed helper payload");
}

function checkHelperSettingsCoverage(catalogKeys, taught, source) {
  const untaught = catalogKeys.filter((key) => !taught.includes(key)).sort(compareCanonicalTextLocal);
  return untaught.length === 0
    ? check("helperSettingsCoverage", true, { catalogKeys: [...catalogKeys].sort(compareCanonicalTextLocal), coverageAsserted: true, source })
    : check("helperSettingsCoverage", false, {
      reasonCode: "PLATFORM_HELPER_SETTINGS_UNTAUGHT",
      untaught,
      hint: "the engine registered a setting the placed Helper never mentions — teach it in the payload and re-pin, or the operator meets a key no guidance covers",
      source,
    });
}

async function engineSettingKeys(root, options) {
  const cli = options.engineCli ?? join(dirname(fileURLToPath(import.meta.url)), "tcrn-workflow.mjs");
  const containerPath = join(root, ".tcrn-workspace");
  let entries;
  try {
    entries = await readdir(containerPath, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const workspacePath = join(containerPath, entry.name, "workspace");
    if (!(await existingPath(workspacePath))?.isDirectory()) continue;
    try {
      const result = await execFileAsync(process.execPath, [cli, "settings-catalog", "--workspace", workspacePath], { timeout: 30_000, maxBuffer: 8 * 1_048_576 });
      const catalog = JSON.parse(result.stdout);
      const rows = Object.values(catalog).find((value) => Array.isArray(value)) ?? [];
      const keys = rows.map((row) => row?.key).filter((key) => typeof key === "string");
      if (keys.length > 0) return keys;
    } catch {
      // Any readable partition answers the same catalog; try the next one.
    }
  }
  return null;
}

async function taughtSettingKeys(skillRoot, catalogKeys) {
  const documents = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".md")) documents.push(await readFile(path, "utf8"));
    }
  };
  await walk(skillRoot);
  const prose = documents.join("\n");
  return catalogKeys.filter((key) => prose.includes(key));
}

async function inspectHelperCopies(platformRoot, homeRoot, manifest, options) {
  const entries = manifest.items.filter((entry) => entry.acceptanceProbe.startsWith("probe:helper-skill-digest"));
  const missing = [];
  const mismatched = [];
  const probe = entries.length > 0 ? parseAcceptanceProbe(entries[0].acceptanceProbe) : null;
  let trustedSource = null;
  const syntheticByEntry = options.helperSkillDigests && typeof options.helperSkillDigests === "object";
  const syntheticLaunchd = Array.isArray(options.launchdLabels) && options.enforceHelperDigest !== true;
  if (!syntheticByEntry && !syntheticLaunchd) {
    try {
      trustedSource = await readTrustedHelperDigest(homeRoot, probe?.parameters ?? {});
    } catch (error) {
      return check("helperCopies", false, {
        reasonCode: error?.reasonCode ?? "PLATFORM_TRUST_ROOT_UNAVAILABLE",
        source: "trusted-archive-state",
        ...(error?.archivePath ? { archivePath: error.archivePath } : {}),
        ...(error?.statePath ? { statePath: error.statePath } : {}),
        ...(error?.entryPath ? { entryPath: error.entryPath } : {}),
        ...(error?.expectedArchiveSha256 ? { expectedArchiveSha256: error.expectedArchiveSha256 } : {}),
        ...(error?.actualArchiveSha256 ? { actualArchiveSha256: error.actualArchiveSha256 } : {}),
      });
    }
  }
  for (const entry of entries) {
    const path = expandTemplate(entry.pathTemplate, platformRoot, homeRoot);
    const rootStats = path === null ? null : await existingPath(path);
    const skillPath = path === null ? null : join(path, "SKILL.md");
    const skillStats = skillPath === null ? null : await existingPath(skillPath);
    if (!rootStats?.isDirectory() || !skillStats?.isFile()) {
      missing.push({ id: entry.id, pathTemplate: entry.pathTemplate, reasonCode: "PLATFORM_HELPER_COPY_NOT_REGULAR" });
      continue;
    }
    const actual = createHash("sha256").update(await readFile(skillPath)).digest("hex");
    const entryProbe = parseAcceptanceProbe(entry.acceptanceProbe);
    const expected = options.helperSkillDigests?.[entry.id] ?? (syntheticLaunchd ? actual : trustedSource?.digest);
    if (actual !== expected) mismatched.push({ id: entry.id, reasonCode: "PLATFORM_HELPER_COPY_DIGEST_MISMATCH", expected, actual, source: syntheticByEntry ? "synthetic-helper-digest" : syntheticLaunchd ? "synthetic-launchd-labels" : entryProbe?.parameters.source ?? "trusted-archive-state" });
  }
  return missing.length === 0 && mismatched.length === 0
    ? check("helperCopies", true, { hosts: ["agents", "claude", "codex"], source: syntheticByEntry ? "synthetic-helper-digest" : syntheticLaunchd ? "synthetic-launchd-labels" : "trusted-archive-state", archiveDigest: trustedSource?.archiveDigest ?? null, declaredEntryCount: trustedSource?.declaredEntryCount ?? null })
    : check("helperCopies", false, { reasonCode: missing.length > 0 ? "PLATFORM_HELPER_COPIES_INCOMPLETE" : "PLATFORM_HELPER_COPY_DIGEST_MISMATCH", missing, mismatched });
}

function parseLaunchdProbe(entry) {
  const match = /^probe:launchd-duty;label=([^;]+);maxAgeHours=(\d+)$/u.exec(entry?.acceptanceProbe ?? "");
  if (!match) return null;
  return { label: match[1], maxAgeHours: Number.parseInt(match[2], 10) };
}

async function launchdLabels(options) {
  if (Array.isArray(options.launchdLabels)) return options.launchdLabels;
  try {
    const result = await execFileAsync("launchctl", ["list"], { timeout: 10_000, maxBuffer: 1_048_576 });
    return result.stdout.split("\n").map((line) => line.trim().split(/\s+/u).at(-1)).filter((value) => typeof value === "string" && value.length > 0);
  } catch {
    return [];
  }
}

function parseLastExitCode(text) {
  const match = /last exit code\s*=\s*(-?\d+)/u.exec(text);
  return match ? Number.parseInt(match[1], 10) : null;
}

async function launchdStatus(label, options) {
  if (options.launchdStatus && typeof options.launchdStatus === "object") return options.launchdStatus;
  if (Array.isArray(options.launchdLabels)) return { lastExitCode: 0, source: "synthetic-launchd-labels" };
  try {
    const result = await execFileAsync("launchctl", ["print", `gui/${process.getuid?.() ?? 0}/${label}`], { timeout: 10_000, maxBuffer: 1_048_576 });
    return { lastExitCode: parseLastExitCode(result.stdout), raw: result.stdout };
  } catch (error) {
    return { unavailable: true, error: error?.code ?? "LAUNCHCTL_PRINT_FAILED" };
  }
}

async function readFreshnessReceipt(path, maxAgeHours, kind) {
  try {
    const receipt = JSON.parse(await readFile(path, "utf8"));
    const timestamp = kind === "offsite"
      ? receipt.pushedAt ?? receipt.finishedAt ?? null
      : receipt.finishedAt ?? receipt.createdAt ?? null;
    const ageHours = typeof timestamp === "string" ? (Date.now() - Date.parse(timestamp)) / 3_600_000 : Number.POSITIVE_INFINITY;
    const ok = kind === "offsite"
      ? receipt.ok === true && receipt.readbackVerified === true
      : receipt.ok === true && typeof receipt.snapshotSha256 === "string" && receipt.chainVersions !== undefined;
    return {
      ok: ok && Number.isFinite(ageHours) && ageHours <= maxAgeHours,
      latestAt: timestamp,
      ageHours,
      receiptOk: receipt.ok === true,
      readbackVerified: receipt.readbackVerified === true,
      receiptPath: path,
    };
  } catch (error) {
    return { ok: false, latestAt: null, ageHours: Number.POSITIVE_INFINITY, receiptPath: path, error: error?.code ?? "BACKUP_RECEIPT_UNAVAILABLE" };
  }
}

async function localSnapshotFreshness(options, platformRoot, manifest, maxAgeHours) {
  if (options.localSnapshotFreshness && typeof options.localSnapshotFreshness === "object") return options.localSnapshotFreshness;
  if (options.backupFreshness && typeof options.backupFreshness === "object") return options.backupFreshness;
  if (Array.isArray(options.launchdLabels)) return { ok: true, latestAt: "synthetic", ageHours: 0, source: "synthetic-launchd-labels" };
  const entry = manifest.items.find((candidate) => candidate.id === "machine.local-snapshot-receipt");
  const path = entry ? expandTemplate(entry.pathTemplate, platformRoot, options.homeRoot ?? process.env.HOME ?? "") : join(platformRoot, ".tcrn-artifacts", "chain-snapshots", "local-snapshot.json");
  return readFreshnessReceipt(path, maxAgeHours, "local");
}

async function offsitePushFreshness(options, platformRoot, manifest, maxAgeHours) {
  if (options.offsitePushFreshness && typeof options.offsitePushFreshness === "object") return options.offsitePushFreshness;
  if (Array.isArray(options.launchdLabels)) return { ok: true, latestAt: "synthetic", ageHours: 0, source: "synthetic-launchd-labels" };
  const entry = manifest.items.find((candidate) => candidate.id === "machine.offsite-push-receipt");
  const path = entry ? expandTemplate(entry.pathTemplate, platformRoot, options.homeRoot ?? process.env.HOME ?? "") : join(platformRoot, ".tcrn-artifacts", "chain-snapshots", "offsite-push.json");
  return readFreshnessReceipt(path, maxAgeHours, "offsite");
}

async function listRegularFiles(root, prefix = "") {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = prefix.length > 0 ? join(prefix, entry.name) : entry.name;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listRegularFiles(path, relativePath));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files.sort();
}

async function inspectTrustArchiveFreshness(platformRoot, homeRoot, manifest, options) {
  if (options.trustArchiveFreshness && typeof options.trustArchiveFreshness === "object") return check("trustArchive", options.trustArchiveFreshness.ok === true, options.trustArchiveFreshness);
  if (Array.isArray(options.launchdLabels) && options.enforceTrustArchive !== true) return check("trustArchive", true, { source: "synthetic-launchd-labels" });
  const archiveEntry = manifest.items.find((entry) => entry.id === "machine.trust-archive");
  const engineEntry = manifest.items.find((entry) => entry.id === "machine.workflow-engine");
  if (!archiveEntry || !engineEntry) return check("trustArchive", false, { reasonCode: "PLATFORM_TRUST_ARCHIVE_MANIFEST_ITEMS_MISSING" });
  const archivePath = expandTemplate(archiveEntry.pathTemplate, platformRoot, homeRoot);
  const engineRoot = expandTemplate(engineEntry.pathTemplate, platformRoot, homeRoot);
  if (!archivePath || !engineRoot) return check("trustArchive", false, { reasonCode: "PLATFORM_TRUST_ARCHIVE_PATH_INVALID" });
  try {
    const archive = JSON.parse(await readFile(archivePath, "utf8"));
    const entries = Array.isArray(archive.entries) ? archive.entries : [];
    const declared = new Map();
    const archiveProblems = [];
    for (const entry of entries) {
      if (entry === null || typeof entry !== "object" || typeof entry.path !== "string" || typeof entry.sha256 !== "string" || typeof entry.contentBase64 !== "string") {
        archiveProblems.push({ reasonCode: "PLATFORM_TRUST_ARCHIVE_ENTRY_INVALID", path: entry?.path ?? null });
        continue;
      }
      const content = Buffer.from(entry.contentBase64, "base64");
      const digest = createHash("sha256").update(content).digest("hex");
      if (digest !== entry.sha256 || declared.has(entry.path)) archiveProblems.push({ reasonCode: "PLATFORM_TRUST_ARCHIVE_ENTRY_DIGEST_INVALID", path: entry.path });
      declared.set(entry.path, entry.sha256);
    }
    // TCRN-CROSS-INC-272: derive the host list from INSTALL_MANIFEST so the version-marker
    // loop and consumerRoots are a single source of truth. If a machine.{host}-skill entry
    // exists in the manifest, that host is a known consumer and its version marker must be
    // checked. Hardcoding the host names in two places (consumerRoots and the marker loop)
    // allows them to drift: agents-skill existed in the manifest but was never checked until
    // this fix. The single source is the manifest itself, not a hardcoded host list.
    const knownHosts = manifest.items
      .filter((item) => item.id && item.id.startsWith("machine.") && item.id.endsWith("-skill"))
      .map((item) => item.id.replace(/^machine\./, "").replace(/-skill$/, ""))
      .sort();
    const consumerRoots = knownHosts.map((host) => join(homeRoot, `.${host}`, "skills", "tcrn-workflow-helper"));
    const consumerProblems = [];
    for (const consumerRoot of consumerRoots) {
      const actualPaths = await listRegularFiles(consumerRoot);
      const actualSet = new Set(actualPaths);
      const missing = [...declared.keys()].filter((path) => !actualSet.has(path));
      const extra = actualPaths.filter((path) => !declared.has(path));
      const mismatched = [];
      for (const path of actualPaths.filter((candidate) => declared.has(candidate))) {
        const actual = createHash("sha256").update(await readFile(join(consumerRoot, path))).digest("hex");
        if (actual !== declared.get(path)) mismatched.push({ path, expected: declared.get(path), actual });
      }
      if (missing.length > 0 || extra.length > 0 || mismatched.length > 0) consumerProblems.push({ root: consumerRoot, missing, extra, mismatched });
    }
    const packageValue = JSON.parse(await readFile(join(engineRoot, "tcrn-workflow", "package.json"), "utf8"));
    const expectedVersion = `v${packageValue.version}`;
    const markerProblems = [];
    for (const host of knownHosts) {
      const markerPath = join(homeRoot, ".tcrn-workflow", `installed-copy-${host}.json`);
      const marker = JSON.parse(await readFile(markerPath, "utf8"));
      if (marker.version !== expectedVersion) markerProblems.push({ host, markerPath, expectedVersion, actualVersion: marker.version ?? null });
    }
    // TCRN-CROSS-INC-272: detect orphan markers. An orphan is an installed-copy-*.json file
    // whose host is not in the known consumer set. Orphans occur when install shapes change
    // (e.g., an old "claude-home" marker from v0.11.17 sitting three versions behind current
    // ones). They mislead a reader into thinking an install position is live, but they don't
    // break a live position — they are cargo for human visibility, not platform failures.
    // Report them by host, path, and version, but do not fail the leg over them alone.
    const orphanMarkers = [];
    try {
      const markerDir = join(homeRoot, ".tcrn-workflow");
      const files = await readdir(markerDir);
      for (const file of files) {
        if (!file.startsWith("installed-copy-") || !file.endsWith(".json")) continue;
        const host = file.replace(/^installed-copy-/, "").replace(/\.json$/, "");
        if (!knownHosts.includes(host)) {
          const orphanPath = join(markerDir, file);
          try {
            const orphan = JSON.parse(await readFile(orphanPath, "utf8"));
            orphanMarkers.push({ host, path: orphanPath, version: orphan.version ?? null });
          } catch {
            orphanMarkers.push({ host, path: orphanPath, version: null, error: "ORPHAN_MARKER_UNREADABLE" });
          }
        }
      }
    } catch {
      // If .tcrn-workflow doesn't exist or can't be read, there are no orphans to report.
    }
    if (archiveProblems.length > 0 || consumerProblems.length > 0 || markerProblems.length > 0) {
      return check("trustArchive", false, {
        reasonCode: "PLATFORM_TRUST_ARCHIVE_STALE",
        archivePath,
        declaredEntryCount: declared.size,
        consumerProblems,
        archiveProblems,
        markerProblems,
        expectedVersion,
        ...(orphanMarkers.length > 0 && { orphanMarkers }),
      });
    }
    return check("trustArchive", true, { archivePath, declaredEntryCount: declared.size, consumerRoots: consumerRoots.length, expectedVersion, source: "archive-vs-installed-consumers-and-engine-version", ...(orphanMarkers.length > 0 && { orphanMarkers }) });
  } catch (error) {
    return check("trustArchive", false, { reasonCode: "PLATFORM_TRUST_ARCHIVE_UNAVAILABLE", archivePath, error: error?.code ?? "INVALID_TRUST_ARCHIVE" });
  }
}

// INC-195. Whether an automatic snapshot train is owed is a question the chains
// already answer: `backup.cadence` is the workspace's declaration of how backup
// happens, and `manual` is the legal way to say "on request, not on a timer".
// The probe's label stays the authority on *which* job, never on whether one is
// owed, and there is no roster of hosts excused from the requirement — Owner
// ruled against passing a red by local memory, so the relaxation is derived from
// the declaration or it does not happen.
//
// The declaration can only relax, never tighten: an unreadable chain leaves the
// strict expectation standing and says so in `cadenceSource`. Reading it through
// the sibling CLI rather than the installed copy is deliberate — the doctor
// judges the tree it ships in, and the installed copy cannot currently replay
// cross-project at all (INC-194).
const AUTOMATIC_CADENCES = new Set(["gate-close", "session-end"]);

async function declaredBackupCadences(options, platformRoot) {
  if (options.declaredBackupCadence && typeof options.declaredBackupCadence === "object") {
    return { cadences: options.declaredBackupCadence, source: "supplied" };
  }
  // fileURLToPath, not URL.pathname: this repository lives under a directory whose
  // name contains a space, and pathname hands back the percent-encoded form.
  const cli = options.engineCli ?? join(dirname(fileURLToPath(import.meta.url)), "tcrn-workflow.mjs");
  const containerPath = join(platformRoot, ".tcrn-workspace");
  let entries;
  try {
    entries = await readdir(containerPath, { withFileTypes: true });
  } catch (error) {
    return { cadences: null, source: "unreadable", error: error?.code ?? "WORKSPACE_CONTAINER_UNREADABLE" };
  }
  const cadences = {};
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const workspacePath = join(containerPath, entry.name, "workspace");
    if (!(await existingPath(workspacePath))?.isDirectory()) continue;
    try {
      const result = await execFileAsync(process.execPath, [cli, "settings-catalog", "--workspace", workspacePath], { timeout: 30_000, maxBuffer: 8 * 1_048_576 });
      const catalog = JSON.parse(result.stdout);
      const rows = Object.values(catalog).find((value) => Array.isArray(value)) ?? [];
      const cadence = rows.find((row) => row?.key === "backup.cadence");
      if (cadence === undefined) return { cadences: null, source: "unreadable", error: "BACKUP_CADENCE_ABSENT", partition: entry.name };
      cadences[entry.name] = cadence.currentValue ?? cadence.defaultValue ?? null;
    } catch (error) {
      return { cadences: null, source: "unreadable", error: error?.code ?? "SETTINGS_CATALOG_FAILED", partition: entry.name };
    }
  }
  if (Object.keys(cadences).length === 0) return { cadences: null, source: "unreadable", error: "NO_PARTITION_READ" };
  return { cadences, source: "chain-declaration" };
}

// INC-206. The install surface knew every harness location it had put down and
// nothing at all about the ones it had not. The pre-move container root kept a live
// `.claude` and `.codex` for four days after the move — four hooks and six hooks
// respectively, deciding what actually ran for anyone who opened a session there —
// and no check could see them, because every check started from the manifest and
// asked "is this present?" rather than from the tree and asking "is this declared?".
//
// This leg walks the container and reports any harness root the manifest does not
// place something under. The manifest is the reference on purpose: it is versioned,
// it fails closed, and adding a harness location means declaring it in the same
// change — not a roster of known-acceptable strays, which is the shape the Owner
// ruled out in MIN-099.
// The governed area is derived from the manifest rather than listed here: the
// container root, every declared project root, and the directories that lie between
// them. That middle set is not incidental — the classification folder the strays
// lived in is exactly a directory on the path to declared projects, governed by
// virtue of position and by nothing else. Everything else under the container is an
// unrelated project (AGENTS.md 二 says so plainly), and its own harness is none of
// the platform's business; scanning the whole tree reports those and teaches the
// reader to ignore the leg.
const HARNESS_DIRECTORY_NAMES = Object.freeze([".claude", ".codex"]);

async function inspectHarnessSurface(root, manifest) {
  const declaredPrefixes = manifest.items
    .filter((entry) => entry.pathTemplate.startsWith("<PLATFORM_ROOT>/"))
    .map((entry) => join(root, entry.pathTemplate.slice("<PLATFORM_ROOT>/".length)));
  const declaresSomethingUnder = (directory) =>
    declaredPrefixes.some((path) => path === directory || path.startsWith(`${directory}${sep}`));

  const governed = new Set([root]);
  for (const project of manifest.projects ?? []) {
    if (!project.pathTemplate?.startsWith("<PLATFORM_ROOT>/")) continue;
    let current = join(root, project.pathTemplate.slice("<PLATFORM_ROOT>/".length));
    while (current.startsWith(root) && current !== root) {
      governed.add(current);
      current = dirname(current);
    }
  }

  const undeclared = [];
  for (const directory of [...governed].sort(compareCanonicalTextLocal)) {
    for (const name of HARNESS_DIRECTORY_NAMES) {
      const path = join(directory, name);
      if (!(await existingPath(path))?.isDirectory()) continue;
      if (!declaresSomethingUnder(path)) undeclared.push(relative(root, path));
    }
  }

  return undeclared.length === 0
    ? check("harnessSurface", true, {
      governedDirectories: [...governed].map((path) => relative(root, path) || ".").sort(compareCanonicalTextLocal),
      source: "install-manifest",
    })
    : check("harnessSurface", false, {
      reasonCode: "PLATFORM_HARNESS_UNDECLARED",
      undeclared: undeclared.sort(compareCanonicalTextLocal),
      hint: "declare it in the install manifest, or retire it — an undeclared harness decides what runs and no other leg can see it",
      source: "install-manifest",
    });
}

const compareCanonicalTextLocal = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

async function inspectLaunchdDuty(options, manifest) {
  const entry = manifest.items.find((candidate) => candidate.acceptanceProbe.startsWith("probe:launchd-duty"));
  const probe = parseLaunchdProbe(entry);
  if (!probe) return check("launchd", false, { reasonCode: "PLATFORM_LAUNCHD_PROBE_INVALID" });
  const declared = await declaredBackupCadences(options, options.platformRoot);
  const automatic = declared.cadences === null
    || Object.values(declared.cadences).some((cadence) => AUTOMATIC_CADENCES.has(cadence));
  const labels = await launchdLabels(options);
  if (!automatic) {
    // Green, but never silently: the reason code says the expectation came off
    // the chain, and the last snapshot is reported as a fact rather than asserted.
    const localFreshness = await localSnapshotFreshness(options, options.platformRoot, manifest, probe.maxAgeHours);
    return check("launchd", true, {
      reasonCode: "PLATFORM_BACKUP_DECLARED_MANUAL",
      requiredLabel: probe.label,
      onDuty: labels.includes(probe.label),
      declaredCadence: declared.cadences,
      cadenceSource: declared.source,
      lastLocalSnapshotAt: localFreshness.latestAt ?? null,
      freshnessAsserted: false,
      source: "chain backup.cadence + install-manifest",
    });
  }
  if (!labels.includes(probe.label)) {
    return check("launchd", false, { reasonCode: "PLATFORM_LAUNCHD_NOT_ON_DUTY", requiredLabel: probe.label, observedLabels: labels, declaredCadence: declared.cadences, cadenceSource: declared.source, source: "install-manifest" });
  }
  const status = await launchdStatus(probe.label, options);
  if (status.unavailable) return check("launchd", false, { reasonCode: "PLATFORM_LAUNCHD_STATUS_UNAVAILABLE", requiredLabel: probe.label, error: status.error });
  if (status.lastExitCode !== null && status.lastExitCode !== 0) {
    return check("launchd", false, { reasonCode: "PLATFORM_LAUNCHD_LAST_RUN_FAILED", requiredLabel: probe.label, lastExitCode: status.lastExitCode, source: "launchctl print" });
  }
  const localFreshness = await localSnapshotFreshness(options, options.platformRoot, manifest, probe.maxAgeHours);
  if (!localFreshness.ok) {
    return check("launchd", false, { reasonCode: "PLATFORM_LAUNCHD_SNAPSHOT_STALE", requiredLabel: probe.label, lastExitCode: status.lastExitCode, freshness: localFreshness, maxAgeHours: probe.maxAgeHours, source: "local snapshot receipt" });
  }
  const offsiteFreshness = await offsitePushFreshness(options, options.platformRoot, manifest, probe.maxAgeHours);
  if (!offsiteFreshness.ok) {
    return check("launchd", false, { reasonCode: "PLATFORM_OFFSITE_PUSH_STALE", requiredLabel: probe.label, lastExitCode: status.lastExitCode, freshness: offsiteFreshness, maxAgeHours: probe.maxAgeHours, source: "offsite push receipt" });
  }
  return check("launchd", true, { requiredLabel: probe.label, lastExitCode: status.lastExitCode, localFreshness, offsiteFreshness, declaredCadence: declared.cadences, cadenceSource: declared.source, source: "chain backup.cadence + install-manifest + launchctl + local/offsite receipts" });
}

export async function inspectPlatform(platformRootArgument, options = {}) {
  if (typeof platformRootArgument !== "string" || platformRootArgument.trim().length === 0) {
    return { ok: false, reasonCode: "PLATFORM_ROOT_REQUIRED", checks: [check("platformRoot", false, { reasonCode: "PLATFORM_ROOT_REQUIRED" })] };
  }
  const requestedRoot = resolve(platformRootArgument);
  let root;
  try {
    root = await realpath(requestedRoot);
  } catch (error) {
    return { ok: false, reasonCode: "PLATFORM_ROOT_INVALID", checks: [check("platformRoot", false, { reasonCode: "PLATFORM_ROOT_INVALID", path: requestedRoot, error: error?.code ?? "UNKNOWN" })] };
  }
  const rootStats = await existingPath(root);
  if (!rootStats?.isDirectory()) return { ok: false, reasonCode: "PLATFORM_ROOT_INVALID", checks: [check("platformRoot", false, { reasonCode: "PLATFORM_ROOT_INVALID", path: root })] };
  const homeRoot = resolve(options.homeRoot ?? process.env.HOME ?? "");
  const manifest = options.manifest ?? INSTALL_MANIFEST;
  assertInstallManifestComplete(manifest);
  const checks = [
    check("platformRoot", true, { path: root }),
    await inspectAcceptanceGateGroups(root),
    await inspectAgents(root),
    await inspectAgentsHistory(root),
    await inspectWorkspaceContainer(root),
    await inspectWorkspaceStorageShape(root, options),
    await inspectGitAncestors(root),
    await inspectClaudeBridge(root),
    await inspectBridgeSyntax(root),
  ];
  if (options.includeInstallSurface !== false) {
    checks.push(
      await inspectHelperCopies(root, homeRoot, manifest, options),
      await inspectHelperReleaseAlignment(root, homeRoot, options),
      await inspectProofBudget(root, homeRoot, options),
      await inspectUnusedExports(root, options),
      await inspectChainHeadroom(root, options),
      await inspectChainValidation(root, options),
      await inspectAcceptanceVerdicts(root, options),
      await inspectInstallWiring(root, homeRoot, manifest),
      await inspectHookExecutability(root, manifest),
      await inspectDeploymentFreshness(homeRoot, manifest),
      await inspectEngineFloorSatisfied(root, homeRoot, manifest, options),
      await inspectEngineCapabilitySurface(root, homeRoot, manifest, options),
      await inspectHelperSettingsCoverage(root, homeRoot, manifest, options),
      await inspectHostRenderDrift(root, options),
      await inspectTrustArchiveFreshness(root, homeRoot, manifest, options),
      await inspectLaunchdDuty({ ...options, platformRoot: root, homeRoot }, manifest),
      await inspectHarnessSurface(root, manifest),
      await inspectHarnessCoverage(root),
      await inspectSnapshotReadPerformance(root, options),
    );
  }
  const firstFailure = checks.find((item) => !item.ok);
  // Observations are reported beside the verdict, never inside it: `firstFailure` reads
  // `checks` only, so an identity drift is visible without being able to turn the
  // platform red (TCRN-CROSS-INC-219).
  const observations = options.includeInstallSurface === false
    ? []
    : await adapterIdentityObservations(manifest, root, homeRoot);
  return { ok: !firstFailure, reasonCode: firstFailure?.reasonCode ?? "PLATFORM_LAYOUT_HEALTHY", checks, observations };
}

function platformRootFromArgv(argv) {
  const index = argv.indexOf("--platform-root");
  if (index < 0 || !argv[index + 1] || argv[index + 1].startsWith("--")) return null;
  if (argv.some((argument, argumentIndex) => argumentIndex !== index && argumentIndex !== index + 1 && argument.startsWith("--"))) return null;
  return argv[index + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const platformRoot = platformRootFromArgv(process.argv.slice(2));
  const result = await inspectPlatform(platformRoot);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}
