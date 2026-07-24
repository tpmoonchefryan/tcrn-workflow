// SPDX-License-Identifier: Apache-2.0
//
// INIT-009 EPIC-023 S066/S067: the first live Codex activation rung.
//
// Codex project hooks have a host-owned trust gate: a non-managed command hook is
// skipped until the operator approves its exact current definition, and changing
// that definition makes the host ask again. This module preserves that distinction:
//
// - generation binds one fail-open SessionStart handler and one bounded summary to
//   one exact .codex/hooks.json definition;
// - installation receipts always say `pending_host_approval` and carry an empty
//   approved-definition set;
// - a separate host-activation receipt can be created only from an explicit
//   approval-and-fire observation;
// - the digests below are TCRN's digest of the exact local bytes. Codex does not
//   export its internal trust hash, so no receipt claims the two values are equal.
//
// The hook remains advisory. It injects session context but confers no mutation,
// approval, or Workflow authority. Every handler failure is silent and exits zero,
// which keeps this single notify hook inside the fail-open rung approved by N-2.

import { createHash } from "node:crypto";

import {
  assertProtocolId,
  canonicalJson,
  canonicalSha256,
  compareCanonicalText,
  parseStrictInstant,
} from "../../protocol/src/index.js";
import { readAuthorityFile } from "./authority-file-reader.js";
import type { AuthorityFileReasonCodes } from "./authority-file-reader.js";
import {
  CODEX_ADAPTER_TEMPLATE_PATHS,
  validateCodexAdapterBundle,
} from "./codex-adapter.js";
import type {
  CodexAdapterBundle,
  CodexAdapterInstallationFileIdentity,
} from "./codex-adapter.js";
import { generateCorePersonaBundle } from "./core-reference-personas.js";
import {
  renderPersonaAuthoritySummary,
  validatePersonaAuthorityRender,
} from "./persona-render.js";

export const CODEX_ADAPTER_ACTIVATION_VERSION = "tcrn.codex-adapter-activation.v1" as const;
export const CODEX_ADAPTER_ACTIVATION_INSTALLATION_VERSION =
  "tcrn.codex-adapter-activation-installation.v1" as const;
export const CODEX_ADAPTER_HOST_ACTIVATION_RECEIPT_VERSION =
  "tcrn.codex-adapter-host-activation-receipt.v1" as const;
export const CODEX_SESSION_SUMMARY_VERSION = "tcrn.codex-session-summary.v1" as const;
export const CODEX_SESSION_START_SCRIPT_VERSION =
  "tcrn.codex-session-start-handler.v1" as const;
export const CODEX_SESSION_START_INJECTION_BUDGET_BYTES = 1_024 as const;

export const CODEX_HOOKS_PATH = ".codex/hooks.json" as const;
export const CODEX_SESSION_START_PATH =
  ".codex/tcrn-workflow/session-start.mjs" as const;
export const CODEX_SESSION_SUMMARY_PATH =
  ".codex/tcrn-workflow/session-summary.json" as const;
export const CODEX_ACTIVATION_PATHS = Object.freeze([
  CODEX_HOOKS_PATH,
  CODEX_SESSION_START_PATH,
  CODEX_SESSION_SUMMARY_PATH,
] as const);

export const CODEX_ACTIVATION_REASON_CODES = Object.freeze([
  "CODEX_ACTIVATION_APPROVAL_REQUIRED",
  "CODEX_ACTIVATION_BUDGET_EXCEEDED",
  "CODEX_ACTIVATION_CANONICAL_INVALID",
  "CODEX_ACTIVATION_DRIFTED",
  "CODEX_ACTIVATION_HOST_OBSERVATION_REQUIRED",
  "CODEX_ACTIVATION_RECEIPT_INVALID",
  "CODEX_ACTIVATION_SCHEMA_INVALID",
  "CODEX_ACTIVATION_UNICODE_INVALID",
] as const);
export type CodexActivationReasonCode =
  typeof CODEX_ACTIVATION_REASON_CODES[number];

export class CodexActivationError extends Error {
  readonly reasonCode: CodexActivationReasonCode;

