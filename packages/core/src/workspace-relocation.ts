// SPDX-License-Identifier: Apache-2.0

// WSR-1: governed workspace relocation (root rebinding).
//
// Four verbs that move the BINDING, never the bytes. The event chain is untouched:
// event identity is sha256 over (schemaVersion, workspaceId, createdAt) and
// (streamId, sequence) — no path anywhere — so rebinding roots invalidates zero
// event hashes. The operator copies with OS tools. ADR 0002 rejected a
// destination-writing verb by name and ADR 0003 records the refusal again, because
// an engine-side recursive copy is a general arbitrary-write primitive reachable by
// anyone holding the write grant.
//
// FOUR ceilings this module CANNOT cross, stated here and in ADR 0003's body rather
// than in a test comment, because a reader who finds them in a test comment will
// assume the mechanism is stronger than it is. The general theorem the three
// adversarial reviews converged on: THIS MECHANISM CANNOT PREVENT A FORK. It can
// only make one legible. Every ceiling below is an instance of that.
//
//   * It delivers AUTHORIZATION, not AUTHENTICATION. Nothing here proves who ran
//     the command. Same limit gate-identity.ts already states about itself.
//   * workspace.json is the one part of the control tree the event hash chain does
//     not cover. Anyone with write access to a vacated source can restore its
//     pre-vacate workspace.json in canonical bytes and the address is fully alive
//     again. The engine cannot detect this — not "does not currently"; cannot. This
//     design does not PREVENT two truths; it makes them LEGIBLE, permanently, in
//     both files, under one shared relocationId.
//     The two-sided relocation-inspect comparison is the only instrument that can
//     see a fork AT THE TWO ADDRESSES THE LEDGER NAMES; a third address rebound by
//     hand is invisible to it and no close-out may claim otherwise. No single-sided
//     "the source is still dead" assertion may be written: it would be permanently
//     true and would give false comfort.
//   * THE ABORT-STAGE PERMIT IS A LEGIBILITY AND REVIEW DEVICE, NOT A BARRIER.
//     Whoever can mint the vacate permit can mint the abort permit; nothing here
//     authenticates a minter and nothing can observe WHEN a document was minted.
//     The stage term and the vacate-commitment binding below force the abort into a
//     SEPARATE document that names a value the vacate produced — so the two
//     approvals cannot be one approval, and the artifacts show two acts. That is
//     the whole of what they buy. An operator who intends to fork still forks, in
//     two acts instead of one, and that is expected rather than a defect.
//   * A PERMIT IS A PREDICATE OVER PRESENTED BYTES AT A PATH, NOT A TOKEN WITH A
//     SPEND RECORD. Every input to adopt is host-neutral (rootPortableIdentity is a
//     lowercased lexical path — no device, no inode, no host identity), and the only
//     record that a permit was spent is written INTO the copy the permit-holder
//     controls. Present one shipped vacated tree at the destination path on N hosts
//     and one adopt permit yields N simultaneously-live authorities for one
//     workspaceId, each with a valid `adopted` ledger under the same relocationId —
//     and the mandated two-sided compare PASSES AT EVERY ONE OF THEM. The same
//     holds for the vacate stage against a restored pre-vacate backup. No check
//     here can see it: it requires a host-identifying term the ledger does not
//     carry.
//
// Corrections landed after the first two adversarial reviews, all of which were
// live holes rather than documentation defects:
//
//   * ONE PERMIT AUTHORIZES ONE HOP-STAGE. The {version, headEventHash} basis alone
//     cannot bound reuse, because relocation never advances the chain: after a hop
//     the basis is byte-identical to what it was before, so a single authority file
//     drove an unbounded number of vacate/adopt/abort cycles and minted three
//     simultaneously-live authorities for one workspaceId with zero tampering. The
//     permit therefore also names the exact `relocationId` and the exact `stage`,
//     both of which the operator obtains from `relocation-plan` BEFORE minting. A
//     relocationId is derived over (workspaceId, sequence, from, to, basis), so it
//     cannot be satisfied by a DIFFERENT hop: the next hop has a different sequence
//     and a different control-manifest digest. It can be satisfied any number of
//     times by the same hop presented again — see the fourth ceiling.
//   * AN ABORT PERMIT CANNOT SHARE THE VACATE'S DOCUMENT. Abort after the target
//     adopted is the fork-creating move, and the source cannot know whether the
//     target adopted — proving that negative is not available to an offline engine.
//     The second review measured the stage term as insufficient on its own: one
//     document carrying [abort, adopt, vacate] for one hop is explicitly legal, so
//     the operator who ran the vacate was still holding the abort authority and the
//     fork was one flag away. An abort permit therefore also names
//     `vacateCommitmentSha256` — the sha256 of the committed `vacated` ledger entry,
//     which contains the sha256 of the authority file that authorized the vacate.
//     A document carrying both permits for one hop would have to contain a digest of
//     itself, so it is not constructible. This does not stop a second document being
//     minted afterwards (or ahead of time by an operator who computes the value);
//     see the third ceiling for what it actually buys.
//   * THE TARGET INSPECTION IS BOUNDED, NOT FRESH. It carries a caller-declared
//     `observedAt` and abort refuses one outside RELOCATION_TARGET_INSPECTION_WINDOW
//     of the abort's own `at`. Both instants are caller-supplied, so this is an
//     ordering and legibility device: it converts "a document captured before the
//     adopt is byte-identical to a fresh one" — which needed no intent at all — into
//     "the two instants must be stated and must agree", and it records the
//     document's own digest and declared instant in the receipt so a later reader
//     can check them against other records. An offline source still cannot learn
//     the destination's state at the moment it aborts; that check is TOCTOU by
//     construction and no version of it can be otherwise.

import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  assertProtocolId,
  assertStrictInstant,
  canonicalJson,
  compareCanonicalText,
} from "../../protocol/src/index.js";
import type { JsonValue } from "../../protocol/src/index.js";
import { readAuthorityFile } from "./authority-file-reader.js";
import type { AuthorityFileReasonCodes } from "./authority-file-reader.js";
import { assertDistinctRootShape, assertDistinctRoots, rootPortableIdentity } from "./root-identity.js";
import type { CanonicalRoot } from "./root-identity.js";
import {
  WORKSPACE_RELOCATION_ENTRY_VERSION,
  WORKSPACE_RELOCATION_LEDGER_LIMIT,
  acquireWorkspaceLease,
  activeBinding,
  assertSupportedWorkspaceFilesystem,
  deriveRelocationId,
  measureWorkspaceChainAt,
  readWorkspaceMetadataAt,
  relocationStateAt,
  validateWorkspace,
  workspaceControlPath,
  writeWorkspaceMetadataAt,
} from "./workspace.js";
import type {
  WorkspaceCrashPoint,
  WorkspaceMetadata,
  WorkspaceRelocationBasis,
  WorkspaceRelocationEntry,
} from "./workspace.js";
import {
  CONTROL_TREE_SKELETON_DIRECTORIES,
  CONTROL_TREE_TRANSPORT_RESIDUE_PATHS,
  createSnapshotManifest,
  verifySnapshotManifest,
} from "./workspace-snapshot.js";

export const WORKSPACE_RELOCATION_AUTHORITY_VERSION = "tcrn.workspace-relocation-authority.v1" as const;
export const WORKSPACE_RELOCATION_RECEIPT_VERSION = "tcrn.workspace-relocation-receipt.v1" as const;
export const WORKSPACE_RELOCATION_INSPECTION_VERSION = "tcrn.workspace-relocation-inspection.v1" as const;
export const WORKSPACE_RELOCATION_PLAN_VERSION = "tcrn.workspace-relocation-plan.v1" as const;

