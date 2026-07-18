# Changelog

All notable changes will be documented here. The project uses Semantic
Versioning after the first accepted release.

## Unreleased

## 0.1.0-rc.5 — 2026-07-18

- Ship the governed conference and gate surface on the local candidate: nine
  governed CLI verbs (`conference-open`/`-append-position`/`-close`/`-cancel`,
  `gate-create`/`-transition`/`-delete`, `conference-list-by-work`, `gate-list`)
  persist `conference.*`/`gate.*` records as additive hash-chained workspace
  events through the single SDC-2 payload constructor, under a held lease and
  the engine `expectedVersion` CAS, with byte-identical views/export/archive for
  workspaces that carry no extension events and a conditional
  `views/extensions.json` index.
- Enforce fail-closed decision gates: a non-tombstoned pending gate anchored to a
  work item blocks that item's transition to `done` with `WORKSPACE_GATE_PENDING`
  at the verb and identically on replay (`WORKSPACE_EVENT_CORRUPT`), and a gate
  reaches `satisfied` only against a resolvable `conference-minutes` locator whose
  conference anchors the gate's work item; the frozen work status graph is
  unchanged — the precondition only narrows admissible transitions.
- Enforce actor attestation at the enable boundary: appending the one-way
  `attestation.actor.enabled` chain event (`attestation-enable`) makes a valid
  actor id mandatory from that sequence onward on both the live append path and
  the replay reducer (`WORKSPACE_ACTOR_REQUIRED` / `WORKSPACE_ACTOR_INVALID`), a
  duplicate enable fails `WORKSPACE_INPUT_INVALID`, and a workspace that never
  enables it stays byte-identical to `0.1.0-rc.4`.
- Land the three-step Claude Code activation ladder as gated, byte-reversible
  capability: the Step-1 installer writes the four inert bundle templates under
  `.claude/tcrn-workflow/` (O_EXCL/O_NOFOLLOW, never touching
  `.claude/settings.json`), Step 2 merges exactly one fail-open `SessionStart`
  hook (the sole authorized fail-open surface — any induced failure exits 0 as
  plain Claude Code), and Step 3 renders the single advisory Verity persona
  authority summary within the 1024-byte injection budget; nothing under
  `~/.claude` is ever named or written and every step is exact byte-inverse on
  rollback.
- Add snapshot backup and a hermetic restore round-trip: a lease-held
  `snapshot-manifest` emits a deterministic per-file manifest, `snapshot-verify`
  reports `SNAPSHOT_VERIFIED`/`SNAPSHOT_MISMATCH`, the restore runbook
  round-trips snapshot → wipe → restore byte-identically at the original path
  with both doctrine failure modes failing closed, and an optional git tier-2
  serves as an integrity witness only.
- Extend the Knowledge Core: capture-cheap `knowledge-create`, governed
  `knowledge-rebase` head re-binding (`KNOWLEDGE_REBASE_BLOCKED` on unresolved
  references), the reverify/retire lifecycle under CAS
  (`KNOWLEDGE_LIFECYCLE_INVALID`), unconditional promotion governance
  (`KNOWLEDGE_PROMOTION_INVALID`), and close-time conference distillation of each
  minutes decision into a backlinking knowledge candidate the unchanged creation
  contract accepts.
- Remove the quadratic replay cost: an n-event chain runs exactly one terminal
  full-graph validation plus one ancestor-bounded O(delta) closure per work
  event, proven by closed-form operation-count equality.
- Document the agent-integration CLI consumption contract — envelopes, the retry
  table for `WORKSPACE_VIEW_STALE`/`WORKSPACE_LOCKED`/`WORKSPACE_CAS_MISMATCH`
  (plus the lease verbs, `WORKSPACE_GATE_PENDING`, and `SNAPSHOT_*` codes), the
  `-`/`null`/`head` sentinels, and determinism guarantees — with a drift-guard
  test binding the prose to the live command catalog.
- Add opt-in, advisory time-attestation receipts via `--attest-dir` on every
  workspace-event mutation verb: the engine reads no clock, receipts write only
  outside the workspace root, embed no path or hostname, and carry no governance
  weight; export and archive bytes are identical whether or not receipts exist.
- Document the `settings-catalog-v1` conference and backup knobs, expand the
  one-page protocol stub specs to normative weight, and record the
  proof-to-product budget rule as a reviewer-enforced `CONTRIBUTING` policy.
- Prove the flagship end-to-end governed loop: one hermetic replay of
  initiative → epic → story → gate → conference → distill → promote → trace on a
  real workspace, every tutorial command executed verbatim and every produced
  digest traced to its producer (`pnpm verify:e2e`).
- Add `docs/architecture/rc5-compatibility.md`: the rc.4 → rc.5 workspace
  compatibility and migration matrix (intentional forward-incompatibility of
  conference/gate/attestation events under `storageVersion 1`, the one-way
  attestation boundary, and the disposable knowledge-store re-initialization
  procedure).

