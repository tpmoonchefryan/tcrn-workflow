// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  assertProtocolId,
  assertStrictInstant,
  canonicalJson,
  canonicalSha256,
  compareCanonicalText,
} from "../../protocol/src/index.js";
import type { ExtensionRegistration, JsonValue, WorkKind, WorkRecord } from "../../protocol/src/index.js";
import { validateTemplateScope } from "./story-scope-compliance.js";
import type { ScopeTemplateDefinition } from "./story-scope-compliance.js";

export const TEMPLATE_DEFINITION_VERSION = "tcrn.template.v1" as const;
export const TEMPLATE_ADMISSION_RECEIPT_VERSION = "tcrn.template-admission.v1" as const;
export const TEMPLATE_ADMISSION_RECORD_VERSION = "tcrn.template-admission-record.v1" as const;
export const TEMPLATE_BINDING_VERSION = "tcrn.template-binding.v1" as const;
export const TEMPLATE_REGISTRATION_PREFIX = "template" as const;

export const TEMPLATE_COUPLING_ROSTER = Object.freeze([
  "owner-decider-minutes",
] as const);

export const TEMPLATE_ADMISSION_REASON_CODES = Object.freeze([
  "TEMPLATE_ADMISSION_INVALID",
  "TEMPLATE_BINDING_INVALID",
  "TEMPLATE_DUPLICATE",
  "TEMPLATE_FILE_INVALID",
  "TEMPLATE_NOT_APPLICABLE",
  "TEMPLATE_SCOPE_INVALID",
  "TEMPLATE_UNKNOWN",
] as const);

export type TemplateAdmissionReasonCode = typeof TEMPLATE_ADMISSION_REASON_CODES[number];
export type TemplateCoupling = typeof TEMPLATE_COUPLING_ROSTER[number];

export class TemplateAdmissionError extends Error {
  readonly reasonCode: TemplateAdmissionReasonCode;