// New frozen sorted reason-code list owned by this module. The four STATE codes
// (VACATED / ADOPTION_REQUIRED / FOREIGN_ADDRESS / LEDGER_INVALID) deliberately do
// NOT live here: they are raised by validateMetadata, whose fail() is typed to
// WorkspaceReasonCode.
export const RELOCATION_REASON_CODES = Object.freeze([
  "WORKSPACE_RELOCATION_ABORT_COMPLETED",
  "WORKSPACE_RELOCATION_ADMISSION_REQUIRED",
  "WORKSPACE_RELOCATION_ADOPT_COMPLETED",
  "WORKSPACE_RELOCATION_ALREADY_ADOPTED",
  "WORKSPACE_RELOCATION_AUTHORITY_CANONICAL_INVALID",
  "WORKSPACE_RELOCATION_AUTHORITY_CHANGED",
  "WORKSPACE_RELOCATION_AUTHORITY_DIGEST",
  "WORKSPACE_RELOCATION_AUTHORITY_LINK",
  "WORKSPACE_RELOCATION_AUTHORITY_MALFORMED",
  "WORKSPACE_RELOCATION_AUTHORITY_PATH",
  "WORKSPACE_RELOCATION_AUTHORITY_REQUIRED",
  "WORKSPACE_RELOCATION_AUTHORITY_SPECIAL_FILE",
  "WORKSPACE_RELOCATION_BASIS_STALE",
  "WORKSPACE_RELOCATION_CHAIN_MISMATCH",
  "WORKSPACE_RELOCATION_CONTROL_TREE_INCOMPLETE",
  "WORKSPACE_RELOCATION_DESTINATION_UNRESOLVED",
  "WORKSPACE_RELOCATION_ID_MISMATCH",
  "WORKSPACE_RELOCATION_INPUT_INVALID",
  "WORKSPACE_RELOCATION_INSPECTED",
  "WORKSPACE_RELOCATION_INSPECTION_STALE",
  "WORKSPACE_RELOCATION_LEDGER_FULL",
  "WORKSPACE_RELOCATION_NOT_PENDING",
  "WORKSPACE_RELOCATION_NOT_PERMITTED",
  "WORKSPACE_RELOCATION_PLANNED",
  "WORKSPACE_RELOCATION_TARGET_ADOPTED",
  "WORKSPACE_RELOCATION_TRANSPORT_RESIDUE",
  "WORKSPACE_RELOCATION_UNSETTLED",
  "WORKSPACE_RELOCATION_VACATE_COMMITMENT_MISMATCH",
  "WORKSPACE_RELOCATION_VACATE_COMPLETED",
] as const);

export type RelocationReasonCode = typeof RELOCATION_REASON_CODES[number];

export class RelocationError extends Error {
  readonly reasonCode: RelocationReasonCode;
  // D5: one code at the protocol boundary, full detail in the payload. The operator
  // needs to know WHICH of five roots is wrong, and ROOT_PATH_SYMLINK,
  // ROOT_PATH_ALIAS, ROOT_PATH_COLLISION and ROOT_PATH_CONTAINMENT are four
  // completely different operator actions — but leaking a foreign module's reason
  // code out of a relocation verb breaks the frozen-per-module discipline.
  readonly rootReasonCode?: string;

  constructor(reasonCode: RelocationReasonCode, message: string, rootReasonCode?: string) {
    super(message);
    this.name = "RelocationError";
    this.reasonCode = reasonCode;
    if (rootReasonCode !== undefined) {
      this.rootReasonCode = rootReasonCode;
    }
  }
}

function fail(reasonCode: RelocationReasonCode, message: string): never {
  throw new RelocationError(reasonCode, message);
}

export const RELOCATION_LIMITS = Object.freeze({
  documentBytes: 65_536,
  permits: 256,
  scopeEntries: 64,
});

const ROOT_KIND_ORDER = Object.freeze(["framework", "workspace", "transient", "evidence-locator", "release-trust"] as const);

export type RelocationRootKind = typeof ROOT_KIND_ORDER[number];

export const RELOCATION_PERMIT_STAGES = Object.freeze(["abort", "adopt", "vacate"] as const);

export type RelocationPermitStage = typeof RELOCATION_PERMIT_STAGES[number];

const relocationPermitStages = new Set<string>(RELOCATION_PERMIT_STAGES);

export interface RelocationPermit {
  readonly actorId: string;
  readonly workspaceIds: readonly string[];
  readonly destinations: readonly string[];
  readonly basis: { readonly headEventHash: string | null; readonly version: number };
  // The two scopes added after the review that measured the basis as inert. Both are
  // obtained from `relocation-plan` before the authority is minted.
  readonly relocationId: string;
  readonly stage: RelocationPermitStage;
  // Present on `abort` permits and ONLY on those, because it is the one value that
  // does not exist until the vacate has committed. See relocationVacateCommitment.
  readonly vacateCommitmentSha256?: string;
}

export interface RelocationAuthorityDocument {
  readonly schemaVersion: typeof WORKSPACE_RELOCATION_AUTHORITY_VERSION;
  readonly permits: readonly RelocationPermit[];
}

export interface RelocationAuthorityFileIdentity {
  readonly expectedCanonicalPath: string;
  readonly expectedFileSha256: string;
}

export interface RelocationAuthorityContext {
  readonly document: RelocationAuthorityDocument;
  readonly sourcePath: string;
  readonly authorityFileSha256: string;
  readonly sourceIdentityDigest: string;
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("WORKSPACE_RELOCATION_AUTHORITY_MALFORMED", label);
  }
  return value as Readonly<Record<string, unknown>>;
}

function exact(value: Readonly<Record<string, unknown>>, fields: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(compareCanonicalText);
  const wanted = [...fields].sort(compareCanonicalText);
  if (actual.length !== wanted.length || wanted.some((field, index) => field !== actual[index])) {
    fail("WORKSPACE_RELOCATION_AUTHORITY_MALFORMED", label);
  }
}

// gate-identity.ts:111-119 precedent. Canonical order is REQUIRED rather than merely
// produced, so the same permission is always the same bytes and the same digest on
// both hosts — which is what lets host A and host B present the same authority from
// two different paths (T17).
function assertCanonicallySorted(values: readonly string[], label: string): void {
  for (let index = 1; index < values.length; index += 1) {
    const order = compareCanonicalText(values[index - 1] as string, values[index] as string);
    if (order > 0) fail("WORKSPACE_RELOCATION_AUTHORITY_MALFORMED", `${label} order`);
    if (order === 0) fail("WORKSPACE_RELOCATION_AUTHORITY_MALFORMED", `${label} duplicate`);
  }
}

function assertScopeList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > RELOCATION_LIMITS.scopeEntries) {
    fail("WORKSPACE_RELOCATION_AUTHORITY_MALFORMED", label);
  }
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      fail("WORKSPACE_RELOCATION_AUTHORITY_MALFORMED", `${label} member`);
    }
  }
  assertCanonicallySorted(value as readonly string[], label);
  return value as readonly string[];
}

