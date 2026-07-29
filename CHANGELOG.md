# Changelog

All notable changes will be documented here. The project uses Semantic
Versioning after the first accepted release.

## 0.9.0 — 2026-07-29

A workspace gains a governed route to a new path or a new machine.

The engine binds five absolute roots and refuses a control tree whose stored root
identities disagree with the live filesystem. That refusal is correct and stays.
What was missing was a route THROUGH it: an operator who had to move a workspace
had exactly one option, hand-editing `roots`, and nothing anywhere recorded that
it had happened. The documented reason for the gap was also wrong — ADR 0002 and
the backup runbook both attributed root rebinding's deferral to OD-29, which is
the manifest-scope decision, when the apply-path deferral is OD-7 and concerns
storage-version-2 chain rewriting. Root rebinding rewrites no event and changes no
storage version.

### Added

- **`relocation-plan` / `relocation-vacate` / `relocation-adopt` /
  `relocation-abort` / `relocation-inspect`.** Five verbs that move the BINDING,
  never the bytes. `relocation-plan` is read-only and comes first: it emits the
  hop's `relocationId`, which the authority must name, and the control manifest,
  which after the vacate commits no address can produce again while adopt requires
  its exact text. Plan and vacate share one preparation function so the id the
  operator mints against is the id the vacate takes. The
  order vacate → copy → adopt is mechanically enforced, because copy-first is the
  operator's natural instinct and must fail closed rather than produce an
  unauthorized live target. Between the vacate and the adopt **zero** addresses
  are alive, not two; the source and the copy refuse under different, actionable
  codes. The operator moves the bytes with OS tools — the engine gets no copy
  path, and ADR 0003 names the refused alternatives so a later reader does not add
  one back.
- **An append-only `relocations` ledger** as a tenth, OPTIONAL field of
  `workspace.json`. `schemaVersion` stays `tcrn.workspace.v1`, `storageVersion`
  stays `1`, and the field is **absent — not empty** — on every workspace that
  never relocates, so those files are byte-identical to `0.8.0`. Because it
  travels inside the copied tree, a re-copy of a vacated source is born dead and a
  copy of an adopted target dropped back at the old path is dead too. `roots` is
  never rewritten; `activeBinding()` answers where the tree lives now.
- **A per-invocation relocation authority** on the gate-identity pins-track shape.
  A permit names `actorId`, `workspaceIds`, `destinations`, a `basis` of
  `{version, headEventHash}`, the exact `relocationId`, and the exact `stage`
  (`vacate` / `adopt` / `abort`). Without the `workspaceIds` term the roster
  permits every workspace on the machine while still looking rigorous; without
  `destinations` a permit to move a workspace somewhere approved moves it anywhere;
  without the basis a permit can name the right hop and a stale vintage. The last
  two terms are what make the permit per-INVOCATION rather than per-vintage:
  relocation does not advance the chain, so the basis alone is byte-identical after
  a hop and one file drove `vacate → adopt → abort` twice over in an adversarial
  review, leaving three live authorities for one `workspaceId` with no tampering.
  A `relocationId` is derived over `(workspaceId, sequence, from, to, basis)`, so
  one permit authorizes one hop and one verb of it.
  The ledger records only `{actorId, authorityFileSha256}`, never a file
  reference — a chain whose readability depends on an external file still being
  present is a chain that bricks on a restore onto a fresh machine.
- **Adopt-side assertions for the two blindnesses the snapshot manifest cannot
  cover**: a copy that dropped an empty directory, and a copy that carried a lock
  or claim file across. Neither is a manifest bug; both are it doing what it was
  scoped to do. Each proof asserts BOTH halves — that `snapshot-verify` still
  returns `SNAPSHOT_VERIFIED`, and that adopt then refuses — because without the
  first half the second cannot be shown to measure anything.

### Changed

- `readMetadata` gains an `admit` parameter defaulting to the STRICT value. The
  enforcement point is `readMetadata` and not `resolveWorkspace`, chosen on
  evidence: `acquireWorkspaceLease`, `lease-break` and `lease-recovery-break`
  never reach `resolveWorkspace`, so placing the check there leaves a vacated
  address with live lease-mutation paths. `lease-inspect` is deliberately still
  admitted at a dead address — it emits no workspace content and cannot revive
  anything, and an operator legitimately needs to see a stale lease on a dead
  tree.
