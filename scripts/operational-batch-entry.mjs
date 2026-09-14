#!/usr/bin/env node
// TCRN-CROSS-STORY-421 — the sole executable formal-batch consumer.
//
// Hooks only qualify or notify.  This entry acquires fresh native work, process,
// dependency and candidate observations, builds the same dynamic gate plan used
// by the planner API, and executes only its selected top-level roots serially.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildContainedExecutionPlan } from "./lib/push-gate-children.mjs";
import {
  buildDynamicGatePlan,
  createGateReceiptAuthority,
  gateReceiptEvidence,
  issueGateReceipt,
  executeOperationalBatch,
  executeSelectedRoots,
  readNativeBatchState,
} from "./final-gate-plan.mjs";

export const OPERATIONAL_BATCH_ENTRY_VERSION = "tcrn.operational-batch-entry.v2";
export const CODE_OWNED_RUNNER_VERSION = "tcrn-code-owned-runner.v1";
const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const platformRoot = resolve(repositoryRoot, "../..");
const chainContainer = [".tcrn", "workspace"].join("-");
const workspaceDefault = resolve(platformRoot, chainContainer, "cross-project/workspace");
const rosterPath = resolve(platformRoot, "platform-docs/acceptance-gate-groups.json");
const containmentPath = resolve(repositoryRoot, "scripts/policy/gate-containment.json");
const sourceArchivePath = resolve(repositoryRoot, "dist/source/tcrn-workflow-source.tar");
const node = process.execPath;
export const PACK_SOURCE_BASELINE_COMMIT = "06b9f0a20467d9cbd5203d519eb8d4a563e5f126";
const productionReceiptAuthority = createGateReceiptAuthority();

const text = (value) => typeof value === "string" ? value : "";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const stableJson = (value) => JSON.stringify(value, (_key, child) => {
  if (child === null || typeof child !== "object" || Array.isArray(child)) return child;
  return Object.fromEntries(Object.keys(child).sort().map((key) => [key, child[key]]));
});
const digestValue = (value) => sha256(stableJson(value));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    timeout: options.timeout ?? 10_000,
    shell: false,
  });
  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    signal: result.signal,
    stdout: text(result.stdout),
    stderr: text(result.stderr),
    error: result.error ? String(result.error.message ?? result.error) : null,
  };
}

