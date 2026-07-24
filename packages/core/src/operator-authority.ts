// SPDX-License-Identifier: Apache-2.0
//
// INIT-009 / EPIC-022: host-neutral operator authority supply.
//
// The trust root is deliberately outside this document. An operator presents the
// canonical path and SHA-256 of a pins document. That pins document binds one
// authority bundle by path, byte digest and minimum generation. Each read also
// records descriptor identity and rejects in-read replacement. The bundle can
// carry the already-existing file authorities and host inputs, but it cannot mint
// trust for itself: without the outer pins digest every read fails.
//
// Rotation replaces the authority bytes and advances the pins document. Revocation
// is expressed by the pins document's revoked digest set or by a revoked bundle.
// As with every file-native pin, anti-rollback across invocations ends at the
// operator retaining the newest pins digest; this module never treats prompt text,
// environment variables, ambient configuration or file discovery as authority.

import { isAbsolute, resolve } from "node:path";

import {
  assertProtocolId,
  canonicalSha256,
  compareCanonicalText,
  parseStrictInstant,
} from "../../protocol/src/index.js";
import {
  readAuthorityFile,
} from "./authority-file-reader.js";
import type {
  AuthorityFileExpectation,
  AuthorityFileReasonCodes,
  AuthorityFileResult,
} from "./authority-file-reader.js";
import {
  admitClaudeAdapterActivationHostInput,
} from "./claude-adapter-activation.js";
import type {
  ClaudeAdapterActivationHostContext,
} from "./claude-adapter-activation.js";
import {
  admitClaudeAdapterHostInput,
} from "./claude-adapter.js";
import type {
  ClaudeAdapterHostContext,
  ClaudeAdapterInstallationFileIdentity,
} from "./claude-adapter.js";
import {
  admitCodexAdapterHostInput,
} from "./codex-adapter.js";
import type {
  CodexAdapterHostContext,
  CodexAdapterInstallationFileIdentity,
} from "./codex-adapter.js";
import type {
  CompatibilityAdmissionAuthority,
} from "./compatibility-modes.js";
import type {
  ContextRouteAuthorityFileIdentity,
} from "./context-router.js";
import type {
  GenericProfileAdmissionAuthority,
} from "./generic-profile.js";

export const OPERATOR_AUTHORITY_PINS_VERSION = "tcrn.operator-authority-pins.v1" as const;
export const OPERATOR_AUTHORITY_BUNDLE_VERSION = "tcrn.operator-authority-bundle.v1" as const;

export const OPERATOR_AUTHORITY_REASON_CODES = Object.freeze([
  "OPERATOR_AUTHORITY_REQUIRED",
  "OPERATOR_AUTHORITY_PATH",
  "OPERATOR_AUTHORITY_DIGEST",
  "OPERATOR_AUTHORITY_CHANGED",
  "OPERATOR_AUTHORITY_LINK",
  "OPERATOR_AUTHORITY_SPECIAL_FILE",
  "OPERATOR_AUTHORITY_LIMIT_EXCEEDED",
  "OPERATOR_AUTHORITY_CANONICAL_INVALID",
  "OPERATOR_AUTHORITY_SCHEMA_INVALID",
  "OPERATOR_AUTHORITY_BINDING_MISMATCH",
  "OPERATOR_AUTHORITY_ROLLBACK",
  "OPERATOR_AUTHORITY_REVOKED",
  "OPERATOR_AUTHORITY_EXPIRED",
  "OPERATOR_AUTHORITY_HOST_INVALID",
  "OPERATOR_AUTHORITY_COMMAND_NOT_GRANTED",
] as const);

export type OperatorAuthorityReasonCode = typeof OPERATOR_AUTHORITY_REASON_CODES[number];

export class OperatorAuthorityError extends Error {
  readonly reasonCode: OperatorAuthorityReasonCode;

  constructor(reasonCode: OperatorAuthorityReasonCode, message: string) {
    super(message);
    this.name = "OperatorAuthorityError";
    this.reasonCode = reasonCode;
  }
}

export interface OperatorAuthorityPins {
  readonly schemaVersion: typeof OPERATOR_AUTHORITY_PINS_VERSION;
  readonly authorityId: string;
  readonly authorityPath: string;
  readonly authorityFileSha256: string;
  readonly minimumGeneration: number;
  readonly revokedAuthorityDigests: readonly string[];
  readonly pinsDigest: string;
}