- `verifySnapshotManifest` gains an optional `excludePaths`, additive and
  byte-neutral for every existing caller.
- The three mutating verbs are absent from the MCP surface, excluded by a
  predicate derived from the command catalog rather than a hand-written list of
  names.

### Doctrine retired

- ADR 0002's "Restore constraint" paragraph and doctrine 1 of the backup runbook
  both claimed root rebind needed the migration apply path, per OD-29. Both are
  retired by section reference in the same change that ships the replacement, with
  the misattribution explained rather than quietly deleted. The
  `WORKSPACE_SCHEMA_INVALID` refusal itself is unchanged.
- `packages/core/spec/file-engine-v1.md`'s immutable-metadata / closed-V1-schema
  language is narrowed with an explicit residual-applicability analysis: the old
  rule still holds for every field and every caller EXCEPT the three relocation
  verbs. Conditional retention, not deletion.

### Compatibility

Additive and byte-identical for every workspace that never relocates.

**For a workspace that carries a relocation ledger — including one whose relocation
was ABORTED and that never moved a byte — the break is total and one-way**: the
tenth metadata field fails the closed-field check with `WORKSPACE_SCHEMA_INVALID` on
any `0.8.0`-or-earlier binary — not degraded reads, no reads. The aborted case is
named because the ledger is append-only, so cancelling a move also version-locks the
partition, and that is the case an operator is least likely to expect. Accepted deliberately
(OD-A) rather than discovered later. The ledger cap is sixteen entries, picked
deliberately (OD-B) so it does not become an accidental constant.

### What this does not do

`workspace.json` is the one part of the control tree the event hash chain does not
cover. Anyone with write access to a vacated source can restore its pre-vacate
`workspace.json` in canonical bytes and that address is alive again, and the
engine **cannot** detect it — the same ceiling `gate-identity.ts` already states
about gates. This release does not prevent two truths; it makes them legible,
permanently, in both files, under one shared `relocationId`.

It does NOT make producing a fork require destroying an artifact — an earlier draft
of this entry said so and was measured wrong. `relocation-abort` alone produces one
if the destination already adopted, destroying nothing, and abort is the documented
recovery verb. What abort costs now is an authority minted for THIS hop's `abort`
stage, an explicit `--acknowledge-fork-risk`, and an optional `--target-inspection`
document that is CHECKED and refuses the abort when the destination has adopted.
The source still cannot know what the destination did; the receipt and every later
`relocation-inspect` at that address say exactly that, in those words.

The consequence is a mandatory close-out step no gate can replace: run
`relocation-inspect` at BOTH ADDRESSES THE LEDGER NAMES and compare. It needs both
trees at once and is therefore by construction not something `verify` can run for
you. Its scope is stated exactly, because an earlier draft overstated it: it proves
those two addresses have not both stayed live. A third address made by copying the
tree, deleting `relocations` and rewriting `roots` is a fully live authority that
appears in no ledger and that this compare cannot see — the pre-`0.9.0` hand-edit
hole, which this design does not close and does not claim to. No single-sided "the source is still dead" assertion
exists in the suite, and that absence is deliberate — such an assertion would be
permanently true.

## 0.8.0 — 2026-07-29

The event chain becomes readable on the chains that have one worth reading.

`0.7.0` closed two of the three read-surface gaps its first cockpit consumer
filed. This closes the third, which is the same gap in its purest form: `export`
was the only read that returned events at all, and it refuses any workspace whose
canonical form exceeds one MiB. Three of the four chains on the platform that
filed this already do — `cross-project` at 1,825,251 canonical event bytes,
`TCRN-AOS` at 1,160,601, `TCRN-Design-System` at 1,134,120 — and the fourth will
by growing. So the one artifact a consumer needs in order to reproduce a chain was
unreachable exactly on the chains large enough to be worth reproducing.

### Added