  constructor(reasonCode: TemplateAdmissionReasonCode, message: string) {
    super(message);
    this.name = "TemplateAdmissionError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode: TemplateAdmissionReasonCode, message: string): never {
  throw new TemplateAdmissionError(reasonCode, message);
}

function asRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("TEMPLATE_ADMISSION_INVALID", `${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactFields(value: Readonly<Record<string, unknown>>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(compareCanonicalText);
  const sortedExpected = [...expected].sort(compareCanonicalText);
  if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) {
    fail("TEMPLATE_ADMISSION_INVALID", `${label} fields are not exact`);
  }
}

function text(value: unknown, label: string, maximum = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.includes("\u0000")) {
    fail("TEMPLATE_ADMISSION_INVALID", `${label} must be a bounded string`);
  }
  try {
    canonicalJson(value);
  } catch {
    fail("TEMPLATE_ADMISSION_INVALID", `${label} is not canonical JSON`);
  }
  return value;
}

function sortedUniqueStrings(value: unknown, label: string, maximum: number): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) {
    fail("TEMPLATE_ADMISSION_INVALID", `${label} must be a non-empty bounded array`);
  }
  const values = value.map((entry, index) => text(entry, `${label}[${index}]`));
  const sorted = [...values].sort(compareCanonicalText);
  if (new Set(values).size !== values.length || canonicalJson(values) !== canonicalJson(sorted)) {
    fail("TEMPLATE_ADMISSION_INVALID", `${label} must be unique and canonical-order sorted`);
  }
  return Object.freeze(values);
}

function orderedUniqueStrings(value: unknown, label: string, maximum: number): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) {
    fail("TEMPLATE_ADMISSION_INVALID", `${label} must be a non-empty bounded array`);
  }
  const values = value.map((entry, index) => text(entry, `${label}[${index}]`));
  if (new Set(values).size !== values.length) fail("TEMPLATE_ADMISSION_INVALID", `${label} must be unique`);
  return Object.freeze(values);
}

function optionalSortedUniqueStrings(value: unknown, label: string, maximum: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    fail("TEMPLATE_ADMISSION_INVALID", `${label} must be an array`);
  }
  if (value.length === 0) return Object.freeze([]);
  return sortedUniqueStrings(value, label, maximum);
}

function templateId(value: unknown): string {
  const id = text(value, "template.id", 96);
  if (!/^[a-z][a-z0-9.-]{1,95}$/u.test(id)) {
    fail("TEMPLATE_ADMISSION_INVALID", "template.id is not a stable template id");
  }
  return id;
}

function version(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    fail("TEMPLATE_ADMISSION_INVALID", `${label} must be a positive safe integer`);
  }
  return Number(value);
}

function validateOwnerId(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("owner:")) {
    fail("TEMPLATE_ADMISSION_INVALID", "template admission requires an owner identity");
  }
  try {
    assertProtocolId(value);
  } catch {
    fail("TEMPLATE_ADMISSION_INVALID", "template owner identity is invalid");
  }
  return value;
}

export interface TemplateDefinition extends ScopeTemplateDefinition {
  readonly schemaVersion: typeof TEMPLATE_DEFINITION_VERSION;
  readonly id: string;
  readonly version: number;
  readonly appliesTo: readonly WorkKind[];
  readonly headings: readonly string[];
  readonly acceptanceHeadings: readonly string[];
  readonly referenceHeadings: readonly string[];
  readonly couplings: readonly TemplateCoupling[];
}

export interface TemplateAdmissionReceipt {
  readonly schemaVersion: typeof TEMPLATE_ADMISSION_RECEIPT_VERSION;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly templateDigest: string;
  readonly ownerId: string;
  readonly admittedAt: string;
  readonly receiptDigest: string;
}

export interface TemplateAdmissionRecord {
  readonly schemaVersion: typeof TEMPLATE_ADMISSION_RECORD_VERSION;
  readonly registrationId: string;
  readonly template: TemplateDefinition;
  readonly receipt: TemplateAdmissionReceipt;
}

export interface TemplateBinding {
  readonly schemaVersion: typeof TEMPLATE_BINDING_VERSION;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly templateDigest: string;
  readonly receiptDigest: string;
}

const ALL_WORK_KINDS: readonly WorkKind[] = Object.freeze([
  "Epic", "Incident", "Initiative", "Knowledge", "Release", "Review", "Story", "Subtask",
]);
const COMMON_DELIVERY_HEADINGS = Object.freeze([
  "Goal",
  "Requirements",
  "Acceptance Criteria",
  "Business Background",
  "Preconditions",
  "Assumptions",
  "Use Cases & Examples",
  "Feature Toggle & Setting",
  "Permissions",
  "Implementation Notes",
  "Non-goals",
] as const);

function commonTemplate(id: string, appliesTo: readonly WorkKind[]): TemplateDefinition {
  return {
    schemaVersion: TEMPLATE_DEFINITION_VERSION,
    id,
    version: 1,
    appliesTo,
    headings: COMMON_DELIVERY_HEADINGS,
    acceptanceHeadings: ["Acceptance Criteria"],
    referenceHeadings: [],
    couplings: ["owner-decider-minutes"],
  };
}

export const BUILTIN_TEMPLATES: readonly TemplateDefinition[] = Object.freeze([
  commonTemplate("epic.v1", ["Epic"]),
  commonTemplate("initiative.v1", ["Initiative"]),
  {
    schemaVersion: TEMPLATE_DEFINITION_VERSION,
    id: "inc.defect.v1",
    version: 1,
    appliesTo: ["Incident"],
    headings: ["URI", "Preconditions", "Steps to Reproduce", "Actual", "Expected", "Credentials 引用", "Attachments 引用"],
    acceptanceHeadings: ["Expected"],
    referenceHeadings: ["Attachments 引用", "Credentials 引用"],
    couplings: [],
  },
  {
    schemaVersion: TEMPLATE_DEFINITION_VERSION,
    id: "inc.governance.v1",
    version: 1,
    appliesTo: ["Incident"],
    headings: ["现象与证据", "根因", "影响面", "处置", "预防"],
    acceptanceHeadings: ["处置", "预防"],
    referenceHeadings: [],
    couplings: [],
  },
  commonTemplate("release.v1", ["Release"]),
  commonTemplate("story.feature.v1", ["Story"]),
]);

function templateBasis(template: TemplateDefinition): Readonly<Record<string, JsonValue>> {
  return {
    schemaVersion: TEMPLATE_DEFINITION_VERSION,
    id: template.id,
    version: template.version,
    appliesTo: template.appliesTo,
    headings: template.headings,
    acceptanceHeadings: template.acceptanceHeadings,
    referenceHeadings: template.referenceHeadings,
    couplings: template.couplings,
  };
}

export function templateRegistrationId(templateIdValue: unknown, templateVersionValue: unknown): string {
  const id = templateId(templateIdValue);
  const templateVersion = version(templateVersionValue, "template.version");
  return `${TEMPLATE_REGISTRATION_PREFIX}:${id}-${templateVersion}`;
}

export function templateKey(templateIdValue: unknown, templateVersionValue: unknown): string {
  return `${templateId(templateIdValue)}@${version(templateVersionValue, "template.version")}`;
}

export function validateTemplateDefinition(value: unknown): TemplateDefinition {
  const document = asRecord(value, "template");
  exactFields(document, ["acceptanceHeadings", "appliesTo", "couplings", "headings", "id", "referenceHeadings", "schemaVersion", "version"], "template");
  if (document.schemaVersion !== TEMPLATE_DEFINITION_VERSION) {
    fail("TEMPLATE_ADMISSION_INVALID", "template schemaVersion");
  }
  const id = templateId(document.id);
  const templateVersion = version(document.version, "template.version");
  const appliesTo = sortedUniqueStrings(document.appliesTo, "template.appliesTo", ALL_WORK_KINDS.length) as readonly WorkKind[];
  if (appliesTo.some((kind) => !(ALL_WORK_KINDS as readonly string[]).includes(kind))) {
    fail("TEMPLATE_ADMISSION_INVALID", "template.appliesTo contains an unknown work kind");
  }
  const headings = orderedUniqueStrings(document.headings, "template.headings", 64);
  const originalHeadings = document.headings as readonly unknown[];
  // Headings are an ordered template contract, so unlike set-valued metadata they
  // must retain author order. The duplicate check above remains useful, but the
  // canonical JSON comparison here intentionally does not sort.
  if (originalHeadings.some((entry) => typeof entry !== "string") || headings.length !== originalHeadings.length) {
    fail("TEMPLATE_ADMISSION_INVALID", "template.headings are invalid");
  }
  const orderedHeadings = [...headings];
  const acceptanceHeadings = optionalSortedUniqueStrings(document.acceptanceHeadings, "template.acceptanceHeadings", 16);
  const referenceHeadings = optionalSortedUniqueStrings(document.referenceHeadings, "template.referenceHeadings", 16);
  if ([...acceptanceHeadings, ...referenceHeadings].some((heading) => !orderedHeadings.includes(heading))) {
    fail("TEMPLATE_ADMISSION_INVALID", "template section rule names a heading not in the template");
  }
  const couplings = optionalSortedUniqueStrings(document.couplings, "template.couplings", TEMPLATE_COUPLING_ROSTER.length) as readonly TemplateCoupling[];
  if (couplings.some((coupling) => !(TEMPLATE_COUPLING_ROSTER as readonly string[]).includes(coupling))) {
    fail("TEMPLATE_ADMISSION_INVALID", "template declares an unknown coupling");
  }
  return {
    schemaVersion: TEMPLATE_DEFINITION_VERSION,
    id,
    version: templateVersion,
    appliesTo,
    headings: Object.freeze(orderedHeadings),
    acceptanceHeadings,
    referenceHeadings,
    couplings,
  };
}

export function templateDigest(templateValue: unknown): string {
  return canonicalSha256(templateBasis(validateTemplateDefinition(templateValue)));
}

export function validateTemplateAdmissionReceipt(value: unknown): TemplateAdmissionReceipt {
  const document = asRecord(value, "template admission receipt");
  exactFields(document, ["admittedAt", "ownerId", "receiptDigest", "schemaVersion", "templateDigest", "templateId", "templateVersion"], "template admission receipt");
  if (document.schemaVersion !== TEMPLATE_ADMISSION_RECEIPT_VERSION) fail("TEMPLATE_ADMISSION_INVALID", "template admission receipt schemaVersion");
  const templateIdValue = templateId(document.templateId);
  const templateVersion = version(document.templateVersion, "template admission receipt.templateVersion");
  const digest = text(document.templateDigest, "template admission receipt.templateDigest", 64);
  const receiptDigest = text(document.receiptDigest, "template admission receipt.receiptDigest", 64);
  if (!/^[a-f0-9]{64}$/u.test(digest) || !/^[a-f0-9]{64}$/u.test(receiptDigest)) fail("TEMPLATE_ADMISSION_INVALID", "template admission receipt digest");
  const ownerId = validateOwnerId(document.ownerId);
  const admittedAt = text(document.admittedAt, "template admission receipt.admittedAt", 64);
  try {
    assertStrictInstant(admittedAt);
  } catch {
    fail("TEMPLATE_ADMISSION_INVALID", "template admission receipt.admittedAt");
  }
  const basis = { schemaVersion: TEMPLATE_ADMISSION_RECEIPT_VERSION, templateId: templateIdValue, templateVersion, templateDigest: digest, ownerId, admittedAt };
  if (canonicalSha256(basis) !== receiptDigest) fail("TEMPLATE_ADMISSION_INVALID", "template admission receipt digest mismatch");
  return { ...basis, receiptDigest };
}

export function admitTemplate(templateValue: unknown, input: { readonly ownerId: string; readonly admittedAt: string }): TemplateAdmissionReceipt {
  const template = validateTemplateDefinition(templateValue);
  const ownerId = validateOwnerId(input.ownerId);
  try {
    assertStrictInstant(input.admittedAt);
  } catch {
    fail("TEMPLATE_ADMISSION_INVALID", "template admission time");
  }
  const basis = {
    schemaVersion: TEMPLATE_ADMISSION_RECEIPT_VERSION,
    templateId: template.id,
    templateVersion: template.version,
    templateDigest: canonicalSha256(templateBasis(template)),
    ownerId,
    admittedAt: input.admittedAt,
  } as const;
  return validateTemplateAdmissionReceipt({ ...basis, receiptDigest: canonicalSha256(basis) });
}

export function createTemplateAdmissionRecord(templateValue: unknown, receiptValue: unknown): TemplateAdmissionRecord {
  const template = validateTemplateDefinition(templateValue);
  const receipt = validateTemplateAdmissionReceipt(receiptValue);
  const digest = canonicalSha256(templateBasis(template));
  if (receipt.templateId !== template.id || receipt.templateVersion !== template.version || receipt.templateDigest !== digest) {
    fail("TEMPLATE_ADMISSION_INVALID", "template and admission receipt do not match");
  }
  return validateTemplateAdmissionRecord({
    schemaVersion: TEMPLATE_ADMISSION_RECORD_VERSION,
    registrationId: templateRegistrationId(template.id, template.version),
    template,
    receipt,
  });
}

export function validateTemplateAdmissionRecord(value: unknown): TemplateAdmissionRecord {
  const document = asRecord(value, "template admission record");
  exactFields(document, ["receipt", "registrationId", "schemaVersion", "template"], "template admission record");
  if (document.schemaVersion !== TEMPLATE_ADMISSION_RECORD_VERSION) fail("TEMPLATE_ADMISSION_INVALID", "template admission record schemaVersion");
  const template = validateTemplateDefinition(document.template);
  const receipt = validateTemplateAdmissionReceipt(document.receipt);
  const registrationId = text(document.registrationId, "template admission record.registrationId", 160);
  if (registrationId !== templateRegistrationId(template.id, template.version) ||
    receipt.templateId !== template.id || receipt.templateVersion !== template.version ||
    receipt.templateDigest !== canonicalSha256(templateBasis(template))) {
    fail("TEMPLATE_ADMISSION_INVALID", "template admission record binding mismatch");
  }
  return { schemaVersion: TEMPLATE_ADMISSION_RECORD_VERSION, registrationId, template, receipt };
}

export function validateTemplateBinding(value: unknown): TemplateBinding {
  const document = asRecord(value, "template binding");
  exactFields(document, ["receiptDigest", "schemaVersion", "templateDigest", "templateId", "templateVersion"], "template binding");
  if (document.schemaVersion !== TEMPLATE_BINDING_VERSION) fail("TEMPLATE_BINDING_INVALID", "template binding schemaVersion");
  const templateIdValue = templateId(document.templateId);
  const templateVersion = version(document.templateVersion, "template binding.templateVersion");
  const templateDigestValue = text(document.templateDigest, "template binding.templateDigest", 64);
  const receiptDigest = text(document.receiptDigest, "template binding.receiptDigest", 64);
  if (!/^[a-f0-9]{64}$/u.test(templateDigestValue) || !/^[a-f0-9]{64}$/u.test(receiptDigest)) fail("TEMPLATE_BINDING_INVALID", "template binding digest");
  return { schemaVersion: TEMPLATE_BINDING_VERSION, templateId: templateIdValue, templateVersion, templateDigest: templateDigestValue, receiptDigest };
}

export function templateBindingFromReceipt(receiptValue: unknown): TemplateBinding {
  const receipt = validateTemplateAdmissionReceipt(receiptValue);
  return {
    schemaVersion: TEMPLATE_BINDING_VERSION,
    templateId: receipt.templateId,
    templateVersion: receipt.templateVersion,
    templateDigest: receipt.templateDigest,
    receiptDigest: receipt.receiptDigest,
  };
}

export function templateRegistration(record: TemplateAdmissionRecord): ExtensionRegistration {
  return { id: record.registrationId, version: record.template.version, requiredByDefault: true };
}

export function templateRegistry(records: readonly TemplateAdmissionRecord[]): readonly ExtensionRegistration[] {
  return [...records]
    .sort((left, right) => compareCanonicalText(left.registrationId, right.registrationId))
    .map(templateRegistration);
}

export function templateRecordMatchesBinding(record: TemplateAdmissionRecord, bindingValue: unknown): boolean {
  const binding = validateTemplateBinding(bindingValue);
  return binding.templateId === record.template.id && binding.templateVersion === record.template.version &&
    binding.templateDigest === record.receipt.templateDigest && binding.receiptDigest === record.receipt.receiptDigest;
}

export function templateRecordForBinding(records: readonly TemplateAdmissionRecord[], bindingValue: unknown): TemplateAdmissionRecord | undefined {
  const binding = validateTemplateBinding(bindingValue);
  return records.find((record) => record.template.id === binding.templateId && record.template.version === binding.templateVersion);
}

export function templateBindingFromWorkRecord(record: Pick<WorkRecord, "extensions">): { readonly registrationId: string; readonly binding: TemplateBinding } | null {
  const entries = Object.entries(record.extensions).filter(([key]) => key.startsWith(`${TEMPLATE_REGISTRATION_PREFIX}:`));
  if (entries.length === 0) return null;
  if (entries.length !== 1) fail("TEMPLATE_BINDING_INVALID", "a work record may carry one template binding");
  const first = entries[0];
  if (first === undefined) fail("TEMPLATE_BINDING_INVALID", "template binding extension is missing");
  const [registrationId, entry] = first;
  if (entry.required !== true) fail("TEMPLATE_BINDING_INVALID", "template binding extension must be required");
  return { registrationId, binding: validateTemplateBinding(entry.value) };
}

export function validateBoundTemplateWork(
  record: Pick<WorkRecord, "kind" | "extensions">,
  admissions: readonly TemplateAdmissionRecord[],
): void {
  const bound = templateBindingFromWorkRecord(record);
  if (bound === null) return;
  const admission = templateRecordForBinding(admissions, bound.binding);
  if (admission === undefined || bound.registrationId !== admission.registrationId) fail("TEMPLATE_UNKNOWN", `${bound.binding.templateId}@${bound.binding.templateVersion}`);
  if (!admission.template.appliesTo.includes(record.kind)) fail("TEMPLATE_NOT_APPLICABLE", `${admission.template.id}:${record.kind}`);
  const scopeEntry = record.extensions["advisory:scope"];
  const scope = scopeEntry?.value;
  const validation = validateTemplateScope(scope, admission.template);
  if (!validation.ok) fail("TEMPLATE_SCOPE_INVALID", validation.problems.map((problem) => problem.message).join("; "));
}

export async function readTemplateDocumentFile(pathValue: string): Promise<TemplateDefinition> {
  if (typeof pathValue !== "string" || pathValue.length === 0) fail("TEMPLATE_FILE_INVALID", "template path is required");
  let source: string;
  try {
    source = await readFile(resolve(pathValue), "utf8");
  } catch {
    fail("TEMPLATE_FILE_INVALID", "template file cannot be read");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    fail("TEMPLATE_FILE_INVALID", "template file is not JSON");
  }
  try {
    if (canonicalJson(parsed) !== source) fail("TEMPLATE_FILE_INVALID", "template file must be canonical JSON");
  } catch (error) {
    if (error instanceof TemplateAdmissionError) throw error;
    fail("TEMPLATE_FILE_INVALID", "template file is not canonical JSON");
  }
  return validateTemplateDefinition(parsed);
}

export function validateTemplateDocument(value: unknown): Readonly<Record<string, unknown>> {
  const template = validateTemplateDefinition(value);
  return {
    reasonCode: "TEMPLATE_VALIDATED",
    templateId: template.id,
    templateVersion: template.version,
    templateDigest: canonicalSha256(templateBasis(template)),
    appliesTo: template.appliesTo,
    headings: template.headings,
  };
}
