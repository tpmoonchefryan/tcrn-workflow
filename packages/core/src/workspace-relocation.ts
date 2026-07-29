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
//     both files, under one shared relocationId, and it makes producing them
//     require deliberately destroying an artifact rather than an accident of rsync.
//     The only red proof of a fork is the TWO-SIDED relocation-inspect comparison,
//     which is therefore a mandatory close-out step and gate evidence. No
//     single-sided "the source is still dead" assertion may be written: it would be
//     permanently true and would give false comfort.

import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import {
  assertProtocolId,
  assertStrictInstant,
  canonicalJson,
  compareCanonicalText,
} from "../../protocol/src/index.js";
import type { JsonValue } from "../../protocol/src/index.js";
import { readAuthorityFile } from "./authority-file-reader.js";
import type { AuthorityFileReasonCodes } from "./authority-file-reader.js";
import { assertDistinctRoots, rootPortableIdentity } from "./root-identity.js";
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
  "WORKSPACE_RELOCATION_SEGMENT_LIMIT_CHANGED",
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

export interface RelocationPermit {
  readonly actorId: string;
  readonly workspaceIds: readonly string[];
  readonly destinations: readonly string[];
  readonly basis: { readonly headEventHash: string | null; readonly version: number };
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
    exact(permit, ["actorId", "workspaceIds", "destinations", "basis"], `permits[${index}]`);
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
    return Object.freeze({
      actorId: permit.actorId as string,
      workspaceIds: Object.freeze([...workspaceIds]),
      destinations: Object.freeze([...destinations]),
      basis: Object.freeze({ headEventHash: basis.headEventHash as string | null, version: basis.version as number }),
    });
  });
  assertCanonicallySorted(permits.map((permit) => permit.actorId), "permits");
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

// readAuthorityFile requires path === expectedCanonicalPath, so the file is bound to
// a path on the host reading it. Each host presents ITS OWN path with the SAME
// content digest; that works today and needs no change (T17).
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

function matchPermit(
  context: RelocationAuthorityContext,
  actorId: string,
  workspaceId: string,
  destination: string,
): RelocationPermit {
  const permit = admitted(context).document.permits.find((entry) =>
    entry.actorId === actorId && entry.workspaceIds.includes(workspaceId) && entry.destinations.includes(destination));
  if (permit === undefined) {
    fail("WORKSPACE_RELOCATION_NOT_PERMITTED", `${actorId} may not relocate ${workspaceId} to ${destination}`);
  }
  return permit;
}

// The CAS. An authority minted for "move this workspace as of version 549 / head
// abc…" cannot be replayed months later against a chain that has moved on.
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
  return roots;
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

export interface VacateOptions {
  readonly at: string;
  readonly actorId: string;
  readonly destination: RelocationDestination;
  readonly authority: RelocationAuthorityContext;
  readonly expectedVersion: number;
  readonly crashAt?: WorkspaceCrashPoint;
}

/**
 * Its ONLY effect is to kill the source. It does not copy, does not reach the
 * target, and does not advance the chain.
 */
export async function vacateWorkspace(workspaceRootInput: string, options: VacateOptions): Promise<RelocationReceipt> {
  assertStrictInstant(options.at);
  try {
    assertProtocolId(options.actorId);
  } catch {
    fail("WORKSPACE_RELOCATION_INPUT_INVALID", "actorId");
  }
  const to = declaredDestinationRoots(options.destination);
  const destinationWorkspace = to.find((root) => root.kind === "workspace")?.canonicalPath ?? "";

  // v0: the permit tuple is checked BEFORE the lease. Precedent and reason are
  // literal (cli/index.ts gate-transition): a filesystem refusal should not have
  // held a workspace lock while it happened.
  const preview = await readWorkspaceMetadataAt(workspaceRootInput, "live");
  const permit = matchPermit(options.authority, options.actorId, preview.metadata.workspaceId, destinationWorkspace);

  const from = activeBinding(preview.metadata);
  if (canonicalJson(from) === canonicalJson(to)) {
    fail("WORKSPACE_RELOCATION_INPUT_INVALID", "the destination binding is the binding already in force");
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
    assertPermitBasis(permit, state.version, state.headEventHash);

    // Quarantine residue is refused for free by RESIDUE_PREFIX inside the manifest
    // build below.

    // v4
    const controlManifest = await createSnapshotManifest(preview.root, lease);
    const basis: WorkspaceRelocationBasis = {
      controlManifestSha256: createHash("sha256").update(controlManifest, "utf8").digest("hex"),
      headEventHash: state.headEventHash,
      version: state.version,
    };

    const entries = [...(preview.metadata.relocations ?? [])];
    const sequence = entries.length + 1;
    // v5: derived, never random. No clock.
    const relocationId = deriveRelocationId({ workspaceId: state.metadata.workspaceId, sequence, from, to, basis });
    const entry: WorkspaceRelocationEntry = {
      schemaVersion: WORKSPACE_RELOCATION_ENTRY_VERSION,
      sequence,
      relocationId,
      stage: "vacated",
      at: options.at,
      from,
      to,
      basis,
      authority: { actorId: options.actorId, authorityFileSha256: admitted(options.authority).authorityFileSha256 },
    };
    entries.push(entry);

    // v6: THE SINGLE COMMIT POINT.
    await writeWorkspaceMetadataAt(preview.root, withRelocations(preview.metadata, entries), options.crashAt);
    return receipt("WORKSPACE_RELOCATION_VACATE_COMPLETED", entry, { controlManifestSha256: basis.controlManifestSha256 });
  } finally {
    await lease.release();
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
  readonly crashAt?: WorkspaceCrashPoint;
}

/**
 * Revives the source. The pre-vacate binding is restored from the ledger's own
 * `from` field, which the vacate never destroyed — which is exactly why the ledger
 * beat the tombstone alternative (D2): a tombstone deletes the bytes abort needs.
 *
 * Abort is exactly the fork-creating move if the target already adopted, and the
 * source CANNOT know whether it did; proving a negative is not available to an
 * offline engine. What is guaranteed is that the fork is LEGIBLE: an `aborted` at
 * the source and an `adopted` at the target sharing one relocationId is a permanent
 * contradiction in both files. Any claim stronger than that is false.
 */
export async function abortWorkspaceRelocation(workspaceRootInput: string, options: AbortOptions): Promise<RelocationReceipt> {
  assertStrictInstant(options.at);
  try {
    assertProtocolId(options.actorId);
  } catch {
    fail("WORKSPACE_RELOCATION_INPUT_INVALID", "actorId");
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
  if (preview.root !== (trailing.from.find((root) => root.kind === "workspace")?.canonicalPath ?? "")) {
    fail("WORKSPACE_RELOCATION_NOT_PENDING", "abort runs at the source address");
  }
  matchPermit(
    options.authority,
    options.actorId,
    preview.metadata.workspaceId,
    trailing.to.find((root) => root.kind === "workspace")?.canonicalPath ?? "",
  );

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
    return receipt("WORKSPACE_RELOCATION_ABORT_COMPLETED", entry);
  } finally {
    await lease.release();
  }
}

// ---------------------------------------------------------------------------
// relocation-inspect
// ---------------------------------------------------------------------------

/**
 * The ONLY instrument that can detect a fork — and only when run at BOTH addresses
 * and compared. A close-out that checks only the new address proves nothing about
 * the fork the verb family exists to prevent.
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
    activeWorkspaceRoot: binding.find((root) => root.kind === "workspace")?.canonicalPath ?? "",
  });
}