- **`event-list`**, workspace-scoped and paginated with `--limit` / `--offset`
  like every other list verb. Records come back **verbatim** — `schemaVersion`,
  `id`, `streamId`, `sequence`, `occurredAt`, `priorHash`, `payload`,
  `payloadHash`, `eventHash` — because a consumer that re-derives the chain must
  hash exactly the bytes the engine hashed, and a projection would break
  re-derivation by construction. The concatenation of every page, in order, is
  the array `export` would have emitted and feeds `validateEventChain`
  unmodified. Every page carries the `workspaceId`, `version` and
  `headEventHash` anchors, so a consumer always knows which chain and which head
  it just read.
- **`CLI_EVENT_PAGE_OVERSIZED`**, the refusal for a page that does not fit. This
  is the one list verb whose records are verbatim, so page size is the payloads'
  business and a caller who raises `--limit` far enough will reach the ceiling.
  The default window is 64 — the engine's own segment size, roughly 100 KiB
  across the four live chains. A page that overflows is refused with the flag to
  lower named in the message, never silently shortened: a short page is
  indistinguishable from the end of the chain, which is the same
  absence-instead-of-refusal defect `0.7.0` was cut to fix. The code is
  deliberately distinct from the protocol's `INPUT_OVERSIZED` that `export`
  raises on the same ceiling, because the two leave the caller in different
  places — one with nowhere to go, one with a smaller window to ask for.

### Compatibility

Purely additive. No receipt changes shape, no flag becomes required, nothing was
removed or renamed, and `export` is untouched and still all-or-nothing.

## 0.7.0 — 2026-07-27

The read surface stops refusing to name things.

Two gaps were filed against this engine by its first cockpit consumer, and both
had the same shape: a read that works on a small chain and disappears on a large
one, in a way that looks like absence rather than refusal.

### Added

- **`externalKey` in `work-list` summaries.** `export` was the only read that
  carried the human-facing key, and it refuses any workspace whose canonical form
  exceeds one MiB — which two chains on the platform that filed this already do.
  A record id is a one-way digest of its key, so a consumer on the paginated path
  could render an entire work tree and name nothing in it. The one downstream
  reader resorted to re-deriving keys by brute-force digest match, which only
  works for conventionally-named records and leaves the rest permanently
  anonymous. The field the record already holds now travels with the summary.
- **`conference-position-list` and `conference-minutes-list`**, workspace-scoped
  and paginated like every other list. Before them, positions and minutes could
  be reached only through `export`, so on an oversized chain a deliberation
  holding fifteen arguments and one holding none rendered identically. The
  failure was not slow reading, it was absent reading presented as emptiness.

### Compatibility

`work-list` receipts gain a field. Consumers that compare whole canonical bodies
against a stored fixture will see the difference; consumers that read fields will
not. No verb was removed, renamed, or given a new required flag.

## 0.6.0 — 2026-07-26

Governed dual-host operator integration: pinned operator authority, a
host-neutral MCP surface, Codex installation and SessionStart activation,
bounded observe/execution receipts, and conference execution provenance. The
full narrative is `docs/releases/0.6.0.md`.

### Added

- **One pinned operator-authority contract for the remaining governed CLI
  surface.** An absolute-path plus SHA-256 pins document binds the authority
  bundle, generation floor, revocations, host observations, command allowlists,
  and every authority file consumed by the seven previously IO-only verbs.
- **`tcrn-workflow-mcp`, a host-neutral stdio JSON-RPC surface derived from the
  command catalog.** Mutations require an exact pinned grant and preserve
  numeric CAS, explicit time, actor, and stable reason-code semantics.
- **Codex install, uninstall, activation, observe, and execution-collection
  primitives.** Activation is persona-free, SessionStart-only, fail-open, and
  bound to the installer-admitted absolute handler path; every exact live
  definition still requires explicit host approval.
- **Conference execution provenance.** Execution mode, bounded host receipts,
  and fresh-context evidence distinguish synthesis from genuinely dispatched
  deliberation without turning attribution into identity.
- **Five-language root-document coverage and a machine-pinned translation
  policy**, plus a CJK-safe house style and release-time stale-mirror checks.

### Changed

- **Authority-bearing output is enforced at the CLI write boundary**, not
  trusted from catalog metadata alone; undeclared guarded output fails closed.
- **The command catalog and schema now carry the authority-bearing contract**
  used by both the CLI and MCP projection.