function gitOutput(args) {
  const result = run("git", ["--no-optional-locks", ...args], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
  return result.ok ? result.stdout : "";
}

function resolvedCommit(value) {
  const commit = gitOutput(["rev-parse", value]).trim();
  return /^[0-9a-f]{40}$/u.test(commit) ? commit : null;
}

function sourceDeltaFiles(baselineCommit = PACK_SOURCE_BASELINE_COMMIT) {
  const baseline = resolvedCommit(baselineCommit);
  const head = resolvedCommit("HEAD");
  if (baseline === null || head === null) return { baseline, head, files: [], verifiable: false };
  const committed = gitOutput(["diff", "--name-only", "-z", `${baseline}..${head}`]);
  const tracked = gitOutput(["diff", "--name-only", "-z", "HEAD"]);
  const untracked = gitOutput(["ls-files", "--others", "--exclude-standard", "-z"]);
  return { baseline, head, files: [...new Set(`${committed}${tracked}${untracked}`.split("\0").map((path) => path.trim()).filter(Boolean))].sort(), verifiable: true };
}

function changedSourceFiles(options = {}) {
  return sourceDeltaFiles(options.baselineCommit ?? PACK_SOURCE_BASELINE_COMMIT).files;
}

function currentSourceDigest(files, { baselineCommit = PACK_SOURCE_BASELINE_COMMIT, baseline = null, head = null } = {}) {
  const rows = files.map((path) => {
    try {
      const bytes = readFileSync(resolve(repositoryRoot, path));
      return { path, bytes: bytes.length, sha256: sha256(bytes) };
    } catch {
      return { path, bytes: null, sha256: null };
    }
  });
  const currentHead = head ?? resolvedCommit("HEAD");
  const currentTree = gitOutput(["rev-parse", "HEAD^{tree}"]).trim();
  const basis = {
    schemaVersion: "tcrn.source-delta.v1",
    baselineCommit: baseline ?? resolvedCommit(baselineCommit),
    headCommit: currentHead,
    headTree: /^[0-9a-f]{40}$/u.test(currentTree) ? currentTree : null,
    files: rows,
  };
  return { digest: digestValue(basis), files: rows, baselineCommit: basis.baselineCommit, headCommit: basis.headCommit, headTree: basis.headTree, deltaMeasured: true };
}

const GOVERNED_WRITE_COMMAND = /(?:tcrn-workflow\.mjs|tcrn-workflow\/scripts\/[^\s]+\.mjs).*\b(?:artifact-put|conference-(?:append-position|cancel|close|open)|dispatch-(?:classes-set|mode-set|tiers-set)|gate-(?:create|delete|transition)|knowledge-(?:article-create|article-refresh|batch|bodies-migrate|capture|checkpoint|create|init|promote|rebase|recover|retire|reverify)|lease-(?:break|recovery-break)|machine-settings-(?:remove|set)|migration-execute|project-(?:create|delete|update)|recover|retire-sweep|settings-(?:remove|set)|snapshot-replay-rebuild|template-admit|work-(?:annotate|batch|create|delete|transition))\b/iu;
const RELATIVE_REPOSITORY_COMMAND = /(?:^|\s)(?:node|pnpm)(?:\s+[^\s]+)*\s+(?:scripts\/|tools\/|packages\/|tests\/)/u;

function classifyProcess(row, { selfPid = process.pid, selfPgid = null } = {}) {
  const command = text(row.command);
  const state = text(row.state).trim();
  const isOwn = row.pid === selfPid || selfPgid !== null && row.pgid === selfPgid;
  const formalEntryWrapper = /(?:^|\s)(?:node\s+)?[^\s]*operational-batch-entry\.mjs(?:\s|$)/u.test(command);
  const absoluteRepository = command.includes(repositoryRoot) || text(row.cwd).startsWith(repositoryRoot);
  const taskBound = command.includes("TCRN-CROSS-STORY-") || command.includes("EPIC135");
  const relativeRepository = RELATIVE_REPOSITORY_COMMAND.test(command);
  const inRepository = absoluteRepository || taskBound;
  const appService = /(?:Codex \((?:Service|Renderer)\)|Claude Helper|static-serve|portal\/portal\.mjs|\/Applications\/(?:ChatGPT|Claude)\.app|codex app-server)/iu.test(command);
  const taskRole = /(?:\b(?:luna|astra|sonnet|sol|rework|acceptance|review|implement)\b|TCRN-CROSS-STORY-4(?:1[5-9]|2[0-2]))/iu.test(command);
  const likelyGovernedWrite = GOVERNED_WRITE_COMMAND.test(command) || relativeRepository && /\b(?:put|set|create|delete|transition|recover|capture|promote|retire|migrate|annotate|batch)\b/iu.test(command);
  let scope = "unknown";
  let active = true;
  let role = "unknown";
  let scopeBasis = "unresolved";
  if (isOwn) {
    scope = "orchestration";
    role = "formal-entry";
    active = false;
    scopeBasis = "code-owned-entry";
  } else if (formalEntryWrapper) {
    scope = "orchestration";
    role = "formal-entry";
    scopeBasis = "code-owned-entry";
  } else if (appService) {
    scope = "unrelated";
    role = "host-service";
    active = false;
    scopeBasis = "host-service";
  } else if (taskRole && inRepository) {
    scope = /(?:review|acceptance|astra)/iu.test(command) ? "review" : "implementation";
    role = scope;
    scopeBasis = absoluteRepository ? "absolute-repository" : "task-bound";
  } else if (inRepository) {
    scope = "orchestration";
    role = "orchestration";
    scopeBasis = absoluteRepository ? "absolute-repository" : "task-bound";
  } else if (/^(?:R|S|S\+|Ss)$/u.test(state)) {
    // A live relative repository command is an unknown scoped observation, not
    // an empty list; an unrelated live system process is retained separately so
    // it does not block a batch merely because its cwd is unavailable.
    scope = "unknown";
    role = relativeRepository || likelyGovernedWrite ? "unknown-repository-process" : "unknown-live-process";
    scopeBasis = relativeRepository ? "relative-command-without-cwd" : "live-process-without-scope";
  } else {
    scope = "unrelated";
    role = "host-service";
    active = false;
    scopeBasis = "non-live-system-process";
  }
  return { ...row, scope, role, active, inRepository, likelyGovernedWrite, scopeBasis, stateKnown: /^(?:R|S|S\+|Ss)$/u.test(state) };
}

function processSnapshot() {
  const result = run("ps", ["-axo", "pid=,ppid=,pgid=,stat=,command="], { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 });
  if (!result.ok) return { ok: false, reasonCode: "BATCH_HOST_SNAPSHOT_NOT_VERIFIABLE", error: result.stderr || result.error || "ps failed" };
  const rows = text(result.stdout).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).map((line) => {
    const match = line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/u);
    return match === null ? null : { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), state: match[4], command: match[5] };
  }).filter(Boolean);
  const selfPgid = rows.find((row) => row.pid === process.pid)?.pgid ?? null;
  const classified = rows.map((row) => classifyProcess(row, { selfPid: process.pid, selfPgid }));
  const agentRows = classified.filter((row) => row.pid !== process.pid && row.scope !== "unrelated" && row.scope !== "unknown");
  const unknownRows = classified.filter((row) => row.scope === "unknown");
  const writeRows = classified.filter((row) => row.scope !== "unrelated" && (GOVERNED_WRITE_COMMAND.test(row.command) || row.likelyGovernedWrite === true));
  const unrelated = classified.filter((row) => row.scope === "unrelated");
  return {
    ok: true,
    observedAt: new Date().toISOString(),
    source: "code-owned-ps-host-snapshot",
    agents: { observed: true, digest: digestValue(agentRows), records: agentRows, unknown: unknownRows, unrelatedCount: unrelated.length },
    writes: { observed: true, digest: digestValue(writeRows), records: writeRows, unknown: writeRows.filter((row) => row.scope === "unknown") },
    scopeObservations: { inScope: agentRows, outOfScope: unrelated, unknown: unknownRows },
    processCount: rows.length,
    unrelatedCount: unrelated.length,
  };
}