- Re-cut the MVP scope to two officially supported V1 Agent Apps (Codex and
  Claude Code) for the `0.1.0-rc.4` unpublished local candidate: add the inert
  Claude Code adapter (P6B), the additive `dependency-v1` extension, the
  `conference-v1`/`assignment-v1`/`gate-v1` skeletons, the `work-log-v1` and
  `settings-catalog-v1` documentation specs, and public requirement ledger
  entries `AOS-REQ-015..019`. `work-model-v1`, `codex-adapter.ts`, and the
  generic starter path are unchanged.
- Repair the CI package-manager bootstrap with explicit online acquisition of
  pinned Node and pnpm, then retain frozen dependency acquisition and offline
  P1 verification for the `0.1.0-rc.3` unpublished local candidate.

- Add the deterministic `0.1.0-rc.1` unpublished local Workflow release
  candidate proof, canonical USTAR source archive, closed six-artifact release
  set, sanitized Core Reference projection, and P8 verification command.

- Prepare the immutable unpublished `0.1.0-rc.1` Workflow release candidate
  with deterministic source/release artifacts, SBOM, provenance, closed
  allowlist, sanitized Core Reference projection, and offline P8 proof.

- Establish the clean-history P1 framework bootstrap.
- Pin the toolchain and offline deterministic verification commands.
- Define external release-trust-root verification and privacy boundaries.
- Freeze the P2 Protocol V1 schemas, specifications, conformance fixtures,
  generic AOS requirements ledger, P3 marker contract, and unaccepted RC1
  candidate proof manifest.
- Freeze runtime-independent UTF-8 byte ordering, exact nanosecond instant
  comparisons, closed runtime/schema parity, and executable adversarial vectors
  with offline Draft 2020-12 evaluation.
- Reject malformed Unicode across canonical protocol/proof/trust surfaces,
  align the 161-character stable-ID and extension-name schema boundary, and
  enforce vulnerability policy over the complete frozen dependency graph.
- Emit shared canonical objects directly in UTF-8 byte order, preserving every
  own key, and close RC1 candidate and verdict-slot field admission.
- Add the P3 file-native Workspace/event-engine candidate with governed CRUD,
  leases/CAS, no-follow atomic segments, crash recovery, deterministic views,
  dry-run migration planning, and filesystem fault proof without a P3 marker.
- Close RC-P3 root-entry schema parity, exact event lifecycle and Workspace
  identity binding, and exclusive crash/race-safe lease recovery proof.
- Serialize same-lease mutation admission with an identity-bound filesystem
  claim so concurrent same-version writes cannot silently replace an event.
- Add the bounded P4 artifact lifecycle candidate: closed classification,
  deterministic doctor/size and compact projections, redacted metadata-first
  references, and disposable-only archive apply/restore with fault proof.
- Add the bounded P4 file-native Knowledge Core candidate with closed metadata,
  separate explicit body reads, deterministic filters/indexes/checkpoints,
  freshness and promotion CAS, inert locators, strict limits, and disposable
  filesystem fault proof without live-store initialization.
- Close Knowledge metadata/body access separation, default-checkpoint parity,
  accountable source/evidence provenance, selection and strict-instant
  admission, UTF-8 byte-budget schema proof, and 64 actual-store insertion
  permutations.
- Close RC2 defensive boundaries for pre-claim Knowledge promotion admission,
  ownerless stale-lease generation quarantine, and incremental transient/archive
  storage exhaustion enforcement.
- Add the bounded P5 generic profile-policy candidate with closed trust and
  binding, deterministic precedence, exact merge classes, owner-rebind gating,
  canonical digests, read-only CLI surfaces, 64 insertion permutations, and a
  disposable empty-Workspace planned-delivery cold-start proof.
- Bind P5 trust admission to the frozen framework base and independent,
  descriptor-validated receipts; authorization now re-resolves untrusted
  request bytes and rejects standalone effective-profile capabilities.
- Require an out-of-band governed canonical path and raw receipt-file digest;
  P5 receipts now bind the complete request and derived effective profile, so
  caller-minted, copied, or replaced canonical receipts cannot authorize.
- Add the sanitized eight-record Core Reference persona bundle, closed schema,
  display-only release layers, read-only CLI, and deterministic/privacy proof.
- Add the bounded P6 Context Router with descriptor-bound request authority,
  admitted profile re-resolution, metadata-first and explicit-read selection,
  and privacy-minimal receipts.
- Add the Codex Adapter only as an uninstalled inert-template candidate with
  separate host injection, authority-empty fallback, deterministic bundle,
  identity-bound rollback planning, final-hop simulation, and no OG-04, RC3,
  store, hook, Skill, configuration, or activation claim.
- Require exact canonical template bytes, positional bundle/schema parity, and
  a pinned no-follow descriptor-verified installation-generation receipt before
  inert rollback planning; caller-supplied identity objects no longer admit it.
- Add P7-B offline Compatibility And Modes planning with a closed Workflow
  manifest, governed pair-receipt admission, policy rollback/replay controls,
  field-level AOS ownership preservation, and exact unavailable live surfaces.
- Bind P7-B admission to a no-follow host-anchored canonical authority receipt,
  normalize semantic sets before hashing, and prove recursive JSON and exact
  aggregate-document limits across schema and runtime.
- Bound P7-B authority receipt reads to 65,537 observed bytes so concurrent
  same-inode growth fails immediately without unbounded allocation or I/O.