- **Activation hardening closes the audited path, digest, approval, rollback,
  and missing-settings gaps**, including canonical handling of a project with
  no existing `.claude/settings.json`.
- **The release dependency graph pins `fast-uri` to `3.1.4`**, closing the
  high-severity host-confusion advisory inherited through the development-only
  `ajv` toolchain.
- **Pull-request CI checks out the contributor head SHA**, so the privacy gate
  judges repository history rather than GitHub's synthetic merge commit, whose
  generated author metadata may contain an unreviewed private email address.

## 0.5.0 — 2026-07-24

The sprint / release-train mechanism: batch Initiatives into a named delivery
train and ship them together, without entangling the timebox axis with the
work-scope tree. The full narrative is `docs/releases/0.5.0.md`.

### Added

- **The `Release` work kind is open on the CLI create path**, enforced parentless
  in the graph validator: a sprint is a top-level batch container. `Review` and
  `Knowledge` stay closed.
- **`work-annotate --sprint`** attaches a member to a sprint via a `required:false`
  `advisory:sprint` extension whose value is a qualified `{workspaceId, workId}`
  reference to the sprint's Release record — cross-partition capable and
  non-binding. `work-show` surfaces it; `work-list --sprint` filters members.

### Changed

- **The advisory value-shape check now runs on `work.created` as well as
  `work.annotated`**, so a forged create cannot smuggle a malformed `advisory:*`
  value past the envelope-only graph validator (covers scope/decided-by/sprint).

## 0.4.0 — 2026-07-24

Background-resource residue governance: the machine-checkable half of a
convention that keeps a governed agent session from leaking the background loads
it spawns. The full narrative is `docs/releases/0.4.0.md`.

### Added

- **A host-neutral background-resource detector and registration face.** A pure
  core (`packages/core/src/background-resource.ts`) records the process **group**
  a session owns and, given a process-table snapshot, reports residue: any owned
  group with a live member, or any init-reparented / parent-absent orphan whose
  command matches a registered pattern. A thin host adapter
  (`scripts/spawn-guard.mjs`) reads the live table with the reaper's hardened
  `ps` invocation and stores the registry in the workspace transient zone,
  outside the engine control tree. Ships with a red-proof (guard `BR-01`/`BR-02`)
  that the injected orphan is always detected.
- **A host-wiring recipe** (`docs/architecture/background-resource-governance.md`)
  stating without overclaim that automatic session-end firing is Owner-gated on
  both hosts (Claude `Stop` is a signed ladder step; Codex is trust-gated).

## 0.3.2 — 2026-07-23

Knowledge-store curation headroom and the Incident create path. The full
narrative is `docs/releases/0.3.2.md`.

### Added

- **The CLI create path admits the `Incident` kind.** The protocol has carried
  eight work kinds since `0.1.0`, but `work-create` only opened the four
  planning kinds; a defect could therefore only be recorded as a `Story`.
  `Incident` is now creatable (with or without a parent), while `Review`,
  `Release`, and `Knowledge` stay closed to creation.

### Changed

- **The knowledge aggregate cap no longer double-charges the derived index.**
  The store index re-serializes the very metadata already counted, so the cap
  taxed every record roughly twice and a store of ~30 tiny records scanned at
  97% while holding almost no body content. The cap now bounds only the
  source-of-truth bytes (marker + Σ metadata + Σ body) across scan, create, and
  promotion; the index is still validated byte-for-byte.
- **Retiring a knowledge record reclaims its body.** A retired record's body is
  already unreadable, so retire now deletes it as its final durable step;
  retire frees bytes, not merely a live-record slot. A live record still
  requires its body, and the store stays valid without a retired one.
- **Knowledge search matches summaries, not only subject and tags**, so a
  curated card is findable by the substance in its summary.

Chains written under `0.3.1` replay unchanged.

## 0.3.1 — 2026-07-22

Release-machinery completion. The full narrative is `docs/releases/0.3.1.md`.

### Fixed

