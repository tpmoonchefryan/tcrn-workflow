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
// Two ceilings this module CANNOT cross, stated here and in ADR 0003's body rather
// than in a test comment, because a reader who finds them in a test comment will
// assume the mechanism is stronger than it is:
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
//
// Two corrections landed after the first adversarial review, both of which were
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
//     cannot be satisfied twice: the next hop has a different sequence and a
//     different control-manifest digest.
//   * ABORT CANNOT RIDE THE VACATE'S AUTHORITY. Abort after the target adopted is
//     the fork-creating move, and the source cannot know whether the target
//     adopted — proving that negative is not available to an offline engine. What
//     is now required is a permit minted for THIS hop's `abort` stage (never the
//     vacate's), an explicit fork-risk acknowledgement, and — when the operator can
//     reach the target — the target's own relocation-inspect document, which is
//     CHECKED and which refuses the abort outright if it shows an adopted target.

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
  "WORKSPACE_RELOCATION_LEDGER_FULL",
  "WORKSPACE_RELOCATION_NOT_PENDING",
  "WORKSPACE_RELOCATION_NOT_PERMITTED",
  "WORKSPACE_RELOCATION_PLANNED",
  "WORKSPACE_RELOCATION_TARGET_ADOPTED",
  "WORKSPACE_RELOCATION_TRANSPORT_RESIDUE",
  "WORKSPACE_RELOCATION_UNSETTLED",
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
    exact(permit, ["actorId", "workspaceIds", "destinations", "basis", "relocationId", "stage"], `permits[${index}]`);
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
    return Object.freeze({
      actorId: permit.actorId as string,
      workspaceIds: Object.freeze([...workspaceIds]),
      destinations: Object.freeze([...destinations]),
      basis: Object.freeze({ headEventHash: basis.headEventHash as string | null, version: basis.version as number }),
      relocationId: permit.relocationId,
      stage: permit.stage as RelocationPermitStage,
    });
  });
  // The ordering key is the whole permit identity, not the actor alone: one hop
  // legitimately needs three permits under one actor (vacate, adopt, abort), so an
  // actor-only key would reject the honest document and admit nothing else. A
  // protocol id contains no space, so the join is unambiguous.
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
export const RELOCATION_ABORT_FORK_RISK =
  "if the destination already ran relocation-adopt, this address and the destination are now two live authorities for one workspaceId";

/**
 * Verifies a destination-side `relocation-inspect` document against the hop being
 * aborted. This is the two-sided attention proof abort previously lacked: its
 * relocationId came from the operator's own vacate receipt thirty seconds earlier and
 * therefore carried no information about the only question that matters.
 *
 * It is evidence, not proof. The document is unsigned canonical JSON, so a
 * determined operator can forge one — the same ceiling every other artifact here
 * states about itself. What it cannot be is accidental.
 */
function assertTargetNotAdopted(document: string, workspaceId: string, trailing: WorkspaceRelocationEntry): void {
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
  if (inspection.state !== "adoption-required" || inspection.stage !== "vacated") {
    fail(
      "WORKSPACE_RELOCATION_TARGET_ADOPTED",
      `the destination reports state=${String(inspection.state)} stage=${String(inspection.stage)}; aborting here would create a fork`,
    );
  }
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
 *   1. A permit minted for THIS hop's `abort` stage. The vacate's own permit no
 *      longer works — that was measured, not supposed: one authority file drove
 *      vacate, adopt and abort in a loop and left three live authorities behind.
 *   2. An explicit fork-risk acknowledgement from the caller. It proves nothing; it
 *      is a ceremony, and it is named as one.
 *   3. The destination's own inspection when the operator can reach it, which is
 *      CHECKED and refuses the abort outright if the destination already adopted.
 *      It is optional because the legitimate abort — the copy was never made, the
 *      destination host is unreachable — has no destination to inspect, and a
 *      requirement that cannot be met in the case it exists for would simply be
 *      routed around. The receipt records which of the two happened.
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
  const targetStateVerified = options.targetInspection !== undefined;
  if (options.targetInspection !== undefined) {
    assertTargetNotAdopted(options.targetInspection, preview.metadata.workspaceId, trailing);
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
      targetStateVerified,
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
 */
export async function inspectWorkspaceRelocation(workspaceRootInput: string): Promise<Readonly<Record<string, JsonValue>>> {
  const preview = await readWorkspaceMetadataAt(workspaceRootInput, "any");
  const state = relocationStateAt(preview.metadata, preview.root);
  const trailing = trailingEntry(preview.metadata);
  const binding = activeBinding(preview.metadata);
  if (trailing === undefined) {
    return Object.freeze({
      schemaVersion: WORKSPACE_RELOCATION_INSPECTION_VERSION,
      reasonCode: "WORKSPACE_RELOCATION_INSPECTED",
      address: preview.root,
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
    workspaceId: preview.metadata.workspaceId,
    state,
    relocations: (preview.metadata.relocations ?? []).length,
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
    activeWorkspaceRoot: binding.find((root) => root.kind === "workspace")?.canonicalPath ?? "",
  });
}

function relocationWorkspaceRootOf(roots: readonly CanonicalRoot[]): string | undefined {
  return roots.find((root) => root.kind === "workspace")?.canonicalPath;
}