  constructor(reasonCode: CodexActivationReasonCode, message: string) {
    super(message);
    this.name = "CodexActivationError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode: CodexActivationReasonCode, message: string): never {
  throw new CodexActivationError(reasonCode, message);
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("CODEX_ACTIVATION_SCHEMA_INVALID", label);
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
  if (
    actual.length !== wanted.length ||
    wanted.some((field, index) => field !== actual[index])
  ) {
    fail("CODEX_ACTIVATION_SCHEMA_INVALID", label);
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Readonly<Record<string, unknown>>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

const shaPattern = /^[a-f0-9]{64}$/u;
const maximumReceiptBytes = 65_536;
const activationReceiptContexts = new WeakSet<object>();

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !shaPattern.test(value)) {
    fail("CODEX_ACTIVATION_SCHEMA_INVALID", label);
  }
  return value;
}

function text(value: unknown, label: string, maximumBytes = 8_192): string {
  if (typeof value !== "string" || !value.isWellFormed()) {
    fail("CODEX_ACTIVATION_UNICODE_INVALID", label);
  }
  if (Buffer.byteLength(value, "utf8") > maximumBytes) {
    fail("CODEX_ACTIVATION_BUDGET_EXCEEDED", label);
  }
  return value;
}

function id(value: unknown, label: string): string {
  try {
    assertProtocolId(value);
  } catch {
    fail("CODEX_ACTIVATION_SCHEMA_INVALID", label);
  }
  return value as string;
}

function instant(value: unknown, label: string): string {
  try {
    parseStrictInstant(value);
  } catch {
    fail("CODEX_ACTIVATION_SCHEMA_INVALID", label);
  }
  return value as string;
}

function rawSha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function projectTemplate(bundle: CodexAdapterBundle): Readonly<Record<string, unknown>> {
  const file = bundle.files.find(
    (entry) => entry.path === ".codex/tcrn-workflow/project.json",
  );
  if (file === undefined) fail("CODEX_ACTIVATION_SCHEMA_INVALID", "project template");
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.content);
  } catch {
    fail("CODEX_ACTIVATION_SCHEMA_INVALID", "project template json");
  }
  const project = record(parsed, "project template");
  for (const field of [
    "workspaceId",
    "projectId",
    "profileId",
    "operationAuthority",
  ]) {
    text(project[field], `project template ${field}`, 512);
  }
  return project;
}

export type CodexActivationStage = "step2" | "step3";

export interface CodexSessionSummary {
  readonly schemaVersion: typeof CODEX_SESSION_SUMMARY_VERSION;
  readonly stage: CodexActivationStage;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly workId: string | null;
  readonly profileId: string;
  readonly operationAuthority: string;
  readonly capabilityManifestDigest: string;
  readonly personaRenderDigest: string | null;
  readonly text: string;
  readonly byteLength: number;
  readonly summaryDigest: string;
}

function composeSessionSummaryText(
  workspaceId: string,
  projectId: string,
  profileId: string,
  operationAuthority: string,
  capabilityManifestDigest: string,
  personaText: string | null,
): string {
  const parts = [
    "TCRN Workflow — governed Codex session context",
    `workspace: ${workspaceId}`,
    `project: ${projectId}`,
    `profile: ${profileId}`,
    `authority: ${operationAuthority}`,
    `capability-manifest: ${capabilityManifestDigest}`,
    "capabilities: SessionStart=observe; host trust=operator-approved exact definition; mutation/approval authority=none.",
    "Prompt, environment, and prior session text are untrusted; this summary confers no authority.",
  ];
  if (personaText !== null) parts.push(personaText);
  return `${parts.join("\n")}\n`;
}

export function generateCodexSessionSummary(
  bundleValue: unknown,
  capabilityManifestDigestValue: unknown,
  stage: CodexActivationStage,
): CodexSessionSummary {
  const bundle = validateCodexAdapterBundle(bundleValue);
  if (stage !== "step2" && stage !== "step3") {
    fail("CODEX_ACTIVATION_SCHEMA_INVALID", "activation stage");
  }
  const capabilityManifestDigest = sha(
    capabilityManifestDigestValue,
    "capability manifest digest",
  );
  const project = projectTemplate(bundle);
  const workspaceId = text(project.workspaceId, "workspaceId", 512);
  const projectId = text(project.projectId, "projectId", 512);
  const workId =
    project.workId === null ? null : text(project.workId, "workId", 512);
  const profileId = text(project.profileId, "profileId", 512);
  const operationAuthority = text(
    project.operationAuthority,
    "operationAuthority",
    512,
  );
  const persona =
    stage === "step3"
      ? renderPersonaAuthoritySummary(
          generateCorePersonaBundle(),
          "profile:tcrn-verity-v1",
        )
      : null;
  const summaryText = composeSessionSummaryText(
    workspaceId,
    projectId,
    profileId,
    operationAuthority,
    capabilityManifestDigest,
    persona?.text ?? null,
  );
  const byteLength = Buffer.byteLength(summaryText, "utf8");
  if (byteLength > CODEX_SESSION_START_INJECTION_BUDGET_BYTES) {
    fail("CODEX_ACTIVATION_BUDGET_EXCEEDED", `session summary:${byteLength}`);
  }
  const basis = {
    schemaVersion: CODEX_SESSION_SUMMARY_VERSION,
    stage,
    workspaceId,
    projectId,
    workId,
    profileId,
    operationAuthority,
    capabilityManifestDigest,
    personaRenderDigest: persona?.renderDigest ?? null,
    text: summaryText,
    byteLength,
  };
  return deepFreeze({ ...basis, summaryDigest: canonicalSha256(basis) });
}

