# ADR 0003: Governed workspace relocation moves the binding, never the bytes

Status: accepted (WSR-1, `v0.9.0`)

Supersedes the **Restore constraint** paragraph of
`docs/adr/0002-snapshot-not-mirror-backup.md` (the paragraph beginning
"Restore constraint: same-path-only in V1"), and the matching doctrine 1 of
`docs/architecture/backup-restore-runbook.md`. It supersedes those paragraphs by
section reference rather than by silent contradiction, and it does not disturb
anything else either document says.

## Context

The engine binds five absolute roots and refuses to read a control tree whose
stored root identities disagree with the live filesystem. That refusal is
correct — it is what stops a stray copy from becoming a second source of truth —
and it is also what made a byte-identical copy on another machine unusable by
all three read verbs. There was no governed route through it, only around it: an
operator who needed to move a workspace hand-edited `roots`, and nothing anywhere
recorded that it had happened.

ADR 0002 said root rebinding needed the migration apply path V1 lacks. That was a
misattribution, and it was repeated in two documents. `OD-29` is the
manifest-scope decision — ADR 0002's own line says so — while the apply-path
deferral is `OD-7` and concerns storage-version-2 chain rewriting. Root rebinding
transforms no events, changes no `storageVersion`, and needs no apply path at
all. Event identity is `sha256` over `(schemaVersion, workspaceId, createdAt)`
and `(streamId, sequence)`; there is no path anywhere in it, so rebinding roots
invalidates exactly zero event hashes.

## Decision

Five CLI verbs, sequenced mechanically:

| Verb | Host | Effect |
| --- | --- | --- |
| `relocation-plan` | source | Read-only. Emits the hop's `relocationId` and its control manifest. |
| `relocation-vacate` | source | Its ONLY effect is to kill the source. |
| `relocation-adopt` | target | Binds the copied tree to this host. Idempotent. |
| `relocation-abort` | source | Revives the source from the ledger's own `from`. |
| `relocation-inspect` | either | Read-only. Compares ONE address against its own ledger. |

`relocation-plan` was added in the second cut, and it is not a convenience. Once a
permit names the exact `relocationId` (see *Authorization*), the operator needs a
route to that id that is guaranteed to be the one the vacate will take — so plan
and vacate share a single preparation function rather than deriving the id twice.
It also carries the control manifest out, which closes a trap the first cut
shipped: after the vacate commits, `snapshot-manifest` refuses the source with
`WORKSPACE_RELOCATION_VACATED` and the copy with
`WORKSPACE_RELOCATION_ADOPTION_REQUIRED`, so an operator who had not already saved
the manifest had no route to `relocation-adopt` at all — the only exit was abort,
which is the fork-creating verb.

**A relocation always moves the workspace root.** A hop that leaves it in place
while moving `framework`, `transient`, `evidence-locator` or `release-trust` is
refused at plan and vacate with `WORKSPACE_RELOCATION_INPUT_INVALID`. The reason is
structural rather than conservative: the state machine keys on the workspace root
and evaluates its `vacated` branch before its `adoption-required` branch, so such a
hop commits, kills the source, and can never be adopted. The first cut accepted it.
Moving a shared root while the workspaces stay put is a real operation; it is simply
not a relocation.

**The operator moves the bytes.** The engine gets no copy path. This is not an
oversight to be helpfully corrected later, so the refused alternatives are named
here so a later reader does not add them back:

- **`--copy` / `--destination`, an engine-side recursive copy.** Refused. ADR
  0002 already rejected a destination-writing verb by name. Such a verb is a
  general arbitrary-write primitive reachable by anyone holding the write grant,
  and `CONTRIBUTING.md` forbids a project command implicitly reaching the
  network, which a cross-host variant would need.
- **A chain event carrying the relocation.** Refused. An event would make the
  binding part of the hashed authority, which means the subordinate stores'
  high-water markers move, which means every relocation needs a knowledge rebase
  and an artifact rebase. The whole point is that nothing downstream moves.
- **Merging into `migration-*`.** Refused. Migration is about storage versions;
  this changes no `storageVersion` and rewrites no event.
- **An external relocation registry.** Refused. A registry can be lost,
  mismatched against the wrong tree, or replayed against a different one. The
  ledger travels inside the copied tree, so a later re-copy of a vacated source
  is born dead and a copy of an adopted target dropped back at the old path is
  dead too. Both directions fail safe; a registry has neither property.
- **A tombstone that replaces `workspace.json` wholesale.** Refused. A tombstone
  destroys the pre-vacate binding bytes, which makes `relocation-abort`
  impossible as a pure function of the tree — recovery would depend on an
  external certificate the operator may have lost. The append-only ledger keeps
  `from` forever, which is exactly what makes abort deterministic and local.