- **The P8 release pins missed the 0.3.0 version sweep.** `P8_VERSION` /
  `P8_TAG` in `scripts/lib/p8-workflow-rc.mjs` still said `0.2.0`, so the
  `v0.3.0` tree fails its own `verify:p8` with `P8_PACKAGE_VERSION_MISMATCH`
  and can never produce its release artifacts — which is why the `v0.3.0`
  GitHub Release carries no source tar, provenance, SBOM, or checksums. This
  release moves the pins (and registers the release notes in the proof route
  lists) so the P8 ceremony completes. No engine behaviour changes;
  `work-annotate` and every other verb are byte-for-byte the `0.3.0`
  behaviour.

## 0.3.0 — 2026-07-22

Advisory scope on the record. The full narrative is `docs/releases/0.3.0.md`.

### Added — a new additive operation, hence the minor bump

- **`work-annotate`**: attach non-binding advisory fields to a work record
  without changing its status. `--scope` records an authoritative scope/intent
  line; `--decided-by` backlinks the governing conference minutes. Both land as
  `required:false` extensions (`advisory:scope`, `advisory:decided-by`) — no
  registry row, they never gate a transition or block `done`. The engine appends
  a new `work.annotated` operation; a workspace that uses it is unreadable by a
  binary predating it (the WSD-1 additive-operation contract), while workspaces
  that never annotate stay byte-identical and `storageVersion` stays 1.
- **`work-show` advisory projection**: an annotated record surfaces its advisory
  fields under `advisory`; an un-annotated record's output is byte-identical to
  before.
- **Event-chain scaling advisory evidence**: the raw samples behind the README
  "Known limits" ceiling figures now ship at
  `docs/verification/2026-07-20-event-chain-ceiling-samples.json`, so the
  citation resolves in a standalone clone.

### Guarantees

- The reducer accepts a `work.annotated` event only if it changes exactly the
  advisory keys and nothing else. A forged annotation that smuggles a status
  change or a foreign extension fails closed `WORKSPACE_EVENT_CORRUPT` — pinned
  by three forge tests. Chains written under `0.2.0` replay unchanged.

## 0.2.0 — 2026-07-21

Gate identity. The full narrative is `docs/releases/0.2.0.md`.

### Changed — a behaviour change, hence the minor bump

- **Satisfying an `owner_intent_required` gate now requires an out-of-band
  roster and a named actor the roster permits.** On `0.1.0` anchoring minutes
  alone sufficed; the same transition without a roster now refuses with
  `WORKSPACE_GATE_IDENTITY_REQUIRED`, and an unpermitted actor with
  `WORKSPACE_GATE_IDENTITY_REFUSED`. The class is the per-gate opt-in; the
  other four outcome classes are unchanged. Chains written under `0.1.0`
  replay unchanged.

### Added

- **`gate-identity` module**: canonical roster document
  (`tcrn.gate-identity-authority.v1`), TOCTOU-hardened reader on the shared
  authority-file primitive, brand-guarded permission checks, and a
  self-contained decision record (`gate-identity:decision` in the gate's
  extensions) that replay shape-checks without ever re-reading the roster.
- **`gate-transition --identity-authority` / `--identity-authority-digest`**:
  the roster reaches the CLI as a stated pin.
- **Digest flags on six pins-track verbs** (`profile-resolve`,
  `profile-authorize`, `context-route`, `adapter-rollback-plan`,
  `claude-adapter-rollback-plan`, `claude-adapter-uninstall`): the caller
  states the digest it already holds; wrong digests stop at the digest; dual
  supply fails closed as `CLI_AUTHORITY_AMBIGUOUS`. Host-context verbs
  deliberately gained nothing.
- **Boundary section** `docs/architecture/agent-integration-v1.md` §9, its
  third statement pinned by a test that asserts replay accepts a forged
  tail-append.

### Fixed

- The recovery stress test demanded exactly one winner where the
  implementation promises at most one; the stronger assertion was the flake.
- Source lints (`LINT_EXPLICIT_ANY`, `LINT_EVAL`) judge code with comments and
  string literals blanked, instead of biting prose.
- Guard-check names the case that catches its two slowest mutations; the push
  gate runs in ~134s against ~205s.

## 0.1.0 — 2026-07-21

First accepted release. Everything below is relative to `0.1.0-rc.6`; the full
narrative is `docs/releases/0.1.0.md`.