function candidateSnapshot() {
  try {
    const archive = readFileSync(sourceArchivePath);
    const head = gitOutput(["rev-parse", "HEAD"]).trim();
    const tree = gitOutput(["rev-parse", "HEAD^{tree}"]).trim();
    const status = gitOutput(["status", "--porcelain=v1", "--untracked-files=all"]);
    const stable = status.trim() === "" && /^[0-9a-f]{40}$/u.test(head) && /^[0-9a-f]{40}$/u.test(tree);
    return {
      observed: true,
      stable,
      id: tree || head || "engine-source-candidate",
      digest: sha256(archive),
      bytes: archive.length,
      source: "code-owned-candidate-observer",
      statusDigest: sha256(status),
      statusClean: status.trim() === "",
      head,
      tree,
      reasonCode: stable ? "BATCH_CANDIDATE_STABLE" : "BATCH_CANDIDATE_TREE_DIRTY",
      records: [],
    };
  } catch (error) {
    return { observed: false, stable: false, id: null, digest: null, records: [], reasonCode: "BATCH_CANDIDATE_NOT_VERIFIABLE", error: String(error?.message ?? error) };
  }
}

async function observeHostRuntime({ nativeState } = {}) {
  const snapshot = processSnapshot();
  if (!snapshot.ok) return snapshot;
  const queue = nativeState?.queue;
  const dependencies = nativeState?.dependencies;
  if (!queue || queue.observed !== true || !Array.isArray(queue.records) || !dependencies || dependencies.observed !== true || !Array.isArray(dependencies.records)) {
    return { ok: false, reasonCode: "BATCH_NATIVE_OBSERVATION_NOT_VERIFIABLE", error: "native queue/dependency snapshot is incomplete" };
  }
  const candidate = candidateSnapshot();
  return {
    ok: true,
    observedAt: snapshot.observedAt,
    source: snapshot.source,
    queue: { observed: true, digest: queue.digest, records: queue.records },
    dependencies: { observed: true, digest: dependencies.digest ?? digestValue(dependencies.records), records: dependencies.records },
    agents: snapshot.agents,
    writes: snapshot.writes,
    scopeObservations: snapshot.scopeObservations,
    candidate: { observed: candidate.observed, stable: candidate.stable, digest: candidate.digest, id: candidate.id, records: [], source: candidate.source, statusClean: candidate.statusClean, head: candidate.head, tree: candidate.tree, reasonCode: candidate.reasonCode },
    candidateObservation: candidate,
  };
}