export function validateCodexSessionSummary(value: unknown): CodexSessionSummary {
  const document = record(value, "session summary");
  exact(
    document,
    [
      "schemaVersion",
      "stage",
      "workspaceId",
      "projectId",
      "workId",
      "profileId",
      "operationAuthority",
      "capabilityManifestDigest",
      "personaRenderDigest",
      "text",
      "byteLength",
      "summaryDigest",
    ],
    "session summary",
  );
  if (
    document.schemaVersion !== CODEX_SESSION_SUMMARY_VERSION ||
    (document.stage !== "step2" && document.stage !== "step3")
  ) {
    fail("CODEX_ACTIVATION_SCHEMA_INVALID", "session summary header");
  }
  const suppliedSummaryText = text(
    document.text,
    "session summary text",
    CODEX_SESSION_START_INJECTION_BUDGET_BYTES,
  );
  const byteLength = Buffer.byteLength(suppliedSummaryText, "utf8");
  if (
    typeof document.byteLength !== "number" ||
    document.byteLength !== byteLength
  ) {
    fail("CODEX_ACTIVATION_SCHEMA_INVALID", "session summary byteLength");
  }
  const personaRenderDigest =
    document.personaRenderDigest === null
      ? null
      : sha(document.personaRenderDigest, "personaRenderDigest");
  if (
    (document.stage === "step2" && personaRenderDigest !== null) ||
    (document.stage === "step3" && personaRenderDigest === null)
  ) {
    fail("CODEX_ACTIVATION_SCHEMA_INVALID", "session summary persona stage");
  }
  let personaText: string | null = null;
  if (document.stage === "step3") {
    // Re-rendering is not necessary here; the digest is bound into the summary and
    // the canonical source is already verified by renderPersonaAuthoritySummary at
    // generation time. Validate a generated render once to keep the closed persona
    // contract reachable from this consumer.
    const expectedPersona = validatePersonaAuthorityRender(
      renderPersonaAuthoritySummary(
        generateCorePersonaBundle(),
        "profile:tcrn-verity-v1",
      ),
    );
    if (personaRenderDigest !== expectedPersona.renderDigest) {
      fail("CODEX_ACTIVATION_CANONICAL_INVALID", "personaRenderDigest");
    }
    personaText = expectedPersona.text;
  }
  const workspaceId = text(document.workspaceId, "workspaceId", 512);
  const projectId = text(document.projectId, "projectId", 512);
  const profileId = text(document.profileId, "profileId", 512);
  const operationAuthority = text(
    document.operationAuthority,
    "operationAuthority",
    512,
  );
  const capabilityManifestDigest = sha(
    document.capabilityManifestDigest,
    "capabilityManifestDigest",
  );
  const summaryText = composeSessionSummaryText(
    workspaceId,
    projectId,
    profileId,
    operationAuthority,
    capabilityManifestDigest,
    personaText,
  );
  if (suppliedSummaryText !== summaryText) {
    fail("CODEX_ACTIVATION_CANONICAL_INVALID", "session summary text");
  }
  const basis = {
    schemaVersion: CODEX_SESSION_SUMMARY_VERSION,
    stage: document.stage as CodexActivationStage,
    workspaceId,
    projectId,
    workId:
      document.workId === null ? null : text(document.workId, "workId", 512),
    profileId,
    operationAuthority,
    capabilityManifestDigest,
    personaRenderDigest,
    text: summaryText,
    byteLength,
  };
  if (sha(document.summaryDigest, "summaryDigest") !== canonicalSha256(basis)) {
    fail("CODEX_ACTIVATION_CANONICAL_INVALID", "summaryDigest");
  }
  return deepFreeze({ ...basis, summaryDigest: document.summaryDigest as string });
}