**The carrier** is an append-only `relocations` array added as a tenth,
**optional** field of `workspace.json`. `schemaVersion` stays `tcrn.workspace.v1`
and `storageVersion` stays `1`. Absent on every workspace that never relocates,
so those files stay byte-identical to `0.8.0` — absent, not empty, because
emitting `relocations: []` unconditionally would change every existing
workspace's digest and turn an additive change into a migration.

`roots` is **never rewritten.** It stays the original binding; the ledger says
where the tree lives now, and `activeBinding()` is the single accessor that
answers. Rewriting `roots` at adopt (which an earlier draft of this design
called for) makes the ledger self-invalidating: the first hop's `from` must equal
`roots` byte for byte, so overwriting `roots` breaks the very next read.

**The enforcement point is `readMetadata`, not `resolveWorkspace`.** That was
chosen on evidence, not style. `acquireWorkspaceLease`, `lease-break` and
`lease-recovery-break` never reach `resolveWorkspace`; placing the check there
leaves a vacated address with live lease-mutation paths. Moving the check to
`resolveWorkspace` and re-running the suite turns T1 and T3 red, which is the
measurement.

**Authorization** reuses the gate-identity pins-track shape: a per-invocation
authority file plus its digest on the command line, read through the same
TOCTOU-hardened reader. A permit names `actorId` **and** `workspaceIds` **and**
`destinations` **and** a `basis` of `{version, headEventHash}` **and** the exact
`relocationId` **and** the exact `stage` (`vacate` / `adopt` / `abort`). Each
scoping defends a different attack and none subsumes another: without
`workspaceIds` the roster permits everything while looking rigorous, and without
the `basis` an authority minted months ago is a standing grant wearing
per-invocation clothes.

**The last two scopes were added after an adversarial review measured the basis as
inert, and the correction is recorded rather than quietly folded in.** Relocation
does not advance the event chain — that is the whole point of the design — so
`{version, headEventHash}` is byte-identical after a hop as before it. The basis
therefore bounds DRIFT and cannot bound REUSE. One authority file drove
`vacate → adopt → abort` twice, with no tampering and every call returning a
success reason code, and left three addresses answering `status` as the live
authority for one `workspaceId`. A `relocationId` is derived over
`(workspaceId, sequence, from, to, basis)`, so a permit that names one authorizes
exactly one hop; the `stage` term narrows it to one verb of that hop, which is what
stops an abort riding the authority its own vacate was minted with.

The four older terms are retained rather than dropped as redundant, and the
residual-applicability reason is legibility: a human approving an authority file
must be able to read WHAT it permits, and an opaque 24-hex id is not that. They are
also independently authored, so a permit can name the right hop and the wrong
destination — a reachable operator error, and each term has its own red proof.
The ledger records only `{actorId, authorityFileSha256}` — never a file
reference, because a chain whose readability depends on an external file still
being present is a chain that bricks on a restore onto a fresh machine.

The three mutating verbs are **not** exposed on the MCP facade. An MCP grant is a
standing command list, and a standing grant to take over a workspace is exactly
what a per-invocation authority forbids. The exclusion is derived from the
catalog — any verb with a *required* `*-authority-digest` flag — rather than
hand-listed, because a list of command names goes stale in the permissive
direction. `relocation-inspect` is exposed.

## The two ceilings

These are in the body, not a footnote, because a reader who finds them in a test
comment will assume the mechanism is stronger than it is and will design the next
thing on top of that assumption.

**1. This is authorization, not authentication.** Nothing here proves who ran the
command. Same limit `gate-identity.ts` already states about itself.

**2. The ledger is deletable, and no single-sided test can go red on that.**
`workspace.json` is the one part of the control tree the event hash chain does
not cover. Anyone with write access to a vacated source can restore its
pre-vacate `workspace.json` in canonical bytes and the address is fully alive
again — reads, `validate`, `snapshot-manifest`, and writes. The engine cannot
detect this. Not "does not currently"; **cannot**. It is the same ceiling
`gate-identity.ts` states about gates: event hashes are unkeyed, so no
non-cryptographic replay check can distinguish a hand-authored self-consistent
document from a genuine one.

So: **this design does not prevent two truths. It makes them legible at the
addresses its ledger names.** An `aborted` at the source and an `adopted` at the
target sharing one `relocationId` is a permanent contradiction recorded in both
files. What it buys is real but bounded:

- destruction of the ledger becomes detectable **by the counterparty**, whose
  ledger permanently records `from` and the `relocationId`;