export function validateRelocationAuthorityDocument(value: unknown): RelocationAuthorityDocument {
  const document = record(value, "relocation authority");
  exact(document, ["schemaVersion", "permits"], "relocation authority");
  if (document.schemaVersion !== WORKSPACE_RELOCATION_AUTHORITY_VERSION) {
    fail("WORKSPACE_RELOCATION_AUTHORITY_MALFORMED", "schemaVersion");
  }
  if (!Array.isArray(document.permits) || document.permits.length === 0 ||
    document.permits.length > RELOCATION_LIMITS.permits) {
    fail("WORKSPACE_RELOCATION_AUTHORITY_MALFORMED", "permits");
  }
  const permits = document.permits.map((entry, index) => {
    const permit = record(entry, `permits[${index}]`);
    // D6: BOTH scopings. workspaceIds stops an authority for workspace X moving
    // workspace Y; the basis stops an authority minted months ago being replayed
    // against a chain that has since advanced. Neither subsumes the other, and
    // WITHOUT workspaceIds the roster permits everything while looking rigorous —
    // which is exactly the permanently-green-gate failure class this repository was
    // burned by three times in one day. Guard G3 drops the check; T14(c) is the
    // test that must go red.
    // The field set is stage-dependent, and both directions of that are refusals:
    // an `abort` permit WITHOUT vacateCommitmentSha256 is malformed, and a `vacate`
    // or `adopt` permit WITH it is malformed too. The second half matters as much as
    // the first — an optional field that nothing rejects when misplaced is how a
    // reader concludes the binding applies to stages where it does not.
    const stagedFields = permit.stage === "abort"
      ? ["actorId", "workspaceIds", "destinations", "basis", "relocationId", "stage", "vacateCommitmentSha256"]
      : ["actorId", "workspaceIds", "destinations", "basis", "relocationId", "stage"];
    exact(permit, stagedFields, `permits[${index}]`);
    try {
      assertProtocolId(permit.actorId);
    } catch {
      fail("WORKSPACE_RELOCATION_AUTHORITY_MALFORMED", `permits[${index}].actorId`);
    }
    const workspaceIds = assertScopeList(permit.workspaceIds, `permits[${index}].workspaceIds`);
    for (const workspaceId of workspaceIds) {
      if (!/^workspace:[a-f0-9]{24}$/u.test(workspaceId)) {
        fail("WORKSPACE_RELOCATION_AUTHORITY_MALFORMED", `permits[${index}].workspaceIds member`);
      }
    }
    const destinations = assertScopeList(permit.destinations, `permits[${index}].destinations`);
    for (const destination of destinations) {
      if (!isAbsolute(destination) || resolve(destination) !== destination) {
        fail("WORKSPACE_RELOCATION_AUTHORITY_MALFORMED", `permits[${index}].destinations member`);
      }
    }
    const basis = record(permit.basis, `permits[${index}].basis`);
    exact(basis, ["headEventHash", "version"], `permits[${index}].basis`);
    if (!(basis.headEventHash === null || (typeof basis.headEventHash === "string" && /^[a-f0-9]{64}$/u.test(basis.headEventHash))) ||
      !Number.isSafeInteger(basis.version) || Number(basis.version) < 0) {
      fail("WORKSPACE_RELOCATION_AUTHORITY_MALFORMED", `permits[${index}].basis`);
    }
    if (typeof permit.relocationId !== "string" || !/^relocation:[a-f0-9]{24}$/u.test(permit.relocationId)) {
      fail("WORKSPACE_RELOCATION_AUTHORITY_MALFORMED", `permits[${index}].relocationId`);
    }
    if (typeof permit.stage !== "string" || !relocationPermitStages.has(permit.stage)) {
      fail("WORKSPACE_RELOCATION_AUTHORITY_MALFORMED", `permits[${index}].stage`);
    }
    if (permit.stage === "abort" &&
      (typeof permit.vacateCommitmentSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(permit.vacateCommitmentSha256))) {
      fail("WORKSPACE_RELOCATION_AUTHORITY_MALFORMED", `permits[${index}].vacateCommitmentSha256`);
    }
    return Object.freeze({
      actorId: permit.actorId as string,
      workspaceIds: Object.freeze([...workspaceIds]),
      destinations: Object.freeze([...destinations]),
      basis: Object.freeze({ headEventHash: basis.headEventHash as string | null, version: basis.version as number }),
      relocationId: permit.relocationId,
      stage: permit.stage as RelocationPermitStage,
      ...(permit.stage === "abort" ? { vacateCommitmentSha256: permit.vacateCommitmentSha256 as string } : {}),
    });
  });
  // The ordering key is the whole permit identity, not the actor alone: one hop
  // legitimately needs a `vacate` and an `adopt` permit under one actor, so an
  // actor-only key would reject the honest document and admit nothing else. A
  // protocol id contains no space, so the join is unambiguous.
  //
  // An `abort` permit for the same hop remains REPRESENTABLE here and is not
  // syntactically rejected — it is simply not satisfiable, because its
  // vacateCommitmentSha256 would have to be a digest of the file it sits in. That
  // separation is enforced by arithmetic in abortWorkspaceRelocation rather than by a
  // rule in this function, and it is stated here so the next reader does not add a
  // redundant syntactic ban and conclude the ban is what does the work.
  assertCanonicallySorted(permits.map((permit) => `${permit.actorId} ${permit.relocationId} ${permit.stage}`), "permits");
  return Object.freeze({ schemaVersion: WORKSPACE_RELOCATION_AUTHORITY_VERSION, permits: Object.freeze(permits) });
}

const relocationContexts = new WeakSet<object>();

const relocationAuthorityCodes: AuthorityFileReasonCodes<RelocationReasonCode> = Object.freeze({
  required: "WORKSPACE_RELOCATION_AUTHORITY_REQUIRED",
  path: "WORKSPACE_RELOCATION_AUTHORITY_PATH",
  digest: "WORKSPACE_RELOCATION_AUTHORITY_DIGEST",
  changed: "WORKSPACE_RELOCATION_AUTHORITY_CHANGED",
  link: "WORKSPACE_RELOCATION_AUTHORITY_LINK",
  specialFile: "WORKSPACE_RELOCATION_AUTHORITY_SPECIAL_FILE",
  limitExceeded: "WORKSPACE_RELOCATION_AUTHORITY_MALFORMED",
  notUtf8: "WORKSPACE_RELOCATION_AUTHORITY_MALFORMED",
  notJson: "WORKSPACE_RELOCATION_AUTHORITY_MALFORMED",
  notCanonical: "WORKSPACE_RELOCATION_AUTHORITY_CANONICAL_INVALID",
});

// THE DIGEST IS THE BINDING. An earlier version of this comment said
// readAuthorityFile "requires path === expectedCanonicalPath, so the file is bound to
// a path on the host reading it", which is not a property this route can have: the
// CLI builds `expectedCanonicalPath` from the very same `--relocation-authority`
// argument it passes as `path` (cli/index.ts suppliedAuthority), so that predicate
// compares an argument with itself and can never fire. What the reader does provide
// is absoluteness, lexical canonicality, realpath identity, single-link regularity
// and the content digest — anti-symlink and anti-alias hardening, not a host pin.
// That is also exactly why T17 works: the same bytes at two host paths carry one
// digest and both read clean. A caller wanting a genuine host-path pin has to get it
// from somewhere other than the argument being checked.
export async function readRelocationAuthority(
  path: string,
  authority?: RelocationAuthorityFileIdentity,
): Promise<RelocationAuthorityContext> {
  const source = await readAuthorityFile(path, authority, {
    maximumBytes: RELOCATION_LIMITS.documentBytes,
    codes: relocationAuthorityCodes,
    details: {
      required: "Out-of-band workspace relocation authority is required",
      expectedDigest: path,
    },
    fail,
    isOwnError: (error) => error instanceof RelocationError,
  });
  const context = Object.freeze({
    document: validateRelocationAuthorityDocument(source.parsed),
    sourcePath: path,
    authorityFileSha256: source.fileSha256,
    sourceIdentityDigest: source.sourceIdentityDigest,
  });
  relocationContexts.add(context);
  return context;
}

// The brand is not the trust anchor — the digest is. It exists so a caller cannot
// hand the permission check an object it assembled itself.
function admitted(value: unknown): RelocationAuthorityContext {
  if (typeof value !== "object" || value === null || !relocationContexts.has(value)) {
    fail("WORKSPACE_RELOCATION_ADMISSION_REQUIRED", "Descriptor-bound relocation authority is required");
  }
  return value as RelocationAuthorityContext;
}

// Six terms, every one of them independently authored in the document and therefore
// independently able to disagree with the hop in front of it. `relocationId` and
// `stage` are what bound REUSE (one permit, one hop, one verb); the other four stay
// because a human approving the file must be able to read what it permits, and a
// typed destination that disagrees with the id is a real, reachable operator error
// rather than a decorative restatement. T14(c)-(g) prove each term separately.
function matchPermit(
  context: RelocationAuthorityContext,
  actorId: string,
  workspaceId: string,
  destination: string,
  relocationId: string,
  stage: RelocationPermitStage,
): RelocationPermit {
  const permit = admitted(context).document.permits.find((entry) =>
    entry.actorId === actorId && entry.workspaceIds.includes(workspaceId) && entry.destinations.includes(destination) &&
    entry.relocationId === relocationId && entry.stage === stage);
  if (permit === undefined) {
    fail(
      "WORKSPACE_RELOCATION_NOT_PERMITTED",
      `${actorId} holds no ${stage} permit for ${workspaceId} to ${destination} as ${relocationId}`,
    );
  }
  return permit;
}

// The CAS. An authority minted for "move this workspace as of version 549 / head
// abc…" cannot be replayed months later against a chain that has moved on.
//
// On its own this bounds DRIFT, not REUSE: relocation never advances the chain, so
// after a hop the basis is unchanged and a permit whose only per-invocation scope
// was this tuple could be spent again. That is what the relocationId scope closes.
// This check remains load-bearing because the document states the basis separately
// from the id, so a permit can name the right hop and the wrong vintage.
function assertPermitBasis(permit: RelocationPermit, version: number, headEventHash: string | null): void {
  if (permit.basis.version !== version || permit.basis.headEventHash !== headEventHash) {
    fail(
      "WORKSPACE_RELOCATION_BASIS_STALE",
      `authority basis version=${String(permit.basis.version)} head=${String(permit.basis.headEventHash)} does not match version=${String(version)} head=${String(headEventHash)}`,
    );
  }
}

export function canonicalRelocationAuthority(document: RelocationAuthorityDocument): string {
  return canonicalJson(validateRelocationAuthorityDocument(document));
}