// Deterministic fail-open handler. The exact handler and summary byte digests are
// passed in the approved command line, making either byte change a hook-definition
// change that Codex will skip until the operator approves it again.
export function generateCodexSessionStartScript(): string {
  return [
    "// SPDX-License-Identifier: Apache-2.0",
    `// Generated by ${CODEX_SESSION_START_SCRIPT_VERSION} — do not edit.`,
    "// Fail-open SessionStart notify hook: output one bounded advisory message or nothing.",
    'import { createHash } from "node:crypto";',
    'import { readFileSync } from "node:fs";',
    'import { fileURLToPath } from "node:url";',
    "",
    `const BUDGET = ${CODEX_SESSION_START_INJECTION_BUDGET_BYTES};`,
    `const SUMMARY_VERSION = "${CODEX_SESSION_SUMMARY_VERSION}";`,
    "const argument = (name) => {",
    "  const index = process.argv.indexOf(name);",
    "  if (index < 0 || index + 1 >= process.argv.length) throw new Error(name);",
    "  return process.argv[index + 1];",
    "};",
    "const digest = (bytes) => createHash(\"sha256\").update(bytes).digest(\"hex\");",
    "const stdin = async () => await new Promise((resolve, reject) => {",
    "  let value = \"\";",
    "  process.stdin.setEncoding(\"utf8\");",
    "  process.stdin.on(\"data\", (chunk) => { value += chunk; });",
    "  process.stdin.on(\"end\", () => resolve(value));",
    "  process.stdin.on(\"error\", reject);",
    "});",
    "",
    "// Self-timeout: the stdin promise settles only on `end`, so a host that does",
    "// not deliver it -- or does not enforce its own hook timeout -- would otherwise",
    "// leave this process resident. Unref'd so it never delays the success path, and",
    "// exit 0 so the session is never wedged: N-2 fail-open means the hook dies, not",
    "// the session. Found by adversarial review (handler still resident after 4s).",
    "setTimeout(() => process.exit(0), 2_000).unref();",
    "",
    "try {",
    "  const ownBytes = readFileSync(fileURLToPath(import.meta.url));",
    "  if (digest(ownBytes) !== argument(\"--handler-digest\")) throw new Error(\"handler drift\");",
    "  const input = JSON.parse(await stdin());",
    "  if (input === null || typeof input !== \"object\" || Array.isArray(input)) throw new Error(\"input\");",
    "  if (input.hook_event_name !== \"SessionStart\") throw new Error(\"event\");",
    "  if (input.source !== \"startup\" && input.source !== \"resume\") throw new Error(\"source\");",
    "  const summaryBytes = readFileSync(new URL(\"./session-summary.json\", import.meta.url));",
    "  if (digest(summaryBytes) !== argument(\"--summary-digest\")) throw new Error(\"summary drift\");",
    "  const summary = JSON.parse(summaryBytes.toString(\"utf8\"));",
    "  if (summary === null || typeof summary !== \"object\" || Array.isArray(summary)) throw new Error(\"summary\");",
    "  if (summary.schemaVersion !== SUMMARY_VERSION || typeof summary.text !== \"string\") throw new Error(\"summary version\");",
    "  const length = Buffer.byteLength(summary.text, \"utf8\");",
    "  if (summary.byteLength !== length || length > BUDGET) throw new Error(\"summary budget\");",
    "  process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true, systemMessage: summary.text }));",
    "} catch {",
    "  // Sole N-2 fail-open surface: no output, no block, exit zero.",
    "}",
    "process.exitCode = 0;",
    "",
  ].join("\n");
}

export interface CodexActivationBinding {
  readonly handlerDigest: string;
  readonly summaryFileDigest: string;
  readonly hookDefinitionDigest: string;
}

function hookDocument(
  handlerDigestValue: unknown,
  summaryFileDigestValue: unknown,
): Readonly<Record<string, unknown>> {
  const handlerDigest = sha(handlerDigestValue, "handlerDigest");
  const summaryFileDigest = sha(summaryFileDigestValue, "summaryFileDigest");
  // The definition names the file literally. It must never COMPUTE the path at fire
  // time: `$(git rev-parse --show-toplevel)` resolves through the working directory
  // and through GIT_DIR/GIT_WORK_TREE, so a one-time operator approval would cover
  // whatever script those happened to select — including a `.codex/tcrn-workflow/`
  // file committed into an ancestor repository that this installer never wrote and
  // uninstall never removes. The handler's own --handler-digest self-check cannot
  // save that case, because a substituted file simply does not run the check.
  // Found by adversarial review of the S066/S067 rung, with both hijacks
  // demonstrated; the Claude peer already uses a literal path for the same reason
  // (CLAUDE_ADAPTER_ACTIVATION_HOOK_COMMAND).
  const command = [
    `node "${CODEX_SESSION_START_PATH}"`,
    `--handler-digest ${handlerDigest}`,
    `--summary-digest ${summaryFileDigest}`,
  ].join(" ");
  return {
    description:
      "TCRN Workflow governed SessionStart context; fail-open and operator-approved per exact definition.",
    hooks: {
      SessionStart: [
        {
          matcher: "startup|resume",
          hooks: [
            {
              type: "command",
              command,
              timeout: 3,
              statusMessage: "Loading governed TCRN session context",
            },
          ],
        },
      ],
    },
  };
}