- bypass becomes non-accidental — no ordinary backup, restore, `rsync` or
  `recover` removes the ledger, and re-copying propagates it.

**A third claim stood here in the first cut and was false: that bypass now requires
deliberately destroying an artifact.** It does not. `relocation-abort` after the
destination adopted produces a fork with engine verbs only, destroying nothing, and
abort is the documented recovery verb. The source cannot know whether the
destination adopted; proving that negative is not available to an offline engine.
What abort costs now is three things, and none of them is a proof:

- a permit minted for THIS hop's `abort` stage — the vacate's own permit no longer
  carries it, which removes the "the operator already holds it" property that made
  the fork one command away;
- an explicit `--acknowledge-fork-risk`, which is a ceremony and is named as one;
- an optional `--target-inspection`: the destination's own `relocation-inspect`
  output, which the engine CHECKS and which refuses the abort with
  `WORKSPACE_RELOCATION_TARGET_ADOPTED` if the destination has adopted. Optional
  because the legitimate abort — the copy was never made, the destination host is
  unreachable — has no destination to inspect, and a requirement that cannot be met
  in the case it exists for gets routed around rather than obeyed. The receipt
  records `targetStateVerified` either way, and every later `relocation-inspect` at
  an aborted address carries the `forkRisk` statement.

**A fourth claim needed narrowing rather than replacing.** The two-sided compare is
not a fork DETECTOR; it is a fork detector for the two addresses the ledger names. A
third tree made by copying the control tree, deleting `relocations` and rewriting
`roots` is a fully live authority for the same chain, indistinguishable from a
workspace that never relocated, and named in no ledger. That is the pre-`0.9.0`
hand-edit hole restated — this design does not close it and does not claim to.

Two things follow and neither fully fixes it. First, **no single-sided assertion
that "the source is still dead" may be written.** It would be permanently true
and would give false comfort; this repository has been burned three times in one
day by predicates that could not fail. Second, **the two-sided
`relocation-inspect` comparison is binding gate evidence for closing any
relocation work item, not a runbook bullet.** It is the only instrument that can
detect a fork between the two addresses the ledger names, it requires both trees
present at once, and it is therefore by construction not in `verify` — which is precisely the shape this platform has
recorded as "a gate that is not in verify lives exactly one day."

That comparison is the weakest link in the whole design, and it is a human step.
Everything else here is machine-enforced and red-provable.

## Residual applicability (per `docs/harness-constraint-convention.md`)

This change narrows a published constraint: `packages/core/spec/file-engine-v1.md`
describes V1 metadata as immutable and its schema as closed. The old rule still
holds for **every field and every caller except the three relocation verbs**,
which become the sole writers of `relocations`. That is a conditional retention,
not a deletion, and it follows the WSD-1 precedent the codebase has already
absorbed twice: additive, `storageVersion` stays `1`, older binaries fail closed.

**The cost is irreversible and is accepted deliberately (OD-A).** After an adopt,
no pre-relocation engine can read the workspace at all: the tenth metadata field
fails `exactFields` with `WORKSPACE_SCHEMA_INVALID` on any `v0.8.0`-or-earlier
binary. The blast radius is one machine's installed copy, because the platform
pins one and verifies it every session — but it is one-way and it belongs in the
decision record rather than a footnote.

**Ledger cap: sixteen entries (OD-B).** Picked deliberately rather than left to
become an accidental constant. A workspace that has moved house sixteen times has
an operational problem a cap will not fix, and each entry carries ten root paths
in a file that is re-read on every workspace operation.

## Sequencing on a multi-partition platform (OD-D)

All four partitions on the TCRN platform share the same `framework` root and the
same `release-trust` root. Relocating one partition means the destination host
must also carry both, and physically **moving** either one bricks the other
three. A platform relocation is therefore an all-partitions operation with a
declared order, not four independent moves.

`relocation-vacate` requires all five destination roots to be stated rather than
just the workspace root, which is where that becomes visible; and
`relocation-inspect` reports `unmovedRoots` — the roots this hop leaves in place,
which must already exist at the destination. The engine cannot see other
partitions and this report does not claim it can.

## Consequences

`BK-SNAPSHOT-WITNESS` loses the clause asserting that a relocated restore raises
`WORKSPACE_SCHEMA_INVALID` as doctrine; the refusal itself is unchanged and still
tested (`WSF-3 case 10`, `WSR-1 T11`), but it is no longer the end of the story.
`BK-RELOCATION-BINDING` is added as a `runtime-capability` claim on the existing
`pnpm verify:backup` command — the proof-budget-exempt route, taken because it is
available rather than argued for on a narrow reading of the rule.