export interface OperatorAuthorityFileGrants {
  readonly profileAdmission: GenericProfileAdmissionAuthority | null;
  readonly contextRoute: ContextRouteAuthorityFileIdentity | null;
  readonly codexAdapterInstallation: CodexAdapterInstallationFileIdentity | null;
  readonly claudeAdapterInstallation: ClaudeAdapterInstallationFileIdentity | null;
  readonly compatibilityAdmission: CompatibilityAdmissionAuthority | null;
}

export interface OperatorAuthorityHostInputs {
  readonly codexAdapter: Readonly<Record<string, unknown>> | null;
  readonly claudeAdapter: Readonly<Record<string, unknown>> | null;
  readonly claudeAdapterActivation: Readonly<Record<string, unknown>> | null;
}

export interface OperatorAuthorityMcpGrant {
  readonly writeCommands: readonly string[];
}

export interface OperatorAuthorityBundle {
  readonly schemaVersion: typeof OPERATOR_AUTHORITY_BUNDLE_VERSION;
  readonly authorityId: string;
  readonly generation: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly status: "active" | "revoked";
  readonly fileAuthorities: OperatorAuthorityFileGrants;
  readonly hostInputs: OperatorAuthorityHostInputs;
  readonly mcp: OperatorAuthorityMcpGrant;
  readonly authorityDigest: string;
}

export interface OperatorAuthorityContext {
  readonly pins: OperatorAuthorityPins;
  readonly bundle: OperatorAuthorityBundle;
  readonly pinsSourcePath: string;
  readonly pinsFileSha256: string;
  readonly pinsSourceIdentityDigest: string;
  readonly authoritySourcePath: string;
  readonly authorityFileSha256: string;
  readonly authoritySourceIdentityDigest: string;
  readonly profileAdmissionAuthority?: GenericProfileAdmissionAuthority;
  readonly contextRouteAuthority?: ContextRouteAuthorityFileIdentity;
  readonly codexAdapterHost?: CodexAdapterHostContext;
  readonly codexAdapterInstallationAuthority?: CodexAdapterInstallationFileIdentity;
  readonly claudeAdapterHost?: ClaudeAdapterHostContext;
  readonly claudeAdapterActivationHost?: ClaudeAdapterActivationHostContext;
  readonly claudeAdapterInstallationAuthority?: ClaudeAdapterInstallationFileIdentity;
  readonly compatibilityAdmissionAuthority?: CompatibilityAdmissionAuthority;
}

const maximumAuthorityBytes = 262_144;
const maximumCommands = 128;
const maximumRevocations = 128;
const shaPattern = /^[a-f0-9]{64}$/u;
const commandPattern = /^[a-z][a-z0-9-]{0,127}$/u;

function fail(reasonCode: OperatorAuthorityReasonCode, detail: string): never {
  throw new OperatorAuthorityError(reasonCode, detail);
}

function record(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) {
    fail("OPERATOR_AUTHORITY_SCHEMA_INVALID", label);
  }
  return value as Readonly<Record<string, unknown>>;
}

function exact(
  value: Readonly<Record<string, unknown>>,
  fields: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort(compareCanonicalText);
  const wanted = [...fields].sort(compareCanonicalText);
  if (actual.length !== wanted.length ||
    wanted.some((field, index) => field !== actual[index])) {
    fail("OPERATOR_AUTHORITY_SCHEMA_INVALID", `${label}: field set`);
  }
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !shaPattern.test(value)) {
    fail("OPERATOR_AUTHORITY_SCHEMA_INVALID", label);
  }
  return value;
}

function authorityId(value: unknown, label: string): string {
  try {
    assertProtocolId(value);
  } catch {
    fail("OPERATOR_AUTHORITY_SCHEMA_INVALID", label);
  }
  if (!(value as string).startsWith("authority:")) {
    fail("OPERATOR_AUTHORITY_SCHEMA_INVALID", label);
  }
  return value as string;
}

function instant(value: unknown, label: string): string {
  try {
    parseStrictInstant(value);
  } catch {
    fail("OPERATOR_AUTHORITY_SCHEMA_INVALID", label);
  }
  return value as string;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail("OPERATOR_AUTHORITY_SCHEMA_INVALID", label);
  }
  return value as number;
}

function canonicalAbsolutePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.isWellFormed() || !isAbsolute(value) ||
    resolve(value) !== value) {
    fail("OPERATOR_AUTHORITY_SCHEMA_INVALID", label);
  }
  return value;
}