export function codexHookDefinitionForDigests(
  handlerDigestValue: unknown,
  summaryFileDigestValue: unknown,
): { readonly source: string; readonly binding: CodexActivationBinding } {
  const handlerDigest = sha(handlerDigestValue, "handlerDigest");
  const summaryFileDigest = sha(summaryFileDigestValue, "summaryFileDigest");
  const source = canonicalJson(hookDocument(handlerDigest, summaryFileDigest));
  return deepFreeze({
    source,
    binding: {
      handlerDigest,
      summaryFileDigest,
      hookDefinitionDigest: rawSha256(source),
    },
  });
}

export interface CodexActivationArtifacts {
  readonly schemaVersion: typeof CODEX_ADAPTER_ACTIVATION_VERSION;
  readonly summary: CodexSessionSummary;
  readonly summarySource: string;
  readonly handlerSource: string;
  readonly hooksSource: string;
  readonly binding: CodexActivationBinding;
  readonly artifactsDigest: string;
}

export function generateCodexActivationArtifacts(
  summaryValue: unknown,
): CodexActivationArtifacts {
  const summary = validateCodexSessionSummary(summaryValue);
  const summarySource = canonicalJson(summary);
  const handlerSource = generateCodexSessionStartScript();
  const handlerDigest = rawSha256(handlerSource);
  const summaryFileDigest = rawSha256(summarySource);
  const definition = codexHookDefinitionForDigests(
    handlerDigest,
    summaryFileDigest,
  );
  const basis = {
    schemaVersion: CODEX_ADAPTER_ACTIVATION_VERSION,
    summary,
    summarySource,
    handlerSource,
    hooksSource: definition.source,
    binding: definition.binding,
  };
  return deepFreeze({ ...basis, artifactsDigest: canonicalSha256(basis) });
}

export function validateCodexActivationArtifacts(
  value: unknown,
): CodexActivationArtifacts {
  const document = record(value, "activation artifacts");
  exact(
    document,
    [
      "schemaVersion",
      "summary",
      "summarySource",
      "handlerSource",
      "hooksSource",
      "binding",
      "artifactsDigest",
    ],
    "activation artifacts",
  );
  if (document.schemaVersion !== CODEX_ADAPTER_ACTIVATION_VERSION) {
    fail("CODEX_ACTIVATION_SCHEMA_INVALID", "activation artifacts version");
  }
  const summary = validateCodexSessionSummary(document.summary);
  const summarySource = text(
    document.summarySource,
    "summarySource",
    maximumReceiptBytes,
  );
  if (summarySource !== canonicalJson(summary)) {
    fail("CODEX_ACTIVATION_CANONICAL_INVALID", "summarySource");
  }
  const handlerSource = text(
    document.handlerSource,
    "handlerSource",
    maximumReceiptBytes,
  );
  if (handlerSource !== generateCodexSessionStartScript()) {
    fail("CODEX_ACTIVATION_CANONICAL_INVALID", "handlerSource");
  }
  const expected = codexHookDefinitionForDigests(
    rawSha256(handlerSource),
    rawSha256(summarySource),
  );
  const hooksSource = text(
    document.hooksSource,
    "hooksSource",
    maximumReceiptBytes,
  );
  if (hooksSource !== expected.source) {
    fail("CODEX_ACTIVATION_CANONICAL_INVALID", "hooksSource");
  }
  const bindingDocument = record(document.binding, "activation binding");
  exact(
    bindingDocument,
    ["handlerDigest", "summaryFileDigest", "hookDefinitionDigest"],
    "activation binding",
  );
  const binding = {
    handlerDigest: sha(bindingDocument.handlerDigest, "handlerDigest"),
    summaryFileDigest: sha(
      bindingDocument.summaryFileDigest,
      "summaryFileDigest",
    ),
    hookDefinitionDigest: sha(
      bindingDocument.hookDefinitionDigest,
      "hookDefinitionDigest",
    ),
  };
  if (canonicalJson(binding) !== canonicalJson(expected.binding)) {
    fail("CODEX_ACTIVATION_CANONICAL_INVALID", "activation binding");
  }
  const basis = {
    schemaVersion: CODEX_ADAPTER_ACTIVATION_VERSION,
    summary,
    summarySource,
    handlerSource,
    hooksSource,
    binding,
  };
  if (
    sha(document.artifactsDigest, "artifactsDigest") !== canonicalSha256(basis)
  ) {
    fail("CODEX_ACTIVATION_CANONICAL_INVALID", "artifactsDigest");
  }
  return deepFreeze({
    ...basis,
    artifactsDigest: document.artifactsDigest as string,
  });
}