### Added — evidence against a real host

- **`pnpm host-evidence`**: a productionised harness that observes the Claude
  Code activation ladder against a real host binary — eight credential-free
  group-A observations plus a credentialed group-B readback proving the
  injected authority summary reaches the model's context. Receipt:
  `docs/verification/host/claude-code.json` (Claude Code `2.1.201`).
- **Event-chain ceiling measurement**: single-command latency crosses one
  second around ~6,600 events (Apple M3, extrapolated); raw samples in
  `docs/verification/2026-07-20-event-chain-ceiling-samples.json`.
- **`canonicalDocumentBytes`**: the text-plus-trailing-newline byte contract
  gets a name; `canonicalJsonBytes` remains the release-trust signature basis.
- **Shared RFC 3339 corpus** pinning `parseStrictInstant` and
  `strictRfc3339Instant` to each other, accept and reject sides both.
- **`pnpm guard-check`**: reverting a registered guard and watching its named
  test go red is now a machine judgement over a 12-entry registry.

### Changed — documentation now states what was measured

- All five READMEs rewritten: measured activation status (live on Claude Code,
  no operator command path yet — `ADAPTER_HOST_REQUIRED` from a shell), a
  twelve-entry **Known limits** section, and a **Driver assumptions** group
  (integrity does not depend on the driving model; progress does).
- The recovery stress test asserts what the implementation promises — at most
  one winner plus liveness — instead of exactly-one, which a green rerun on
  identical bytes had shown to be over-claimed.
- CI actions pinned to v7 line; npm version updates are advisory-driven.

### Release

- Version `0.1.0`; `releaseStatus` moves from `unpublished_candidate` to
  `accepted_release`; the compatibility manifest still declares
  `supportedAosReleases: []` — no AOS pair, no connected mode.

## 0.1.0-rc.6 — 2026-07-19

### Fixed — data loss and permanent-lockout defects

- **Knowledge stores no longer brick on a rejected mutation.** `createKnowledgeUnit`
  and `rebaseKnowledgeStore` held the mutation claim across a failable region with
  no `finally`, so every failure that left the process alive leaked the claim and
  each later mutation answered `KNOWLEDGE_LOCKED` forever, with no verb able to
  clear it. A simulated crash still retains the claim, because a real SIGKILL never
  runs a `finally` and the retained claim is what marks the store mid-write; that
  exemption is now explicit and covered by a test in every mutation verb.
- **A crash during lease recovery no longer makes a Workspace unopenable.** The
  recovery claim recorded `pid` and `expiresAtNanoseconds` that nothing ever read,
  so `acquire` refused unconditionally on EEXIST. A claim is now reclaimed when it
  has expired *and* its pid is dead — the same probe the lease owner already used,
  and fail-closed in both directions of pid reuse. Malformed, linked, and
  special-file claims still fail closed.
- **`conference-append-position` no longer discards its author.** The core input
  reused one `actorId` slot for the position author and the attestation actor, so
  supplying `--actor` silently overwrote a required flag's value. The author is now
  its own field.

### Fixed — admission holes

- **Enum fields no longer admit values that merely coerce to a member.** Fourteen
  membership tests across protocol, the adapters, the Context Router, the Knowledge
  Core and the generic profile compared `String(value)` against the allowed list, so
  `["specified"]`, an object carrying `toString`, and a boxed `String` all passed.
  Numbers, `null`, and plain objects were always rejected — only those three shapes
  ever got through, and the negative cases now test exactly those.
- **`extension-registration.appliesTo` no longer accepts duplicate entries.** `Set`
  dedupe is identity-based, so two distinct `["work"]` arrays satisfied both the
  membership test and the duplicate test.

### Fixed — sandbox escapes

- **Six ways out of the offline guard and child-process policy are closed.** The
  guard patched CommonJS module objects only, so an ESM named import kept the
  original function; `net.Socket.prototype.connect`, `dns.promises`,
  `node:dns/promises` and `http2` were never patched at all. The child policy
  refused `stdio: "inherit"` only in that exact spelling, missing array, descriptor
  and stream forms, and `isNodeExecutable` never matched for `exec`, which takes a
  command line rather than an argv[0]. `execSync` and `execFileSync` were absent
  from the guarded API list entirely — the widest of the gaps, and one the original
  review did not name.

