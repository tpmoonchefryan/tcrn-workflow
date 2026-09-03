// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-INIT-049 STORY-352 — one executable positive leg per P3/P4 claim.

const claim = (path, pattern, reasonCode) => Object.freeze({ path, pattern, reasonCode });

export const INIT049_FOCUSED_CLAIMS = Object.freeze({
  "p3-file-native-work-graph": claim("tests/p3-file-engine.test.mjs", "project CRUD and Initiative-Epic-Story-Subtask operations materialize deterministically", "INIT049_P3_FILE_NATIVE_WORK_GRAPH_VERIFIED"),
  "p3-cli-actor-surface": claim("tests/p3-file-engine.test.mjs", "WSE-3: --actor threads through attestation-enable and the mutation verbs into the appended event payload, fail-closed after enable", "INIT049_P3_CLI_ACTOR_SURFACE_VERIFIED"),
  "p3-time-attestation-advisory": claim("tests/p3-file-engine.test.mjs", "WSE-4: --attest-dir writes one deterministic advisory receipt outside the workspace, opt-in and clock-gated", "INIT049_P3_TIME_ATTESTATION_ADVISORY_VERIFIED"),
  "p3-event-integrity-recovery": claim("tests/p3-file-engine.test.mjs", "segment rotation and replay, truncation, reordering, corruption, gap, and special-entry attacks are rejected", "INIT049_P3_EVENT_INTEGRITY_RECOVERY_VERIFIED"),
  "p3-standalone-migration-boundary": claim("tests/p3-file-engine.test.mjs", "Workspace metadata schema, five-root initialization, CLI readback, and standalone boundary are exact", "INIT049_P3_STANDALONE_MIGRATION_BOUNDARY_VERIFIED"),
  "p3-cli-mutation-record-readback": claim("tests/p3-file-engine.test.mjs", "WSB-1: mutation responses carry the created/mutated record identity", "INIT049_P3_CLI_MUTATION_RECORD_READBACK_VERIFIED"),
  "p3-cli-governed-read-surface": claim("tests/p3-cli-read-surface.test.mjs", "read verbs and validate fail closed on stale views, but status reads authority", "INIT049_P3_CLI_GOVERNED_READ_SURFACE_VERIFIED"),
  "p3-cli-command-catalog": claim("tests/p3-cli-catalog.test.mjs", "catalog and dispatcher are in two-way name parity", "INIT049_P3_CLI_COMMAND_CATALOG_VERIFIED"),
  "p3-agent-integration-contract": claim("tests/p3-cli-read-surface.test.mjs", "WSB-6: the agent-integration reference stays in drift-guarded agreement with the catalog", "INIT049_P3_AGENT_INTEGRATION_CONTRACT_VERIFIED"),
  "p3-cli-lease-scoped-version-derivation": claim("tests/p3-file-engine.test.mjs", "WSB-7: --expected-version head derives the current version under the lease; numeric CAS still fails closed", "INIT049_P3_CLI_LEASE_SCOPED_VERSION_DERIVATION_VERIFIED"),
  "p3-lease-pid-reuse-escape-hatch": claim("tests/p3-file-engine.test.mjs", "WSA-4: lease-inspect reports state and lease-break clears the pid-reuse wedge under token+expiry gates", "INIT049_P3_LEASE_PID_REUSE_ESCAPE_HATCH_VERIFIED"),
  "p3-engine-single-replay-pipeline": claim("tests/p3-engine-complexity.test.mjs", "WSA-1: a committed mutation performs exactly one full event-log replay", "INIT049_P3_ENGINE_SINGLE_REPLAY_PIPELINE_VERIFIED"),
  "p3-engine-incremental-replay": claim("tests/p3-engine-complexity.test.mjs", "WSA-2: replaying an n-event chain runs one terminal full-graph validation and O(delta) per-event closures", "INIT049_P3_ENGINE_INCREMENTAL_REPLAY_VERIFIED"),
  "p4-knowledge-file-native-knowledge-core": claim("tests/p4-knowledge-core.test.mjs", "empty Knowledge bootstrap is closed, schema-valid, deterministic, and body-free", "INIT049_P4_FILE_NATIVE_KNOWLEDGE_CORE_VERIFIED"),
  "work-log-event-linkage": claim("tests/p4-knowledge-core.test.mjs", "WSE-5: a work-log candidate carrying an event reference and chain-matching accountable owner promotes unchanged", "INIT049_WORK_LOG_EVENT_LINKAGE_VERIFIED"),
  "p4-knowledge-real-workspace-admission": claim("tests/p4-knowledge-core.test.mjs", "WSC-1: real workspace knowledge admission requires explicit disposability acknowledgment", "INIT049_P4_KNOWLEDGE_REAL_WORKSPACE_ADMISSION_VERIFIED"),
  "p4-knowledge-high-water-rebase": claim("tests/p4-knowledge-core.test.mjs", "WSC-2: knowledge-rebase re-binds the store to an advanced workspace head", "INIT049_P4_KNOWLEDGE_HIGH_WATER_REBASE_VERIFIED"),
  "p4-knowledge-capture-cheap": claim("tests/p4-knowledge-core.test.mjs", "WSC-3: knowledge-create accepts unsorted arrays and sorts them server-side", "INIT049_P4_KNOWLEDGE_CAPTURE_CHEAP_VERIFIED"),
  "p4-knowledge-retrieval": claim("tests/p4-knowledge-core.test.mjs", "WSC-4: knowledge-list supports bounded substring search over subject and tags", "INIT049_P4_KNOWLEDGE_RETRIEVAL_VERIFIED"),
  "p4-knowledge-lifecycle": claim("tests/p4-knowledge-core.test.mjs", "WSC-5: retire and reverify lifecycle transitions fail closed", "INIT049_P4_KNOWLEDGE_LIFECYCLE_VERIFIED"),
  "p4-knowledge-promotion-checks": claim("tests/p4-knowledge-core.test.mjs", "WSC-6: promotion enforces machine checks for tags and snippet", "INIT049_P4_KNOWLEDGE_PROMOTION_CHECKS_VERIFIED"),
  "p4-cli-sentinel-uniformity": claim("tests/p4-knowledge-core.test.mjs", "governed Knowledge CLI exposes init, validate, create, list, snippet, body, freshness, promotion, and checkpoint", "INIT049_P4_CLI_SENTINEL_UNIFORMITY_VERIFIED"),
});

export const INIT049_FOCUSED_CLAIM_NAMES = Object.freeze(Object.keys(INIT049_FOCUSED_CLAIMS));
export const INIT049_FOCUSED_CLAIM_COUNT = 22;