function codeOwnedImpact({ baselineCommit = PACK_SOURCE_BASELINE_COMMIT } = {}) {
  const sourceDelta = sourceDeltaFiles(baselineCommit);
  const changedFiles = sourceDelta.files;
  const source = currentSourceDigest(changedFiles, { baselineCommit, baseline: sourceDelta.baseline, head: sourceDelta.head });
  const dependencies = changedFiles.filter((path) => /^(?:package\.json|pnpm-lock\.yaml|packages\/[^/]+\/package\.json|packages\/[^/]+\/src\/)/u.test(path)).map((path) => ({ path, repository: "TCRN Platform/tcrn-workflow" }));
  const configuration = changedFiles.filter((path) => /(?:scripts\/policy\/|\.claude\/|\.codex\/|settings|config)/iu.test(path)).map((path) => ({ path, repository: "TCRN Platform/tcrn-workflow" }));
  const generated = changedFiles.filter((path) => /^(?:dist\/|generated\/)/u.test(path)).map((path) => ({ path, repository: "TCRN Platform/tcrn-workflow" }));
  const nodeVersion = process.version;
  const pnpmVersionResult = run("pnpm", ["--version"], { timeout: 5_000, maxBuffer: 100_000 });
  const pnpmVersion = pnpmVersionResult.stdout.trim();
  const environment = [
    { name: "node-runtime", value: nodeVersion, known: nodeVersion === "v24.16.0", gateIds: ["engine-release"] },
    { name: "pnpm-runtime", value: pnpmVersion, known: pnpmVersion === "11.3.0", gateIds: ["engine-release"] },
    { name: "source-baseline", value: sourceDelta.baseline ?? baselineCommit, known: sourceDelta.verifiable, gateIds: ["engine-release"] },
  ];
  const crossRepoChanges = [];
  let baselineBytes = Buffer.alloc(0);
  try {
    baselineBytes = Buffer.concat([
      readFileSync(resolve(platformRoot, "platform-docs/acceptance-gate-groups.json")),
      readFileSync(containmentPath),
      readFileSync(resolve(repositoryRoot, "scripts/policy/coverage-baseline.json")),
    ]);
  } catch {
    baselineBytes = Buffer.from("baseline-unreadable", "utf8");
  }
  const commandBytes = Buffer.from(stableJson({ rosterPath, containmentPath, node, pnpmVersion, phase: "candidate-final", baselineCommit: source.baselineCommit, sourceBaseline: PACK_SOURCE_BASELINE_COMMIT }), "utf8");
  return {
    schemaVersion: "tcrn.operational-impact.v2",
    changedFiles,
    dependencies,
    configuration,
    generated,
    environment,
    crossRepoChanges,
    repositories: ["TCRN Platform/tcrn-workflow"],
    inputs: {
      sourceDigest: source.digest,
      environmentDigest: digestValue(environment),
      commandDigest: sha256(commandBytes),
      baselineDigest: sha256(baselineBytes),
    },
    sourceBaseline: {
      requested: baselineCommit,
      resolved: source.baselineCommit,
      head: source.headCommit,
      tree: source.headTree,
      verifiable: sourceDelta.verifiable,
      deltaFiles: changedFiles,
    },
    source,
  };
}

function loadGateDeclarations() {
  const roster = JSON.parse(readFileSync(rosterPath, "utf8"));
  const containment = JSON.parse(readFileSync(containmentPath, "utf8"));
  const contained = buildContainedExecutionPlan(containment);
  return { roster, containment, contained };
}

function rootInvocation(id, command) {
  if (id === "engine-release") return { executable: "node", argv: ["scripts/push-gate.mjs"], cwd: repositoryRoot, command: command ?? "node scripts/push-gate.mjs" };
  if (id === "platform-layout") return { executable: "node", argv: ["scripts/platform-doctor.mjs", "--platform-root", platformRoot], cwd: repositoryRoot, command: command ?? "node scripts/platform-doctor.mjs --platform-root <container>" };
  if (id === "product-gates") return { executable: "pnpm", argv: ["verify"], cwd: resolve(platformRoot, "TCRN Platform/TCRN-Design-System"), command: command ?? "pnpm verify" };
  return null;
}

function writeRunnerReceipt(authority, entry, result, inputs, invocation) {
  return issueGateReceipt(authority, { entry, result, inputs, invocation });
}