### Fixed — activation and installer

- **The settings rename is now the sole commit point of an activation install.**
  Two failable reads sat after it; either throwing left `settings.json` carrying a
  hook that pointed at a script the cleanup had just deleted, with the merge key
  blocking every retry and nothing able to restore the user's previous settings.
- **A concurrent `settings.json` edit is no longer overwritten in silence.** The
  merge was computed from a read taken before the bundle was written and applied
  wholesale; the bytes are now re-read and compared immediately before the commit.

### Performance

- **`verify:privacy` 56.6s to 2.4s (23.9x).** The object database was walked with
  two `spawnSync` git calls per object, roughly five thousand processes; it is now
  one `cat-file --batch-all-objects --batch` stream. `verify:p1` overall fell from
  133s to 81s. Scanned-entry and object counts are identical to the baseline.
- **`validateEventChain` no longer rebuilds every event twice** (392ms to 238ms on
  3000 1 KiB events), and `validateWorkGraph` validates the extension registry once
  per graph instead of once per record (559ms to 50ms on 5000 records against a
  64-entry registry).
- **Archive verbs no longer read every bundle only to discard it** — up to 512 MiB
  of I/O per store-resolving verb, for a partial-state check the surrounding lstat
  gates already answered.

### Changed — contracts and catalog

- Four `COMMAND_CATALOG` `valueKind` entries were wrong: `exchange-validate --bundle`
  is a path not JSON, both `adapter-simulate --lifecycle` flags are JSON not strings,
  and `profile-authorize --command` is a command id not JSON. An agent obeying the
  machine-readable contract would have failed on all four.
- `artifact-archive-apply` and `artifact-archive-restore` now declare
  `availability: "fixture-only"`. The spec always restricted them to `FIXTURE-`
  Workspaces — "the live local graph is therefore ineligible" — but the catalog did
  not say so, so an agent planning from it would schedule a verb designed to fail.
- `lease-recovery-break` and recovery-claim reporting in `lease-inspect` build the
  operator path `file-engine-v1.md` already promised; that spec clause is narrowed
  to match what the code now does.
- A malformed integer flag is now a syntax error naming the flag, not a semantic
  refusal. `--target-version abc` answered `WORKSPACE_MIGRATION_DOWNGRADE` with the
  message `"NaN"`; `--expected-revision`, `--stale-days`, and the knowledge
  `--limit`/`--offset` pair each handed their `NaN` to core and reported whatever
  judgement came back. All answer `CLI_ARGUMENT_MALFORMED` now. Every value that
  *is* an integer still reaches core, so no range or downgrade judgement moved —
  `--target-version 0` and `-1` are still core's call.
- A supplied-but-empty flag is no longer dropped on the floor. `--limit=` and
  `--segment-events=` were swallowed by a truthy guard and the verb answered as if
  the flag had been omitted; they now behave as the `0` they parse to.
- `work-list --parent-id null` finds the record `work-create --parent-id null`
  made. `work-create` accepted both sentinel spellings and `work-list` compared
  against only one, so an agent could create a root work item and never find it
  again with the identical spelling. That was a silent wrong answer.
- `docs/architecture/agent-integration-v1.md` gains a behaviour-delta section:
  seventeen observable changes since rc.5, two of which are admissions that used to
  succeed, and one of which changes retriability — an authority receipt that grows
  past its ceiling mid-read now reports a terminal limit code instead of the
  retriable `*_CHANGED`.

### Fixed — governance tooling

- `regen-rc1-inputs` treated every argument that was not `--check` as a request to
  write, so a typo silently rewrote the pinned RC1 proof basis. Unknown arguments
  now fail closed.
- Four dead release helpers and two dead `files.mjs` exports are retired. The
  `routeAdditions` prune this package also planned was attempted and reverted: the
  premise was verified circularly against the generator's own output, and the
  generator test proved the ledger still admits paths the declared set does not
  carry.