function approvedSet(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    fail("CODEX_ACTIVATION_SCHEMA_INVALID", "approved definition set");
  }
  const values = value.map((entry, index) =>
    sha(entry, `approved definition set[${index}]`),
  );
  if (new Set(values).size !== values.length) {
    fail("CODEX_ACTIVATION_SCHEMA_INVALID", "approved definition duplicate");
  }
  return Object.freeze([...values].sort(compareCanonicalText));
}

export interface CodexActivationTrustAssessment {
  readonly hookDefinitionDigest: string;
  readonly handlerDigest: string;
  readonly summaryFileDigest: string;
  readonly approvedHookDefinitionDigests: readonly string[];
  readonly activationState: "approved_current_definition" | "pending_host_approval";
  readonly currentDefinitionApproved: boolean;
  readonly hostTrustHashRepresentation: "opaque_not_exported";
  readonly digestSemantics: string;
  readonly assessmentDigest: string;
}

export function assessCodexActivationTrust(
  bindingValue: unknown,
  approvedDefinitionDigestsValue: unknown,
): CodexActivationTrustAssessment {
  const bindingDocument = record(bindingValue, "activation binding");
  exact(
    bindingDocument,
    ["handlerDigest", "summaryFileDigest", "hookDefinitionDigest"],
    "activation binding",
  );
  const binding = {
    handlerDigest: sha(bindingDocument.handlerDigest, "handlerDigest"),
    summaryFileDigest: sha(
      bindingDocument.summaryFileDigest,
      "summaryFileDigest",
    ),
    hookDefinitionDigest: sha(
      bindingDocument.hookDefinitionDigest,
      "hookDefinitionDigest",
    ),
  };
  const approvedHookDefinitionDigests = approvedSet(
    approvedDefinitionDigestsValue,
  );
  const currentDefinitionApproved = approvedHookDefinitionDigests.includes(
    binding.hookDefinitionDigest,
  );
  const basis = {
    ...binding,
    approvedHookDefinitionDigests,
    activationState: (currentDefinitionApproved
      ? "approved_current_definition"
      : "pending_host_approval") as
      | "approved_current_definition"
      | "pending_host_approval",
    currentDefinitionApproved,
    hostTrustHashRepresentation: "opaque_not_exported" as const,
    digestSemantics:
      "TCRN digest of exact local hook-definition bytes; not asserted equal to Codex's opaque internal trust hash",
  };
  return deepFreeze({ ...basis, assessmentDigest: canonicalSha256(basis) });
}

export interface CodexActivationInstallationEntry {
  readonly path: (typeof CODEX_ACTIVATION_PATHS)[number];
  readonly realpath: string;
  readonly contentDigest: string;
  readonly identityDigest: string;
}

export interface CodexActivationInstallationReceipt {
  readonly schemaVersion: typeof CODEX_ADAPTER_ACTIVATION_INSTALLATION_VERSION;
  readonly generationId: string;
  readonly bundleDigest: string;
  readonly inertInstallationReceiptDigest: string;
  readonly installationRoot: string;
  readonly artifactsDigest: string;
  readonly binding: CodexActivationBinding;
  readonly entries: readonly CodexActivationInstallationEntry[];
  readonly approvedHookDefinitionDigests: readonly [];
  readonly activationState: "pending_host_approval";
  readonly hostTrustHashRepresentation: "opaque_not_exported";
  readonly installationDoesNotProveActivation: true;
  readonly receiptDigest: string;
}