/**
 * THE VACATE COMMITMENT: the sha256 of the committed `vacated` ledger entry in its
 * canonical bytes. An `abort` permit must name it, and that is the only thing here
 * that a same-document pre-mint cannot satisfy.
 *
 * Why it works, stated as arithmetic rather than as a promise: the entry contains
 * `authority.authorityFileSha256` — the digest of the file that authorized the
 * vacate. An authority document carrying an `abort` permit for the hop its own
 * `vacate` permit authorizes would therefore have to contain a digest of itself.
 *
 * Why it is NOT a barrier, stated in the same breath: a SECOND document minted after
 * the vacate satisfies it trivially, and so does one minted beforehand by an operator
 * who finalizes the vacate document first, hashes it, and computes this value from the
 * plan output plus the instant they intend to pass. Both are two documents and two
 * approvals rather than one, which is the entire gain. See the third ceiling in the
 * module header.
 *
 * The value travels in the vacate receipt and in `relocation-inspect` at the vacated
 * address, so abort stays a pure function of the tree even when every receipt is lost
 * (T13).
 */
export function relocationVacateCommitment(entry: WorkspaceRelocationEntry): string {
  return createHash("sha256").update(canonicalJson(entry as unknown as JsonValue), "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Destination declaration
// ---------------------------------------------------------------------------

/**
 * The five destination roots, declared at VACATE.
 *
 * Deviation from the synthesised design, recorded deliberately: the design gave
 * vacate only `--to-workspace-root` while giving adopt all five. That cannot work —
 * the ledger entry carries five `to` roots and the chaining rule compares the whole
 * array, so four of them would have to be silently inherited from `from` and a real
 * cross-host move (where the framework root differs) would be unrepresentable.
 * Declaring all five at the terminal verb is also the mechanical form of the OD-D
 * warning: on this platform all four partitions share one `framework` root and one
 * `release-trust` root, and physically moving either one bricks the other three.
 * Making the operator state where all five go is where that becomes visible.
 */
export interface RelocationDestination {
  readonly framework: string;
  readonly workspace: string;
  readonly transient: string;
  readonly "evidence-locator": string;
  readonly "release-trust": string;
}

// The declared destination is asserted-canonical, not measured: it is on another
// host. `to` therefore carries canonicalPath === path, and adopt refuses unless the
// target's own realpath agrees.
function declaredDestinationRoots(destination: RelocationDestination): readonly CanonicalRoot[] {
  const roots: CanonicalRoot[] = [];
  for (const kind of ROOT_KIND_ORDER) {
    const path = destination[kind];
    if (typeof path !== "string" || path.length === 0 || !isAbsolute(path) || resolve(path) !== path) {
      fail("WORKSPACE_RELOCATION_INPUT_INVALID", `destination ${kind} must be an absolute canonical path`);
    }
    roots.push({ kind, path, canonicalPath: path, portableIdentity: rootPortableIdentity(path) });
  }
  // The shape half, at the input boundary. Without it a destination whose roots
  // collide or nest is refused only at the very end by the LEDGER validator, which
  // reports `relocations[4].to: …` for a command line the operator typed as flags —
  // a ledger-integrity code for an operator input error, after a lease has been
  // taken and a whole control-tree manifest computed.
  try {
    assertDistinctRootShape(roots);
  } catch (error) {
    throw new RelocationError(
      "WORKSPACE_RELOCATION_INPUT_INVALID",
      `the declared destination roots are not distinct: ${String((error as { message?: string }).message ?? error)}`,
      typeof (error as { reasonCode?: string }).reasonCode === "string" ? (error as { reasonCode: string }).reasonCode : undefined,
    );
  }
  return roots;
}

// The containment rule the five-root shape check cannot see: it compares the five
// roots of ONE binding against each other, never `from` against `to`. A destination
// nested inside the source workspace root relocates cleanly and then leaves the only
// live control tree inside the directory the runbook's next step tells the operator
// to delete.
function assertDisjointFromSource(fromWorkspace: string, toWorkspace: string): void {
  const left = rootPortableIdentity(fromWorkspace);
  const right = rootPortableIdentity(toWorkspace);
  if (left === right) {
    // A hop that does not move the workspace root is not representable: the whole
    // state machine keys on that root, and its `vacated` branch is tested before its
    // `adoption-required` branch, so such a hop commits, kills the source and can
    // NEVER be adopted. Refuse it here, where the source is still alive. A move of
    // the shared framework or release-trust root with the workspaces staying put is
    // a real operation — it is simply not a relocation, and ADR 0003 says so.
    fail(
      "WORKSPACE_RELOCATION_INPUT_INVALID",
      "a relocation must move the workspace root; a hop that leaves it in place is unadoptable by construction",
    );
  }
  const leftToRight = relative(left, right);
  const rightToLeft = relative(right, left);
  const contains = (value: string): boolean => value !== "" && !value.startsWith("..") && !value.startsWith(sep);
  if (contains(leftToRight) || contains(rightToLeft)) {
    fail(
      "WORKSPACE_RELOCATION_INPUT_INVALID",
      "the destination workspace root and the source workspace root overlap by containment",
    );
  }
}

// ---------------------------------------------------------------------------
// Control-tree assertions the manifest is structurally blind to
// ---------------------------------------------------------------------------

async function assertControlTreeSkeleton(workspaceRoot: string): Promise<void> {
  for (const name of CONTROL_TREE_SKELETON_DIRECTORIES) {
    const path = workspaceControlPath(workspaceRoot, name);
    let metadata;
    try {
      metadata = await lstat(path);
    } catch {
      fail("WORKSPACE_RELOCATION_CONTROL_TREE_INCOMPLETE", `${name}/ is missing from the copied control tree`);
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      fail("WORKSPACE_RELOCATION_CONTROL_TREE_INCOMPLETE", `${name}/ is not a real directory`);
    }
  }
}

async function assertNoTransportResidue(workspaceRoot: string): Promise<void> {
  for (const relativePath of CONTROL_TREE_TRANSPORT_RESIDUE_PATHS) {
    const path = workspaceControlPath(workspaceRoot, relativePath);
    let present = true;
    try {
      await lstat(path);
    } catch {
      present = false;
    }
    if (present) {
      fail(
        "WORKSPACE_RELOCATION_TRANSPORT_RESIDUE",
        `${relativePath} was carried across by the copy; the snapshot manifest excludes it by design and cannot see it`,
      );
    }
  }
}

// Checked at VACATE, where `recover` can still fix it — not at adopt, where it
// cannot. The backup runbook already prescribes recover-then-validate before a copy.
async function assertSettled(workspaceRoot: string): Promise<void> {
  for (const directoryName of ["events", "views"]) {
    const directory = workspaceControlPath(workspaceRoot, directoryName);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".tmp-")) {
        fail(
          "WORKSPACE_RELOCATION_UNSETTLED",
          `${directoryName}/${entry.name} is atomic-write residue; run recover before relocating`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

export interface RelocationReceipt extends Readonly<Record<string, JsonValue>> {
  readonly schemaVersion: typeof WORKSPACE_RELOCATION_RECEIPT_VERSION;
  readonly reasonCode: string;
}

function receipt(reasonCode: RelocationReasonCode, entry: WorkspaceRelocationEntry, extra: Readonly<Record<string, JsonValue>> = {}): RelocationReceipt {
  return Object.freeze({
    schemaVersion: WORKSPACE_RELOCATION_RECEIPT_VERSION,
    reasonCode,
    relocationId: entry.relocationId,
    sequence: entry.sequence,
    stage: entry.stage,
    at: entry.at,
    workspaceRootFrom: entry.from.find((root) => root.kind === "workspace")?.canonicalPath ?? "",
    workspaceRootTo: entry.to.find((root) => root.kind === "workspace")?.canonicalPath ?? "",
    basis: { ...entry.basis },
    authority: { ...entry.authority },
    ...extra,
  }) as RelocationReceipt;
}

// THE CAP AND ITS PARITY INVARIANT, stated because the review asked whether a vacate
// can be admitted into a ledger with no room left for its own completion — which
// would brick the chain permanently (source VACATED, target ADOPTION_REQUIRED, both
// completions LEDGER_FULL).
//
// It cannot, and the reason is parity, not luck: every completion (`adopted` or
// `aborted`) follows exactly one `vacated`, so a SETTLED ledger always has even
// length. A hop therefore starts at an even length <= 14 and reaches at most 16. A
// vacate at 16 is refused here while the source is still alive (T26), and an odd
// settled length is not reachable through any verb.
//
// A `+ 2` reservation at the vacate side was considered and deliberately NOT added:
// under this invariant it can never be the predicate that fires, and a check that
// cannot fire is the failure mode this module refuses elsewhere (see the t22 note in
// adopt). If a future stage ever appends without a paired completion, the invariant
// dies and the reservation becomes the correct fix — that is the trigger to watch.
function withRelocations(metadata: WorkspaceMetadata, entries: readonly WorkspaceRelocationEntry[]): WorkspaceMetadata {
  if (entries.length > WORKSPACE_RELOCATION_LEDGER_LIMIT) {
    fail("WORKSPACE_RELOCATION_LEDGER_FULL", `the ledger cap is ${String(WORKSPACE_RELOCATION_LEDGER_LIMIT)} entries`);
  }
  return { ...metadata, relocations: entries };
}

function trailingEntry(metadata: WorkspaceMetadata): WorkspaceRelocationEntry | undefined {
  const entries = metadata.relocations ?? [];
  return entries[entries.length - 1];
}

// ---------------------------------------------------------------------------
// relocation-vacate
// ---------------------------------------------------------------------------

export interface PlanOptions {
  readonly at: string;
  readonly destination: RelocationDestination;
  readonly expectedVersion: number;
}

export interface VacateOptions extends PlanOptions {
  readonly actorId: string;
  readonly authority: RelocationAuthorityContext;
  readonly crashAt?: WorkspaceCrashPoint;
}

interface PreparedRelocation {
  readonly lease: Awaited<ReturnType<typeof acquireWorkspaceLease>>;
  readonly root: string;
  readonly metadata: WorkspaceMetadata;
  readonly from: readonly CanonicalRoot[];
  readonly to: readonly CanonicalRoot[];
  readonly destinationWorkspace: string;
  readonly basis: WorkspaceRelocationBasis;
  readonly controlManifest: string;
  readonly sequence: number;
  readonly relocationId: string;
  readonly version: number;
  readonly headEventHash: string | null;
}

/**
 * Everything `relocation-vacate` computes before it decides anything — shared with
 * `relocation-plan` SO THAT THEY CANNOT DISAGREE. The plan verb exists because the
 * permit now names the relocationId, and an operator who derived that id by a second
 * route would be minting an authority for a hop the engine is not about to take.
 *
 * The caller owns the returned lease and must release it.
 */
async function prepareRelocation(workspaceRootInput: string, options: PlanOptions): Promise<PreparedRelocation> {
  assertStrictInstant(options.at);
  const to = declaredDestinationRoots(options.destination);
  const destinationWorkspace = to.find((root) => root.kind === "workspace")?.canonicalPath ?? "";

  const preview = await readWorkspaceMetadataAt(workspaceRootInput, "live");
  const from = activeBinding(preview.metadata);
  const sourceWorkspace = from.find((root) => root.kind === "workspace")?.canonicalPath ?? "";
  // This replaces the earlier "all five roots identical" refusal rather than joining
  // it. That check could only fire in a state this one already refuses (five
  // identical roots implies an identical workspace root), and a predicate that can
  // never be the one that fires is the shape this module refuses elsewhere.
  assertDisjointFromSource(sourceWorkspace, destinationWorkspace);

  // THE CAP, EVALUATED IN THE SHARED PREPARATION. It used to live only in
  // `withRelocations`, which no read-only verb reaches, so `relocation-plan` answered
  // WORKSPACE_RELOCATION_PLANNED at a full ledger and handed the operator a
  // relocationId for a hop the vacate would refuse — after which the operator
  // performed the out-of-band minting ceremony (the expensive, owner-involving step
  // the plan verb exists to feed) for a hop that was impossible. That was the one
  // reachable state in which plan and vacate disagreed, which is the exact property
  // this shared function was introduced to guarantee. The check at the commit point
  // is kept as the backstop it always was.
  const existingEntries = (preview.metadata.relocations ?? []).length;
  if (existingEntries + 1 > WORKSPACE_RELOCATION_LEDGER_LIMIT) {
    fail("WORKSPACE_RELOCATION_LEDGER_FULL", `the ledger cap is ${String(WORKSPACE_RELOCATION_LEDGER_LIMIT)} entries`);
  }

  const lease = await acquireWorkspaceLease(preview.root, { now: options.at });
  try {
    // v3 runs FIRST, ahead of the validate. Found by the T10 fixture: a stray
    // .tmp- under events/ makes readSegmentEvents refuse the whole chain
    // (WORKSPACE_EVENT_CORRUPT) before any relocation code is reached, so a
    // settle check placed after the validate could never be the check that fires.
    // Refusing here is also what lets the message name `recover` as the fix.
    await assertSettled(preview.root);

    // v2: view-verified, then the CAS.
    const state = await validateWorkspace(preview.root);
    if (!Number.isSafeInteger(options.expectedVersion) || options.expectedVersion !== state.version) {
      fail("WORKSPACE_RELOCATION_BASIS_STALE", `expected=${String(options.expectedVersion)} actual=${String(state.version)}`);
    }

    // Quarantine residue is refused for free by RESIDUE_PREFIX inside the manifest
    // build below.

    // v4
    const controlManifest = await createSnapshotManifest(preview.root, lease);
    const basis: WorkspaceRelocationBasis = {
      controlManifestSha256: createHash("sha256").update(controlManifest, "utf8").digest("hex"),
      headEventHash: state.headEventHash,
      version: state.version,
    };
    const sequence = (preview.metadata.relocations ?? []).length + 1;
    // v5: derived, never random. No clock.
    return {
      lease,
      root: preview.root,
      metadata: preview.metadata,
      from,
      to,
      destinationWorkspace,
      basis,
      controlManifest,
      sequence,
      relocationId: deriveRelocationId({ workspaceId: state.metadata.workspaceId, sequence, from, to, basis }),
      version: state.version,
      headEventHash: state.headEventHash,
    };
  } catch (error) {
    await lease.release();
    throw error;
  }
}

/**
 * Read-only. Emits the relocationId the vacate WOULD take, plus the control manifest
 * text the adopt will require — the two artifacts an operator cannot obtain any other
 * way once the vacate has run, and the two the authority document must now name.
 */
export async function planWorkspaceRelocation(
  workspaceRootInput: string,
  options: PlanOptions,
): Promise<Readonly<Record<string, JsonValue>>> {
  const prepared = await prepareRelocation(workspaceRootInput, options);
  try {
    return Object.freeze({
      schemaVersion: WORKSPACE_RELOCATION_PLAN_VERSION,
      reasonCode: "WORKSPACE_RELOCATION_PLANNED",
      workspaceId: prepared.metadata.workspaceId,
      relocationId: prepared.relocationId,
      sequence: prepared.sequence,
      workspaceRootFrom: prepared.from.find((root) => root.kind === "workspace")?.canonicalPath ?? "",
      workspaceRootTo: prepared.destinationWorkspace,
      basis: { ...prepared.basis },
      permitStages: [...RELOCATION_PERMIT_STAGES],
      // THE BUDGET, REPORTED BEFORE IT IS SPENT. The cap is consumed by ATTEMPTS, not
      // by moves: a vacate plus an abort costs two entries and moves nothing, so eight
      // abandoned attempts end this workspace's ability to relocate by any governed
      // route, permanently. There is no compaction verb and there deliberately is not
      // one — see ADR 0003's ledger-cap section. An operator who can see the number
      // fall can at least plan against it instead of discovering the wall after the
      // minting ceremony.
      hopsRemaining: Math.floor((WORKSPACE_RELOCATION_LEDGER_LIMIT - prepared.sequence + 1) / 2),
      ledgerEntriesRemaining: WORKSPACE_RELOCATION_LEDGER_LIMIT - prepared.sequence + 1,
      controlManifest: prepared.controlManifest,
    });
  } finally {
    await prepared.lease.release();
  }
}

/**
 * Its ONLY effect is to kill the source. It does not copy, does not reach the
 * target, and does not advance the chain.
 */
export async function vacateWorkspace(workspaceRootInput: string, options: VacateOptions): Promise<RelocationReceipt> {
  try {
    assertProtocolId(options.actorId);
  } catch {
    fail("WORKSPACE_RELOCATION_INPUT_INVALID", "actorId");
  }
  // v0: the permit tuple can no longer be checked before the lease, and the trade is
  // deliberate. The permit names the relocationId, which is derived from the control
  // manifest, which only exists under the lease. What the pre-lease position actually
  // protected — a FILESYSTEM refusal holding a workspace lock — is unchanged: the
  // authority file is read, digest-checked and parsed by the caller before any engine
  // verb is entered (T16).
  const prepared = await prepareRelocation(workspaceRootInput, options);
  try {
    const permit = matchPermit(
      options.authority,
      options.actorId,
      prepared.metadata.workspaceId,
      prepared.destinationWorkspace,
      prepared.relocationId,
      "vacate",
    );
    assertPermitBasis(permit, prepared.version, prepared.headEventHash);

    const entries = [...(prepared.metadata.relocations ?? [])];
    const entry: WorkspaceRelocationEntry = {
      schemaVersion: WORKSPACE_RELOCATION_ENTRY_VERSION,
      sequence: prepared.sequence,
      relocationId: prepared.relocationId,
      stage: "vacated",
      at: options.at,
      from: prepared.from,
      to: prepared.to,
      basis: prepared.basis,
      authority: { actorId: options.actorId, authorityFileSha256: admitted(options.authority).authorityFileSha256 },
    };
    entries.push(entry);

    // v6: THE SINGLE COMMIT POINT.
    await writeWorkspaceMetadataAt(prepared.root, withRelocations(prepared.metadata, entries), options.crashAt);
    // The manifest travels in the receipt because after this write it is
    // unobtainable at BOTH addresses — snapshot-manifest refuses the source with
    // VACATED and the copy with ADOPTION_REQUIRED — while `relocation-adopt`
    // requires its exact text. An operator who skipped the plan step had no forward
    // route at all; the only exit was abort, which is the fork-creating verb.
    return receipt("WORKSPACE_RELOCATION_VACATE_COMPLETED", entry, {
      controlManifestSha256: prepared.basis.controlManifestSha256,
      controlManifest: prepared.controlManifest,
      // The value an `abort` permit for this hop must name, and which did not exist
      // until the line above committed. It is emitted here AND by
      // `relocation-inspect` at this address, so losing the receipt does not strand
      // the operator: abort stays a pure function of the tree.
      vacateCommitmentSha256: relocationVacateCommitment(entry),
    });
  } finally {
    await prepared.lease.release();
  }
}

// ---------------------------------------------------------------------------
// relocation-adopt
// ---------------------------------------------------------------------------

export interface AdoptOptions {
  readonly at: string;
  readonly actorId: string;
  readonly relocationId: string;
  readonly roots: RelocationDestination;
  readonly authority: RelocationAuthorityContext;
  readonly controlManifest: string;
  readonly crashAt?: WorkspaceCrashPoint;
}

/** Binds the copied tree to this host. Idempotent. */
export async function adoptWorkspace(workspaceRootInput: string, options: AdoptOptions): Promise<RelocationReceipt> {
  assertStrictInstant(options.at);
  try {
    assertProtocolId(options.actorId);
  } catch {
    fail("WORKSPACE_RELOCATION_INPUT_INVALID", "actorId");
  }

  // t0: authority before the lease.
  const preview = await readWorkspaceMetadataAt(workspaceRootInput, "adoption");
  const trailing = trailingEntry(preview.metadata);
  if (trailing === undefined) {
    fail("WORKSPACE_RELOCATION_NOT_PENDING", "this workspace has no relocation to adopt");
  }
  if (trailing.relocationId !== options.relocationId) {
    fail("WORKSPACE_RELOCATION_ID_MISMATCH", `the trailing hop is ${trailing.relocationId}`);
  }
  // t12: idempotence. Operators retry; a verb that half-applies on retry is the
  // same defect as a torn write.
  if (trailing.stage === "adopted") {
    return receipt("WORKSPACE_RELOCATION_ALREADY_ADOPTED", trailing);
  }
  if (trailing.stage !== "vacated") {
    fail("WORKSPACE_RELOCATION_NOT_PENDING", `the trailing hop is ${trailing.stage}`);
  }

  const permit = matchPermit(
    options.authority,
    options.actorId,
    preview.metadata.workspaceId,
    trailing.to.find((root) => root.kind === "workspace")?.canonicalPath ?? "",
    trailing.relocationId,
    "adopt",
  );
  assertPermitBasis(permit, trailing.basis.version, trailing.basis.headEventHash);

  // t2: the five host-supplied roots, in metadata index order. D5: one code at the
  // boundary, the underlying ROOT_* code in `rootReasonCode`.
  const declared = declaredDestinationRoots(options.roots);
  let canonicalRoots: readonly CanonicalRoot[];
  try {
    canonicalRoots = await assertDistinctRoots(declared.map((entry) => ({ kind: entry.kind, path: entry.path })));
  } catch (error) {
    throw new RelocationError(
      "WORKSPACE_RELOCATION_DESTINATION_UNRESOLVED",
      String((error as { message?: string }).message ?? error),
      typeof (error as { reasonCode?: string }).reasonCode === "string" ? (error as { reasonCode: string }).reasonCode : undefined,
    );
  }
  if (canonicalJson(canonicalRoots) !== canonicalJson(trailing.to)) {
    fail("WORKSPACE_RELOCATION_DESTINATION_UNRESOLVED", "the resolved roots are not the destination the vacate declared");
  }
  // Defense in depth for the programmatic surface only, and stated as such rather
  // than left to look like a live control: on the CLI route `preview.root` and this
  // value are both the realpath of the SAME argument, so no CLI input can make them
  // differ — a mutation of this line is green by construction, which is why no guard
  // claims it. It fires only if a future caller passes the address and the declared
  // roots separately, which is exactly when it would matter.
  if (preview.root !== (canonicalRoots.find((root) => root.kind === "workspace")?.canonicalPath ?? "")) {
    fail("WORKSPACE_RELOCATION_DESTINATION_UNRESOLVED", "the workspace root argument is not the declared destination workspace root");
  }

  // t3: BEFORE any write.
  await assertSupportedWorkspaceFilesystem(preview.root);
  // t4 and t5: the two blindnesses the manifest structurally cannot cover.
  await assertControlTreeSkeleton(preview.root);
  await assertNoTransportResidue(preview.root);

  // t6: the transported bytes are what the source signed for. workspace.json is
  // excluded so the same call also works on a re-run; pre-commit it is byte-identical.
  if (createHash("sha256").update(options.controlManifest, "utf8").digest("hex") !== trailing.basis.controlManifestSha256) {
    fail("WORKSPACE_RELOCATION_CHAIN_MISMATCH", "the supplied control manifest is not the one the vacate recorded");
  }
  await verifySnapshotManifest(preview.root, options.controlManifest, { excludePaths: ["workspace.json"] });

  // t22 needs no check of its own and gets none: readSegmentEvents requires every
  // non-final segment to hold EXACTLY metadata.segmentEventLimit events, so a
  // hand-changed limit corrupts the very next read — which is the measure step
  // immediately below. A separate assertion here would be a predicate that can
  // never be the one that fires.

  // t7: MEASURE, do not quote. The target proves the chain it is adopting.
  const measured = await measureWorkspaceChainAt(preview.root, preview.metadata);
  if (measured.version !== trailing.basis.version || measured.headEventHash !== trailing.basis.headEventHash) {
    fail(
      "WORKSPACE_RELOCATION_CHAIN_MISMATCH",
      `the tree materializes to version=${String(measured.version)} head=${String(measured.headEventHash)}, not the declared basis`,
    );
  }

  // t8: the lease, with adoption admission (D4).
  const lease = await acquireWorkspaceLease(preview.root, { now: options.at, relocationAdmission: "adoption" });
  try {
    const entries = [...(preview.metadata.relocations ?? [])];
    const entry: WorkspaceRelocationEntry = {
      schemaVersion: WORKSPACE_RELOCATION_ENTRY_VERSION,
      sequence: entries.length + 1,
      relocationId: trailing.relocationId,
      stage: "adopted",
      at: options.at,
      from: trailing.from,
      to: trailing.to,
      basis: trailing.basis,
      authority: { actorId: options.actorId, authorityFileSha256: admitted(options.authority).authorityFileSha256 },
    };
    entries.push(entry);
    // t9: THE SINGLE COMMIT POINT on this side. `roots` is NOT rewritten — see
    // activeBinding in workspace.ts for why rewriting it would make the ledger
    // self-invalidating. t10: no view rewrite either; views carry no paths, and
    // their byte-stability across the move is itself evidence that only the binding
    // changed.
    await writeWorkspaceMetadataAt(preview.root, withRelocations(preview.metadata, entries), options.crashAt);
    return receipt("WORKSPACE_RELOCATION_ADOPT_COMPLETED", entry, {
      measuredVersion: measured.version,
      measuredHeadEventHash: measured.headEventHash,
    });
  } finally {
    await lease.release();
  }
}

// ---------------------------------------------------------------------------
// relocation-abort
// ---------------------------------------------------------------------------

export interface AbortOptions {
  readonly at: string;
  readonly actorId: string;
  readonly relocationId: string;
  readonly authority: RelocationAuthorityContext;
  readonly acknowledgeForkRisk: boolean;
  readonly targetInspection?: string;
  readonly crashAt?: WorkspaceCrashPoint;
}

// The fork statement. It is emitted by the abort receipt and by relocation-inspect at
// any address whose trailing hop is `aborted`, in both cases WITHOUT claiming to know
// whether the target adopted — that is the thing an offline source cannot know.
//
// BOTH TENSES, because the second review measured that only one of the two halves was
// stated. The past-tense half (the destination already adopted) was covered. The
// future-tense half was not, and it is the half the FULLY COMPLIANT abort leaves open:
// after an abort the untouched copy still carries a valid trailing `vacated` entry,
// nothing at the destination can ever learn that the source aborted, and the copy stays
// adoptable indefinitely. That is why the runbook now says the copy must be destroyed —
// the only place that half can be closed is outside the engine.
export const RELOCATION_ABORT_FORK_RISK =
  "if the destination has run relocation-adopt -- or ever runs it later, since the copy stays adoptable and cannot learn of this abort -- this address and the destination are two live authorities for one workspaceId; destroy the copy";

// The window a target inspection may be old, in milliseconds. One hour: long enough
// for an operator to inspect a reachable destination, decide, and run the abort on a
// second host, short enough that a document captured before an adopt in the same
// session is refused rather than silently accepted.
//
// It bounds a caller-declared instant against another caller-declared instant. It is
// therefore an ordering device and NOT a freshness proof — see the module header. The
// property it does buy is that the stale-document path is no longer indistinguishable
// from the honest one for free: the two instants have to be stated and have to agree.
export const RELOCATION_TARGET_INSPECTION_WINDOW_MS = 3_600_000;

/**
 * Verifies a destination-side `relocation-inspect` document against the hop being
 * aborted. This is the two-sided attention proof abort previously lacked: its
 * relocationId came from the operator's own vacate receipt thirty seconds earlier and
 * therefore carried no information about the only question that matters.
 *
 * It is evidence, not proof, and the second review measured exactly how weak the
 * evidence was: the document carried no observation instant, so one captured before the
 * destination adopted was BYTE-IDENTICAL to a fresh one — the stale path needed no
 * intent at all, it was the natural operator sequence (inspect, decide, abort) with an
 * adopt landing in between, and it stamped an affirmative "verified" into the receipt.
 *
 * What is checked now: the document's own caller-declared `observedAt` must sit inside
 * RELOCATION_TARGET_INSPECTION_WINDOW_MS of the abort's own caller-declared `at`, and
 * not after it. Both instants are caller-supplied. This bounds the gap and makes the two
 * claims collide if they disagree; it does not and cannot establish what the destination
 * was doing at the moment of the abort. That check is TOCTOU by construction: the source
 * is offline with respect to the destination, and no version of an offline check can be
 * otherwise. The receipt records this document's digest and its declared instant rather
 * than a verdict.
 */
function assertTargetNotAdopted(
  document: string,
  workspaceId: string,
  trailing: WorkspaceRelocationEntry,
  abortAt: string,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(document);
  } catch {
    fail("WORKSPACE_RELOCATION_INPUT_INVALID", "the target inspection is not JSON");
  }
  const inspection = record(parsed, "target inspection");
  if (inspection.schemaVersion !== WORKSPACE_RELOCATION_INSPECTION_VERSION) {
    fail("WORKSPACE_RELOCATION_INPUT_INVALID", "the target inspection is not a relocation inspection document");
  }
  if (inspection.workspaceId !== workspaceId || inspection.relocationId !== trailing.relocationId ||
    inspection.address !== (trailing.to.find((root) => root.kind === "workspace")?.canonicalPath ?? "")) {
    fail("WORKSPACE_RELOCATION_INPUT_INVALID", "the target inspection is not this hop's destination");
  }
  if (typeof inspection.observedAt !== "string") {
    fail("WORKSPACE_RELOCATION_INPUT_INVALID", "the target inspection carries no observedAt");
  }
  const observedAt = inspection.observedAt;
  try {
    assertStrictInstant(observedAt);
  } catch {
    fail("WORKSPACE_RELOCATION_INPUT_INVALID", "the target inspection observedAt is not a strict instant");
  }
  const gap = Date.parse(abortAt) - Date.parse(observedAt);
  if (!Number.isFinite(gap) || gap < 0 || gap > RELOCATION_TARGET_INSPECTION_WINDOW_MS) {
    fail(
      "WORKSPACE_RELOCATION_INSPECTION_STALE",
      `the target inspection declares observedAt=${observedAt} and this abort declares at=${abortAt}; the two must be ordered and within ${String(RELOCATION_TARGET_INSPECTION_WINDOW_MS)}ms`,
    );
  }
  if (inspection.state !== "adoption-required" || inspection.stage !== "vacated") {
    fail(
      "WORKSPACE_RELOCATION_TARGET_ADOPTED",
      `the destination reports state=${String(inspection.state)} stage=${String(inspection.stage)}; aborting here would create a fork`,
    );
  }
  return observedAt;
}

/**
 * Revives the source. The pre-vacate binding is restored from the ledger's own
 * `from` field, which the vacate never destroyed — which is exactly why the ledger
 * beat the tombstone alternative (D2): a tombstone deletes the bytes abort needs.
 *
 * Abort is exactly the fork-creating move if the target already adopted, and the
 * source CANNOT know whether it did; proving a negative is not available to an
 * offline engine. Three things are therefore required rather than one:
 *
 *   1. A permit minted for THIS hop's `abort` stage, naming this hop's
 *      `vacateCommitmentSha256`. The vacate's own permit no longer works, and — the
 *      second review's finding — neither does a permit sitting in the vacate's own
 *      DOCUMENT, because that document would have to contain a digest of itself. What
 *      this buys is two documents and two approvals instead of one; it is a review
 *      device, not a barrier, and the module header says so as a ceiling.
 *   2. An explicit fork-risk acknowledgement from the caller. It proves nothing; it
 *      is a ceremony, and it is named as one.
 *   3. The destination's own inspection when the operator can reach it, bounded to
 *      RELOCATION_TARGET_INSPECTION_WINDOW_MS of this abort's own instant. It is
 *      optional because the legitimate abort — the copy was never made, the
 *      destination host is unreachable — has no destination to inspect, and a
 *      requirement that cannot be met in the case it exists for would simply be
 *      routed around. It is also, measured, routed around by simply omitting the flag:
 *      the receipt records that omission (`targetInspectionSupplied: false`) and that
 *      record is the only thing that can be claimed for it.
 *
 * What is guaranteed is that the fork is LEGIBLE: an `aborted` at the source and an
 * `adopted` at the target sharing one relocationId is a permanent contradiction in
 * both files. Any claim stronger than that is false.
 */
export async function abortWorkspaceRelocation(workspaceRootInput: string, options: AbortOptions): Promise<RelocationReceipt> {
  assertStrictInstant(options.at);
  try {
    assertProtocolId(options.actorId);
  } catch {
    fail("WORKSPACE_RELOCATION_INPUT_INVALID", "actorId");
  }
  if (options.acknowledgeForkRisk !== true) {
    fail(
      "WORKSPACE_RELOCATION_INPUT_INVALID",
      `abort requires an explicit fork-risk acknowledgement: ${RELOCATION_ABORT_FORK_RISK}`,
    );
  }
  const preview = await readWorkspaceMetadataAt(workspaceRootInput, "abort");
  const trailing = trailingEntry(preview.metadata);
  if (trailing === undefined || trailing.stage !== "vacated") {
    fail("WORKSPACE_RELOCATION_NOT_PENDING", "there is no vacated hop to abort at this address");
  }
  // Proof of attention, the same device breakWorkspaceLease uses when it demands
  // the current owner token.
  if (trailing.relocationId !== options.relocationId) {
    fail("WORKSPACE_RELOCATION_ID_MISMATCH", `the trailing hop is ${trailing.relocationId}`);
  }
  // Defense in depth, and measured to be exactly that: `readMetadata` admits an
  // abort only at an address whose state is `vacated`, and the only such address is
  // the source, so removing this line alone changes no observable behaviour. It is
  // kept because removing BOTH layers let a live probe run the fork-creating verb at
  // the DESTINATION, and it is labelled because an unlabelled restatement reads as a
  // live control. The admission conjunct is the one that is guard-registered (WSR-1
  // T33); a mutation of this line is green by construction, and that is stated here
  // rather than left for the next reviewer to rediscover.
  if (preview.root !== (trailing.from.find((root) => root.kind === "workspace")?.canonicalPath ?? "")) {
    fail("WORKSPACE_RELOCATION_NOT_PENDING", "abort runs at the source address");
  }
  const permit = matchPermit(
    options.authority,
    options.actorId,
    preview.metadata.workspaceId,
    trailing.to.find((root) => root.kind === "workspace")?.canonicalPath ?? "",
    trailing.relocationId,
    "abort",
  );
  // The basis check abort was missing while being the one verb that can create a
  // fork. It was harmless only because a vacated chain cannot advance — an
  // invariant that lived in a different function and was nowhere stated.
  assertPermitBasis(permit, trailing.basis.version, trailing.basis.headEventHash);
  // The vacate commitment. This is what a permit minted alongside the vacate cannot
  // carry — see relocationVacateCommitment for the arithmetic and for what it does NOT
  // buy.
  const vacateCommitmentSha256 = relocationVacateCommitment(trailing);
  if (permit.vacateCommitmentSha256 !== vacateCommitmentSha256) {
    fail(
      "WORKSPACE_RELOCATION_VACATE_COMMITMENT_MISMATCH",
      `the abort permit names vacate commitment ${String(permit.vacateCommitmentSha256)}; this address committed ${vacateCommitmentSha256}`,
    );
  }
  // RECORDED, NOT ADJUDICATED. The old field was named `targetStateVerified` and its
  // value was literally `options.targetInspection !== undefined` — "a document was
  // supplied", written under a name that reads "the target's state was verified", and
  // stamped `true` by a document captured before the destination adopted. What goes in
  // the receipt now is what is actually known: whether a document was supplied, which
  // document it was, and what instant it claimed for itself.
  const targetInspectionSupplied = options.targetInspection !== undefined;
  let targetInspectionSha256: string | undefined;
  let targetInspectionObservedAt: string | undefined;
  if (options.targetInspection !== undefined) {
    targetInspectionObservedAt = assertTargetNotAdopted(
      options.targetInspection, preview.metadata.workspaceId, trailing, options.at,
    );
    targetInspectionSha256 = createHash("sha256").update(options.targetInspection, "utf8").digest("hex");
  }

  const lease = await acquireWorkspaceLease(preview.root, { now: options.at, relocationAdmission: "abort" });
  try {
    const entries = [...(preview.metadata.relocations ?? [])];
    const entry: WorkspaceRelocationEntry = {
      schemaVersion: WORKSPACE_RELOCATION_ENTRY_VERSION,
      sequence: entries.length + 1,
      relocationId: trailing.relocationId,
      stage: "aborted",
      at: options.at,
      from: trailing.from,
      to: trailing.to,
      basis: trailing.basis,
      authority: { actorId: options.actorId, authorityFileSha256: admitted(options.authority).authorityFileSha256 },
    };
    entries.push(entry);
    await writeWorkspaceMetadataAt(preview.root, withRelocations(preview.metadata, entries), options.crashAt);
    return receipt("WORKSPACE_RELOCATION_ABORT_COMPLETED", entry, {
      targetInspectionSupplied,
      ...(targetInspectionSha256 === undefined ? {} : { targetInspectionSha256 }),
      ...(targetInspectionObservedAt === undefined ? {} : { targetInspectionObservedAt }),
      vacateCommitmentSha256,
      forkRisk: RELOCATION_ABORT_FORK_RISK,
    });
  } finally {
    await lease.release();
  }
}

// ---------------------------------------------------------------------------
// relocation-inspect
// ---------------------------------------------------------------------------

/**
 * The only instrument that can detect a fork BETWEEN THE TWO ADDRESSES THE LEDGER
 * NAMES, and only when run at both and compared. A close-out that checks only the
 * new address proves nothing. A close-out that checks both proves nothing about a
 * THIRD address rebound by hand — that address appears in no ledger, and its
 * inspection is byte-indistinguishable from a workspace that never relocated. Say
 * what it covers; never call it a fork detector without the qualifier.
 *
 * `at` is REQUIRED and is stamped into the document as `observedAt`. It is the caller's
 * declaration of when the observation was taken, on the same fail-closed terms as every
 * other `--at` in this engine: no implicit clock, and the engine does not pretend to
 * have measured it. Before it existed, two inspections of the same address taken on
 * either side of an adopt were BYTE-IDENTICAL, which is what let a pre-adopt document
 * pass abort's destination check and stamp an affirmative verification into the receipt.
 * The instant does not make the document fresh; it makes staleness statable, refusable
 * and recorded.
 */
export async function inspectWorkspaceRelocation(
  workspaceRootInput: string,
  options: { readonly at: string },
): Promise<Readonly<Record<string, JsonValue>>> {
  assertStrictInstant(options.at);
  const preview = await readWorkspaceMetadataAt(workspaceRootInput, "any");
  const state = relocationStateAt(preview.metadata, preview.root);
  const trailing = trailingEntry(preview.metadata);
  const binding = activeBinding(preview.metadata);
  if (trailing === undefined) {
    return Object.freeze({
      schemaVersion: WORKSPACE_RELOCATION_INSPECTION_VERSION,
      reasonCode: "WORKSPACE_RELOCATION_INSPECTED",
      address: preview.root,
      observedAt: options.at,
      workspaceId: preview.metadata.workspaceId,
      state,
      relocations: 0,
      activeWorkspaceRoot: binding.find((root) => root.kind === "workspace")?.canonicalPath ?? "",
    });
  }
  // Roots this hop does NOT move. A root the relocation leaves in place must already
  // exist at the destination host, and physically moving one that another partition
  // also declares bricks that partition. The engine cannot see other partitions and
  // does not claim to — this reports what it can actually measure.
  const unmovedRoots = trailing.from
    .filter((root, index) => root.canonicalPath === trailing.to[index]?.canonicalPath)
    .map((root) => root.kind);
  // A destination stated in a spelling the destination host does not realpath to
  // (a case difference on a case-insensitive volume is the cheap way to produce
  // one) refuses under FOREIGN_ADDRESS, which names the wrong problem: the ledger
  // DOES name this tree, under a different spelling. The state machine cannot
  // discriminate it without a filesystem probe of a path on another host, so the
  // inspection reports the near miss instead of leaving the operator to guess.
  const declaredDestination = relocationWorkspaceRootOf(trailing.to);
  const nearMissDestination = state === "foreign-address" && declaredDestination !== undefined &&
    rootPortableIdentity(preview.root) === rootPortableIdentity(declaredDestination) &&
    preview.root !== declaredDestination;
  return Object.freeze({
    schemaVersion: WORKSPACE_RELOCATION_INSPECTION_VERSION,
    reasonCode: "WORKSPACE_RELOCATION_INSPECTED",
    address: preview.root,
    observedAt: options.at,
    workspaceId: preview.metadata.workspaceId,
    state,
    relocations: (preview.metadata.relocations ?? []).length,
    // The remaining budget, at the address that carries it. The cap is spent by
    // attempts rather than by moves and nothing gives an entry back.
    ledgerEntriesRemaining: WORKSPACE_RELOCATION_LEDGER_LIMIT - (preview.metadata.relocations ?? []).length,
    relocationId: trailing.relocationId,
    stage: trailing.stage,
    at: trailing.at,
    from: trailing.from.map((root) => ({ kind: root.kind, canonicalPath: root.canonicalPath })),
    to: trailing.to.map((root) => ({ kind: root.kind, canonicalPath: root.canonicalPath })),
    basis: { ...trailing.basis },
    unmovedRoots,
    nearMissDestination,
    // Loud, permanent and derived from the ledger rather than from a claim: any
    // address whose trailing hop is `aborted` is a fork candidate, and the file
    // itself is the only place an operator will look years later.
    ...(trailing.stage === "aborted" ? { forkRisk: RELOCATION_ABORT_FORK_RISK } : {}),
    // Emitted while the hop is open, because it is what an `abort` permit for this hop
    // must name and because the receipt that first carried it may be long gone. Abort
    // remains a pure function of the tree (T13).
    ...(trailing.stage === "vacated" ? { vacateCommitmentSha256: relocationVacateCommitment(trailing) } : {}),
    activeWorkspaceRoot: binding.find((root) => root.kind === "workspace")?.canonicalPath ?? "",
  });
}

function relocationWorkspaceRootOf(roots: readonly CanonicalRoot[]): string | undefined {
  return roots.find((root) => root.kind === "workspace")?.canonicalPath;
}