- Three type errors that made `workspace.ts` and the CLI uncompilable under a real
  `tsc` are fixed — `FileIdentity` was used eight times and declared nowhere, the
  CLI imported a `ProjectRecord` the protocol package never exported, and two
  parameters took their type from a default value. A first real `tsc` run reported
  147 errors across 14 files, not the 126 previously recorded and not the 167 an
  earlier draft of this entry claimed; both were estimates taken before a compiler
  was pinned. All 147 are now fixed, and the `typecheck` gate runs the pinned
  TypeScript 5.9.3 against the repository `tsconfig.json`, failing on any
  diagnostic. No type error is carried as debt.
- `pnpm push-gate` refuses a push whose version is announced inconsistently. This
  release cut advanced `package.json` and `FRAMEWORK_VERSION`, which `verify:p8`
  checks, and left the status badge in all five READMEs reading rc.5, which nothing
  checked — the gate exists for that class, the consequence of a change rather than
  the change itself. It runs `verify:p1` and `verify:p8`, treats any warning as a
  failure, and refuses a push whose version is already tagged at a different commit.
  It adds no `task.mjs` handler, no `verify:*` script, and no claim, so it is not a
  new gate under the proof-budget rule.

### Documentation

- Both READMEs lead with the problem rather than a capability inventory, and each
  names who the project is *not* for. All four translations are rebuilt from the
  corrected English.

- Make the replay complexity proof see the reducer's full-collection scans
  (CQ-10b). `materializeWorkspace` performs four scans inside its per-event loop
  — the whole work map on `work.deleted` and on `project.deleted`, the whole gate
  collection on a work transition to `done`, and full copies of the conference
  and minutes maps on a `gate.updated` to `satisfied` — and none of them
  incremented a counter the WSA-5 proof asserts on. New `collectionScan` and
  `collectionScanRecordsVisited` metrics count every one, and three new fixtures
  in `tests/p3-engine-complexity.test.mjs` (delete-bearing, done-transition,
  gate-satisfied) pin each arm's exact closed form. The existing append-only
  fixture now asserts zero scans. Behaviour is unchanged: counting only, replay
  bytes, record order, digests and reason codes are identical.
- Correct the P3 compaction-deferral proof, which stated "there is no quadratic
  term". That was false — the four scans above are quadratic terms. The document
  now names each arm, records the measured paired A/B (removing all four scans is
  4.0% of replay at the reachable ceiling, state byte-identical), and notes that
  the binding constraint is the 1 MiB canonical view-document limit reached at
  ~2,000–3,000 work records, not the 10,000-event cap.
- Decline OD-15 option 1 as measured: the four scans are retained rather than
  replaced by incrementally maintained indices. Three of them are fail-closed
  corruption checks, the shape that would exercise them is unreachable before the
  view-serialization limit bricks the workspace, and the measured upper bound on
  the whole change is 4%. The dominant replay cost is the one full replay per
  mutation (WSA-1, by design), which is roughly 40x larger.
- Unify the three drifted copies of the hardened authority-receipt reader onto a
  single shared implementation (`packages/core/src/authority-file-reader.ts`)
  carrying the strongest variant of each check: nanosecond `bigint` stat
  precision, `mode` in both the descriptor-identity recheck and the
  `sourceIdentityDigest`, a chunk-bounded read in place of an unbounded
  `readFile()`, `ELOOP` classified as a link rather than a generic change, and a
  guarded post-read `lstat` so unexpected filesystem errors can no longer escape
  untyped. Each caller keeps its own error class, reason-code family, post-read
  validator and admission branding; the shared reader takes an injected `fail`,
  a reason-code map and an `isOwnError` predicate. The Context Router and generic
  profile readers gain the mode, nanosecond, bounded-read and `ELOOP`
  protections they previously lacked.
- Normalise directory-as-authority reporting (OD-6): the Context Router and
  generic profile readers now report `CONTEXT_AUTHORITY_SPECIAL_FILE` and
  `PROFILE_ADMISSION_SPECIAL_FILE` for a directory, where they previously
  reported the `*_LINK` code because the `nlink` gate preceded the `isFile()`
  gate. Compatibility modes already reported the special-file code and is
  unchanged. `sourceIdentityDigest` values move for the Context Router and
  generic profile readers; the digest is derived from live inode data and was
  never reproducible across machines, checkouts or copies, so no stored value
  could have pinned it.

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