function sortedUniqueStrings(
  value: unknown,
  label: string,
  maximum: number,
  validate: (entry: string) => boolean,
): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum ||
    value.some((entry) => typeof entry !== "string" || !entry.isWellFormed() ||
      !validate(entry))) {
    fail("OPERATOR_AUTHORITY_SCHEMA_INVALID", label);
  }
  const normalized = [...value] as string[];
  const sorted = [...normalized].sort(compareCanonicalText);
  if (new Set(normalized).size !== normalized.length ||
    sorted.some((entry, index) => entry !== normalized[index])) {
    fail("OPERATOR_AUTHORITY_SCHEMA_INVALID", `${label}: canonical order`);
  }
  return Object.freeze(normalized);
}

function fileExpectation(
  value: unknown,
  label: string,
): AuthorityFileExpectation | null {
  if (value === null) return null;
  const document = record(value, label);
  exact(document, ["expectedCanonicalPath", "expectedFileSha256"], label);
  return Object.freeze({
    expectedCanonicalPath: canonicalAbsolutePath(
      document.expectedCanonicalPath,
      `${label}.expectedCanonicalPath`,
    ),
    expectedFileSha256: sha(
      document.expectedFileSha256,
      `${label}.expectedFileSha256`,
    ),
  });
}

function nullableHostInput(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> | null {
  return value === null ? null : record(value, label);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(
      value as Readonly<Record<string, unknown>>,
    )) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

export function validateOperatorAuthorityPins(
  value: unknown,
): OperatorAuthorityPins {
  const document = record(value, "operator authority pins");
  exact(document, [
    "schemaVersion",
    "authorityId",
    "authorityPath",
    "authorityFileSha256",
    "minimumGeneration",
    "revokedAuthorityDigests",
    "pinsDigest",
  ], "operator authority pins");
  if (document.schemaVersion !== OPERATOR_AUTHORITY_PINS_VERSION) {
    fail("OPERATOR_AUTHORITY_SCHEMA_INVALID", "pins schemaVersion");
  }
  const basis = {
    schemaVersion: OPERATOR_AUTHORITY_PINS_VERSION,
    authorityId: authorityId(document.authorityId, "pins authorityId"),
    authorityPath: canonicalAbsolutePath(
      document.authorityPath,
      "pins authorityPath",
    ),
    authorityFileSha256: sha(
      document.authorityFileSha256,
      "pins authorityFileSha256",
    ),
    minimumGeneration: positiveInteger(
      document.minimumGeneration,
      "pins minimumGeneration",
    ),
    revokedAuthorityDigests: sortedUniqueStrings(
      document.revokedAuthorityDigests,
      "pins revokedAuthorityDigests",
      maximumRevocations,
      (entry) => shaPattern.test(entry),
    ),
  };
  const pinsDigest = sha(document.pinsDigest, "pins pinsDigest");
  if (pinsDigest !== canonicalSha256(basis)) {
    fail("OPERATOR_AUTHORITY_CANONICAL_INVALID", "pinsDigest");
  }
  return deepFreeze({ ...basis, pinsDigest });
}

export function validateOperatorAuthorityBundle(
  value: unknown,
): OperatorAuthorityBundle {
  const document = record(value, "operator authority bundle");
  exact(document, [
    "schemaVersion",
    "authorityId",
    "generation",
    "issuedAt",
    "expiresAt",
    "status",
    "fileAuthorities",
    "hostInputs",
    "mcp",
    "authorityDigest",
  ], "operator authority bundle");
  if (document.schemaVersion !== OPERATOR_AUTHORITY_BUNDLE_VERSION ||
    (document.status !== "active" && document.status !== "revoked")) {
    fail("OPERATOR_AUTHORITY_SCHEMA_INVALID", "authority bundle header");
  }
  const files = record(document.fileAuthorities, "fileAuthorities");
  exact(files, [
    "profileAdmission",
    "contextRoute",
    "codexAdapterInstallation",
    "claudeAdapterInstallation",
    "compatibilityAdmission",
  ], "fileAuthorities");
  const hosts = record(document.hostInputs, "hostInputs");
  exact(hosts, [
    "codexAdapter",
    "claudeAdapter",
    "claudeAdapterActivation",
  ], "hostInputs");
  const mcp = record(document.mcp, "mcp");
  exact(mcp, ["writeCommands"], "mcp");

  const issuedAt = instant(document.issuedAt, "issuedAt");
  const expiresAt = instant(document.expiresAt, "expiresAt");
  if (parseStrictInstant(issuedAt) >= parseStrictInstant(expiresAt)) {
    fail("OPERATOR_AUTHORITY_SCHEMA_INVALID", "authority validity window");
  }
  const basis = {
    schemaVersion: OPERATOR_AUTHORITY_BUNDLE_VERSION,
    authorityId: authorityId(document.authorityId, "authorityId"),
    generation: positiveInteger(document.generation, "generation"),
    issuedAt,
    expiresAt,
    status: document.status as "active" | "revoked",
    fileAuthorities: {
      profileAdmission: fileExpectation(
        files.profileAdmission,
        "fileAuthorities.profileAdmission",
      ) as GenericProfileAdmissionAuthority | null,
      contextRoute: fileExpectation(
        files.contextRoute,
        "fileAuthorities.contextRoute",
      ) as ContextRouteAuthorityFileIdentity | null,
      codexAdapterInstallation: fileExpectation(
        files.codexAdapterInstallation,
        "fileAuthorities.codexAdapterInstallation",
      ) as CodexAdapterInstallationFileIdentity | null,
      claudeAdapterInstallation: fileExpectation(
        files.claudeAdapterInstallation,
        "fileAuthorities.claudeAdapterInstallation",
      ) as ClaudeAdapterInstallationFileIdentity | null,
      compatibilityAdmission: fileExpectation(
        files.compatibilityAdmission,
        "fileAuthorities.compatibilityAdmission",
      ) as CompatibilityAdmissionAuthority | null,
    },
    hostInputs: {
      codexAdapter: nullableHostInput(
        hosts.codexAdapter,
        "hostInputs.codexAdapter",
      ),
      claudeAdapter: nullableHostInput(
        hosts.claudeAdapter,
        "hostInputs.claudeAdapter",
      ),
      claudeAdapterActivation: nullableHostInput(
        hosts.claudeAdapterActivation,
        "hostInputs.claudeAdapterActivation",
      ),
    },
    mcp: {
      writeCommands: sortedUniqueStrings(
        mcp.writeCommands,
        "mcp.writeCommands",
        maximumCommands,
        (entry) => commandPattern.test(entry),
      ),
    },
  };
  const authorityDigest = sha(
    document.authorityDigest,
    "authorityDigest",
  );
  if (authorityDigest !== canonicalSha256(basis)) {
    fail("OPERATOR_AUTHORITY_CANONICAL_INVALID", "authorityDigest");
  }
  return deepFreeze({ ...basis, authorityDigest });
}

const fileReasonCodes: AuthorityFileReasonCodes<OperatorAuthorityReasonCode> =
  Object.freeze({
    required: "OPERATOR_AUTHORITY_REQUIRED",
    path: "OPERATOR_AUTHORITY_PATH",
    digest: "OPERATOR_AUTHORITY_DIGEST",
    changed: "OPERATOR_AUTHORITY_CHANGED",
    link: "OPERATOR_AUTHORITY_LINK",
    specialFile: "OPERATOR_AUTHORITY_SPECIAL_FILE",
    limitExceeded: "OPERATOR_AUTHORITY_LIMIT_EXCEEDED",
    notUtf8: "OPERATOR_AUTHORITY_CANONICAL_INVALID",
    notJson: "OPERATOR_AUTHORITY_CANONICAL_INVALID",
    notCanonical: "OPERATOR_AUTHORITY_CANONICAL_INVALID",
  });

async function readOperatorFile(
  path: string,
  expectation: AuthorityFileExpectation | undefined,
): Promise<AuthorityFileResult> {
  return readAuthorityFile(path, expectation, {
    maximumBytes: maximumAuthorityBytes,
    codes: fileReasonCodes,
    details: {
      required: "out-of-band canonical path and SHA-256 pins are required",
      expectedDigest: "expectedFileSha256",
    },
    fail,
    isOwnError: (error) => error instanceof OperatorAuthorityError,
  });
}

export async function readOperatorAuthority(
  pinsPath: string,
  pinsExpectation: AuthorityFileExpectation | undefined,
  verificationTime: string,
): Promise<OperatorAuthorityContext> {
  let now: bigint;
  try {
    now = parseStrictInstant(verificationTime);
  } catch {
    fail("OPERATOR_AUTHORITY_SCHEMA_INVALID", "verificationTime");
  }
  const pinsSource = await readOperatorFile(pinsPath, pinsExpectation);
  const pins = validateOperatorAuthorityPins(pinsSource.parsed);
  const authoritySource = await readOperatorFile(pins.authorityPath, {
    expectedCanonicalPath: pins.authorityPath,
    expectedFileSha256: pins.authorityFileSha256,
  });
  const bundle = validateOperatorAuthorityBundle(authoritySource.parsed);
  if (bundle.authorityId !== pins.authorityId) {
    fail("OPERATOR_AUTHORITY_BINDING_MISMATCH", "authorityId");
  }
  if (bundle.generation < pins.minimumGeneration) {
    fail("OPERATOR_AUTHORITY_ROLLBACK", "generation below pins floor");
  }
  if (bundle.status === "revoked" ||
    pins.revokedAuthorityDigests.includes(bundle.authorityDigest)) {
    fail("OPERATOR_AUTHORITY_REVOKED", bundle.authorityId);
  }
  if (now < parseStrictInstant(bundle.issuedAt) ||
    now >= parseStrictInstant(bundle.expiresAt)) {
    fail("OPERATOR_AUTHORITY_EXPIRED", bundle.authorityId);
  }

  let codexAdapterHost: CodexAdapterHostContext | undefined;
  let claudeAdapterHost: ClaudeAdapterHostContext | undefined;
  let claudeAdapterActivationHost:
    ClaudeAdapterActivationHostContext | undefined;
  try {
    codexAdapterHost = bundle.hostInputs.codexAdapter === null
      ? undefined
      : admitCodexAdapterHostInput(bundle.hostInputs.codexAdapter);
    claudeAdapterHost = bundle.hostInputs.claudeAdapter === null
      ? undefined
      : admitClaudeAdapterHostInput(bundle.hostInputs.claudeAdapter);
    claudeAdapterActivationHost =
      bundle.hostInputs.claudeAdapterActivation === null
        ? undefined
        : admitClaudeAdapterActivationHostInput(
          bundle.hostInputs.claudeAdapterActivation,
        );
    for (const host of [
      codexAdapterHost,
      claudeAdapterHost,
      claudeAdapterActivationHost,
    ]) {
      if (host !== undefined &&
        (now < parseStrictInstant(host.input.contextIssuedAt) ||
          now >= parseStrictInstant(host.input.contextExpiresAt))) {
        fail("OPERATOR_AUTHORITY_HOST_INVALID", "host context stale at operator verification time");
      }
    }
  } catch (error) {
    if (error instanceof OperatorAuthorityError) throw error;
    const reasonCode = typeof (error as { reasonCode?: unknown }).reasonCode ===
      "string"
      ? (error as { reasonCode: string }).reasonCode
      : "unknown";
    fail("OPERATOR_AUTHORITY_HOST_INVALID", reasonCode);
  }

  return deepFreeze({
    pins,
    bundle,
    pinsSourcePath: pinsSource.canonicalPath,
    pinsFileSha256: pinsSource.fileSha256,
    pinsSourceIdentityDigest: pinsSource.sourceIdentityDigest,
    authoritySourcePath: authoritySource.canonicalPath,
    authorityFileSha256: authoritySource.fileSha256,
    authoritySourceIdentityDigest: authoritySource.sourceIdentityDigest,
    ...(bundle.fileAuthorities.profileAdmission === null
      ? {}
      : {
        profileAdmissionAuthority:
          bundle.fileAuthorities.profileAdmission,
      }),
    ...(bundle.fileAuthorities.contextRoute === null
      ? {}
      : { contextRouteAuthority: bundle.fileAuthorities.contextRoute }),
    ...(codexAdapterHost === undefined ? {} : { codexAdapterHost }),
    ...(bundle.fileAuthorities.codexAdapterInstallation === null
      ? {}
      : {
        codexAdapterInstallationAuthority:
          bundle.fileAuthorities.codexAdapterInstallation,
      }),
    ...(claudeAdapterHost === undefined ? {} : { claudeAdapterHost }),
    ...(claudeAdapterActivationHost === undefined
      ? {}
      : { claudeAdapterActivationHost }),
    ...(bundle.fileAuthorities.claudeAdapterInstallation === null
      ? {}
      : {
        claudeAdapterInstallationAuthority:
          bundle.fileAuthorities.claudeAdapterInstallation,
      }),
    ...(bundle.fileAuthorities.compatibilityAdmission === null
      ? {}
      : {
        compatibilityAdmissionAuthority:
          bundle.fileAuthorities.compatibilityAdmission,
      }),
  });
}

export function assertOperatorMcpWriteGranted(
  context: OperatorAuthorityContext,
  command: string,
): void {
  if (!context.bundle.mcp.writeCommands.includes(command)) {
    fail("OPERATOR_AUTHORITY_COMMAND_NOT_GRANTED", command);
  }
}