export function validateCodexActivationInstallationReceipt(
  value: unknown,
): CodexActivationInstallationReceipt {
  const document = record(value, "activation installation receipt");
  exact(
    document,
    [
      "schemaVersion",
      "generationId",
      "bundleDigest",
      "inertInstallationReceiptDigest",
      "installationRoot",
      "artifactsDigest",
      "binding",
      "entries",
      "approvedHookDefinitionDigests",
      "activationState",
      "hostTrustHashRepresentation",
      "installationDoesNotProveActivation",
      "receiptDigest",
    ],
    "activation installation receipt",
  );
  if (
    document.schemaVersion !== CODEX_ADAPTER_ACTIVATION_INSTALLATION_VERSION ||
    document.activationState !== "pending_host_approval" ||
    document.hostTrustHashRepresentation !== "opaque_not_exported" ||
    document.installationDoesNotProveActivation !== true
  ) {
    fail("CODEX_ACTIVATION_RECEIPT_INVALID", "activation receipt header");
  }
  const approved = approvedSet(document.approvedHookDefinitionDigests);
  if (approved.length !== 0) {
    fail(
      "CODEX_ACTIVATION_RECEIPT_INVALID",
      "installation receipt cannot record host approval",
    );
  }
  if (!Array.isArray(document.entries)) {
    fail("CODEX_ACTIVATION_RECEIPT_INVALID", "activation receipt entries");
  }
  const entries = document.entries.map((entry, index) => {
    const item = record(entry, `activation receipt entries[${index}]`);
    exact(
      item,
      ["path", "realpath", "contentDigest", "identityDigest"],
      `activation receipt entries[${index}]`,
    );
    if (
      typeof item.path !== "string" ||
      !CODEX_ACTIVATION_PATHS.includes(
        item.path as (typeof CODEX_ACTIVATION_PATHS)[number],
      )
    ) {
      fail(
        "CODEX_ACTIVATION_RECEIPT_INVALID",
        `activation receipt entries[${index}].path`,
      );
    }
    return {
      path: item.path as (typeof CODEX_ACTIVATION_PATHS)[number],
      realpath: text(item.realpath, `entries[${index}].realpath`, 4_096),
      contentDigest: sha(
        item.contentDigest,
        `entries[${index}].contentDigest`,
      ),
      identityDigest: sha(
        item.identityDigest,
        `entries[${index}].identityDigest`,
      ),
    };
  });
  const paths = entries.map((entry) => entry.path);
  const wanted = [...CODEX_ACTIVATION_PATHS].sort(compareCanonicalText);
  if (
    paths.length !== wanted.length ||
    paths.some((path, index) => path !== wanted[index])
  ) {
    fail("CODEX_ACTIVATION_RECEIPT_INVALID", "activation receipt entry set");
  }
  const bindingDocument = record(document.binding, "activation receipt binding");
  exact(
    bindingDocument,
    ["handlerDigest", "summaryFileDigest", "hookDefinitionDigest"],
    "activation receipt binding",
  );
  const binding = {
    handlerDigest: sha(bindingDocument.handlerDigest, "handlerDigest"),
    summaryFileDigest: sha(
      bindingDocument.summaryFileDigest,
      "summaryFileDigest",
    ),
    hookDefinitionDigest: sha(
      bindingDocument.hookDefinitionDigest,
      "hookDefinitionDigest",
    ),
  };
  const basis = {
    schemaVersion: CODEX_ADAPTER_ACTIVATION_INSTALLATION_VERSION,
    generationId: id(document.generationId, "generationId"),
    bundleDigest: sha(document.bundleDigest, "bundleDigest"),
    inertInstallationReceiptDigest: sha(
      document.inertInstallationReceiptDigest,
      "inertInstallationReceiptDigest",
    ),
    installationRoot: text(document.installationRoot, "installationRoot", 4_096),
    artifactsDigest: sha(document.artifactsDigest, "artifactsDigest"),
    binding,
    entries,
    approvedHookDefinitionDigests: Object.freeze([]) as readonly [],
    activationState: "pending_host_approval" as const,
    hostTrustHashRepresentation: "opaque_not_exported" as const,
    installationDoesNotProveActivation: true as const,
  };
  if (sha(document.receiptDigest, "receiptDigest") !== canonicalSha256(basis)) {
    fail("CODEX_ACTIVATION_RECEIPT_INVALID", "receiptDigest");
  }
  return deepFreeze({
    ...basis,
    receiptDigest: document.receiptDigest as string,
  });
}

export interface CodexActivationReceiptContext {
  readonly receipt: CodexActivationInstallationReceipt;
  readonly sourcePath: string;
  readonly authorityFileSha256: string;
  readonly sourceIdentityDigest: string;
}

const activationReceiptCodes: AuthorityFileReasonCodes<CodexActivationReasonCode> =
  Object.freeze({
    required: "CODEX_ACTIVATION_RECEIPT_INVALID",
    path: "CODEX_ACTIVATION_RECEIPT_INVALID",
    digest: "CODEX_ACTIVATION_RECEIPT_INVALID",
    changed: "CODEX_ACTIVATION_RECEIPT_INVALID",
    link: "CODEX_ACTIVATION_RECEIPT_INVALID",
    specialFile: "CODEX_ACTIVATION_RECEIPT_INVALID",
    limitExceeded: "CODEX_ACTIVATION_BUDGET_EXCEEDED",
    notUtf8: "CODEX_ACTIVATION_UNICODE_INVALID",
    notJson: "CODEX_ACTIVATION_RECEIPT_INVALID",
    notCanonical: "CODEX_ACTIVATION_CANONICAL_INVALID",
  });

export async function readCodexActivationInstallationReceipt(
  path: string,
  authority?: CodexAdapterInstallationFileIdentity,
): Promise<CodexActivationReceiptContext> {
  const source = await readAuthorityFile(path, authority, {
    maximumBytes: maximumReceiptBytes,
    codes: activationReceiptCodes,
    details: {
      required: "Out-of-band Codex activation receipt authority is required",
      expectedDigest: path,
    },
    fail,
    isOwnError: (error) => error instanceof CodexActivationError,
  });
  const context = deepFreeze({
    receipt: validateCodexActivationInstallationReceipt(source.parsed),
    sourcePath: path,
    authorityFileSha256: source.fileSha256,
    sourceIdentityDigest: source.sourceIdentityDigest,
  });
  activationReceiptContexts.add(context);
  return context;
}