async function executeDynamicRoots(qualification) {
  const { roster, containment, contained } = loadGateDeclarations();
  const baselineCommit = typeof PACK_SOURCE_BASELINE_COMMIT === "undefined" ? undefined : PACK_SOURCE_BASELINE_COMMIT;
  const impact = codeOwnedImpact(baselineCommit === undefined ? {} : { baselineCommit });
  const receiptAuthority = typeof productionReceiptAuthority === "undefined" ? null : productionReceiptAuthority;
  const priorEvidence = receiptAuthority === null || typeof gateReceiptEvidence === "undefined" ? [] : gateReceiptEvidence(receiptAuthority);
  const phase = ["candidate-final", "publication", "merge-sensitive"].includes(qualification.stage) ? qualification.stage : "candidate-final";
  const gateInvocations = Object.fromEntries((contained?.selected ?? []).map(({ id }) => {
    const command = roster?.groups?.find((group) => group.id === id)?.command;
    return [id, rootInvocation(id, command)];
  }).filter(([, invocation]) => invocation !== null));
  const plan = buildDynamicGatePlan({
    roster,
    containment,
    phase,
    inputs: impact.inputs,
    previousEvidence: priorEvidence,
    receiptAuthority,
    gateInvocations,
    changedFiles: impact.changedFiles,
    dependencies: impact.dependencies,
    configuration: impact.configuration,
    generated: impact.generated,
    environment: impact.environment,
    crossRepoChanges: impact.crossRepoChanges,
    repositories: impact.repositories,
    candidateReady: true,
    executionPermission: true,
    operational: true,
    requireCompleteImpact: true,
  });
  if (plan.executable !== true || plan.blocked?.length > 0) return { ok: false, status: "not-verifiable", reasonCode: "BATCH_DYNAMIC_PLAN_NOT_EXECUTABLE", plan, executed: [] };
  const execution = await executeSelectedRoots(plan, async (entry) => {
    const invocation = entry.invocation ?? rootInvocation(entry.id, entry.command);
    if (invocation === null || entry.rootId !== entry.id) return { id: entry.id, status: "failed", ok: false, exitCode: null, reasonCode: "BATCH_ROOT_NOT_REGISTERED" };
    const result = run(invocation.executable, invocation.argv ?? invocation.args, { cwd: invocation.cwd, timeout: 30 * 60_000, maxBuffer: 64 * 1024 * 1024 });
    return writeRunnerReceipt(receiptAuthority, entry, result, entry.inputs ?? impact.inputs, invocation);
  }, { getInputs: async () => codeOwnedImpact(baselineCommit === undefined ? {} : { baselineCommit }).inputs });
  const budgetBlocked = execution.executed?.some((row) => row.reasonCode === "PROOF_BUDGET_EXCEEDED" || row.failureReasonCode === "PROOF_BUDGET_EXCEEDED" || row.terminalEvidence?.reasonCode === "PROOF_BUDGET_EXCEEDED") === true;
  const completed = execution.executable === true && execution.blocked?.length === 0;
  return {
    ok: completed,
    status: completed ? "completed" : budgetBlocked ? "not-verifiable" : "failed",
    reasonCode: completed ? "BATCH_DYNAMIC_GATE_COMPLETED" : budgetBlocked ? "BATCH_ROOT_BUDGET_NOT_VERIFIABLE" : execution.reasonCode ?? "BATCH_DYNAMIC_GATE_FAILED",
    plan,
    execution,
    storeRoot: receiptAuthority?.storeRoot ?? null,
    executed: execution.executed ?? [],
  };
}

/** Execute the production entry; all caller observations are discarded. */
export async function executeProductionBatch(request = {}) {
  const { nativeState: _native, runtimeObserver: _runtime, observer: _observer, ...boundRequest } = request && typeof request === "object" ? request : {};
  const input = {
    workspace: boundRequest.workspace ?? workspaceDefault,
    engineCli: boundRequest.engineCli ?? resolve(repositoryRoot, "scripts/tcrn-workflow.mjs"),
    workIds: Array.isArray(boundRequest.workIds) ? boundRequest.workIds : [],
    series: boundRequest.series,
    pack: boundRequest.pack,
    stage: boundRequest.stage,
    candidate: boundRequest.candidate,
    candidateReady: boundRequest.candidateReady,
    trigger: boundRequest.trigger ?? "formal-batch-gate",
    expectedBinding: boundRequest.expectedBinding,
    currentBinding: boundRequest.currentBinding,
    previousRuns: boundRequest.previousRuns,
    stageCompletionAuthority: boundRequest.stageCompletionAuthority,
    stageCompletionReceipts: boundRequest.stageCompletionReceipts,
    securityVeto: boundRequest.securityVeto,
    permissionDenied: boundRequest.permissionDenied,
  };
  return executeOperationalBatch(input, executeDynamicRoots, { readNative: readNativeBatchState, observeRuntime: observeHostRuntime });
}

function readStdin() {
  try { return JSON.parse(readFileSync(0, "utf8")); } catch { return {}; }
}

export { classifyProcess, processSnapshot, observeHostRuntime, codeOwnedImpact, rootInvocation, writeRunnerReceipt };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await executeProductionBatch(readStdin());
  process.stdout.write(`${JSON.stringify({ schemaVersion: OPERATIONAL_BATCH_ENTRY_VERSION, ...result })}\n`);
  if (result.status !== "completed" && result.status !== "idempotent") process.exitCode = 1;
}