export function assertCodexActivationReceiptContext(
  value: unknown,
): CodexActivationReceiptContext {
  if (
    typeof value !== "object" ||
    value === null ||
    !activationReceiptContexts.has(value)
  ) {
    fail(
      "CODEX_ACTIVATION_RECEIPT_INVALID",
      "descriptor-bound activation installation receipt required",
    );
  }
  return value as CodexActivationReceiptContext;
}

export interface CodexHostActivationObservation {
  readonly hostProduct: "Codex CLI";
  readonly hostVersion: string;
  readonly observedAt: string;
  readonly sessionId: string;
  readonly hookEventName: "SessionStart";
  readonly source: "startup" | "resume";
  readonly trustApprovalObserved: true;
  readonly hookFired: true;
  readonly evidenceDigest: string;
}

export interface CodexHostActivationReceipt {
  readonly schemaVersion: typeof CODEX_ADAPTER_HOST_ACTIVATION_RECEIPT_VERSION;
  readonly installationReceiptDigest: string;
  readonly hostProduct: "Codex CLI";
  readonly hostVersion: string;
  readonly observedAt: string;
  readonly sessionId: string;
  readonly hookEventName: "SessionStart";
  readonly source: "startup" | "resume";
  readonly approvedHookDefinitionDigests: readonly string[];
  readonly currentDefinitionApproved: true;
  readonly activationState: "host_observed_active";
  readonly hookFired: true;
  readonly evidenceDigest: string;
  readonly hostTrustHashRepresentation: "opaque_not_exported";
  readonly attributionNote: string;
  readonly receiptDigest: string;
}

export function createCodexHostActivationReceipt(
  installationReceiptValue: unknown,
  approvedDefinitionDigestsValue: unknown,
  observationValue: unknown,
): CodexHostActivationReceipt {
  const installation = validateCodexActivationInstallationReceipt(
    installationReceiptValue,
  );
  const assessment = assessCodexActivationTrust(
    installation.binding,
    approvedDefinitionDigestsValue,
  );
  if (!assessment.currentDefinitionApproved) {
    fail(
      "CODEX_ACTIVATION_APPROVAL_REQUIRED",
      installation.binding.hookDefinitionDigest,
    );
  }
  const observation = record(observationValue, "host activation observation");
  exact(
    observation,
    [
      "hostProduct",
      "hostVersion",
      "observedAt",
      "sessionId",
      "hookEventName",
      "source",
      "trustApprovalObserved",
      "hookFired",
      "evidenceDigest",
    ],
    "host activation observation",
  );
  if (
    observation.hostProduct !== "Codex CLI" ||
    observation.hookEventName !== "SessionStart" ||
    (observation.source !== "startup" && observation.source !== "resume") ||
    observation.trustApprovalObserved !== true ||
    observation.hookFired !== true
  ) {
    fail(
      "CODEX_ACTIVATION_HOST_OBSERVATION_REQUIRED",
      "approval and hook fire must both be observed",
    );
  }
  const basis = {
    schemaVersion: CODEX_ADAPTER_HOST_ACTIVATION_RECEIPT_VERSION,
    installationReceiptDigest: installation.receiptDigest,
    hostProduct: "Codex CLI" as const,
    hostVersion: text(observation.hostVersion, "hostVersion", 512),
    observedAt: instant(observation.observedAt, "observedAt"),
    sessionId: text(observation.sessionId, "sessionId", 512),
    hookEventName: "SessionStart" as const,
    source: observation.source as "startup" | "resume",
    approvedHookDefinitionDigests:
      assessment.approvedHookDefinitionDigests,
    currentDefinitionApproved: true as const,
    activationState: "host_observed_active" as const,
    hookFired: true as const,
    evidenceDigest: sha(observation.evidenceDigest, "evidenceDigest"),
    hostTrustHashRepresentation: "opaque_not_exported" as const,
    attributionNote:
      "operator-observed Codex trust approval and hook fire; TCRN local definition digest is not asserted to be Codex's opaque internal trust hash",
  };
  return deepFreeze({ ...basis, receiptDigest: canonicalSha256(basis) });
}

// Exported for installer precondition checks without widening the activation path:
// only the four already-governed inert template paths may precede this rung.
export const CODEX_ACTIVATION_INERT_PREREQUISITE_PATHS = Object.freeze([
  ...CODEX_ADAPTER_TEMPLATE_PATHS,
] as const);
