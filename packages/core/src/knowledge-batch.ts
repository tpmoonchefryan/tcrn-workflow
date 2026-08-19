// SPDX-License-Identifier: Apache-2.0

// Knowledge-batch: file, promote, reverify or retire N knowledge cards in one CLI act.
//
// The measured ceremony this removes: filing four cards on 2026-08-19 took sixteen CLI
// round trips, because every card needs the store's version read, the write made, and the
// receipt read back -- and any chain write in between invalidates the store, adding a
// rebase. One batch is one invocation: an optional leading rebase, then the members in
// order, the store version threaded internally so the caller never re-reads it.
//
// ONE HONEST DIFFERENCE FROM work-batch, stated here because hiding it would be the
// weaker-answer defect this repository keeps finding in itself. work-batch is atomic:
// all members land or none do, because chain events are irreversible facts. This batch
// is NOT atomic across members. Each member commits individually under the store's own
// mutation claim -- the same per-mutation atomicity every knowledge verb has always had --
// and a member that fails leaves the members before it applied. That is a deliberate
// trade, not a shortcut: the knowledge store is a disposable, rebuildable projection
// (knowledge-init requires acknowledging exactly that), member-level rollback would mean
// rebuilding the store's whole transaction layer for a surface the chain can regenerate,
// and a partial batch is recoverable by re-running the unapplied tail. What makes the
// trade safe is that partiality is REPORTED structurally: the receipt of every applied
// member, the failing member with its own reason code, and the members never evaluated,
// as three separate lists a caller cannot confuse.
//
// Members may name externalKey instead of id, and a member acting on a card an earlier
// member created inherits the revision the batch just observed -- so "create it, then
// promote it" needs no revision arithmetic from the caller.

import { canonicalExternalKey, deriveStableId } from "../../protocol/src/index.js";
import type { JsonValue } from "../../protocol/src/index.js";
import {
  createKnowledgeUnit,
  rebaseKnowledgeStore,
  retireKnowledgeUnit,
  reverifyKnowledgeUnit,
  transitionKnowledgePromotion,
} from "./knowledge-core.js";
import type {
  CreateKnowledgeUnitInput,
  KnowledgeMutationOptions,
} from "./knowledge-core.js";
import { WorkspaceError } from "./workspace.js";

export const KNOWLEDGE_BATCH_SCHEMA_VERSION = "tcrn.knowledge-batch.v1" as const;
export const KNOWLEDGE_BATCH_VERBS = Object.freeze([
  "knowledge-create", "knowledge-promote", "knowledge-retire", "knowledge-reverify",
]);

// The store's own ceiling on live records bounds any sensible batch; a larger one is a
// caller error, not a capacity question.
const KNOWLEDGE_BATCH_MEMBER_LIMIT = 256;

export interface KnowledgeBatchProblem {
  readonly index: number;
  readonly verb: string | null;
  readonly rule: string;
  readonly detail: string;
}

export interface KnowledgeBatchOptions {
  // The STORE's version, not the chain's -- the same meaning every knowledge verb gives
  // this name, and the trap TCRN-CROSS-INC-226 measured a session falling into.
  readonly expectedVersion: number;
  readonly occurredAt: string;
  // Rebase the store to the chain head before the first member. In a workspace being
  // written to this is the normal case, because any chain event invalidates the store
  // for writes; carrying it inside the batch is what keeps N cards at one invocation.
  readonly alignFirst?: boolean;
  readonly mutation?: KnowledgeMutationOptions;
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function referencedId(member: Readonly<Record<string, unknown>>): string | null {
  if (isNonEmptyString(member.id)) return member.id;
  if (isNonEmptyString(member.externalKey)) return deriveStableId("knowledge", canonicalExternalKey(member.externalKey));
  return null;
}

// The shape pass: stateless, so every verdict belongs to the member that earned it and
// all of them are reported in one refusal rather than one per round trip.
function shapeProblems(members: readonly unknown[]): readonly KnowledgeBatchProblem[] {
  const problems: KnowledgeBatchProblem[] = [];
  members.forEach((member, index) => {
    if (!isObject(member)) {
      problems.push({ index, verb: null, rule: "member-object", detail: "a batch member is an object" });
      return;
    }
    const verb = isNonEmptyString(member.verb) ? member.verb : null;
    if (verb === null || !KNOWLEDGE_BATCH_VERBS.includes(verb)) {
      problems.push({ index, verb, rule: "verb-known", detail: `verb must be one of ${KNOWLEDGE_BATCH_VERBS.join(", ")}` });
      return;
    }
    if (verb === "knowledge-create") {
      // The full card contract is core's to judge; the shape pass asks only for the
      // fields without which core's refusal would name the wrong thing.
      for (const field of ["externalKey", "subject", "summary", "snippet", "body"]) {
        if (!isNonEmptyString(member[field])) problems.push({ index, verb, rule: "field-required", detail: field });
      }
      return;
    }
    if (referencedId(member) === null) {
      problems.push({ index, verb, rule: "reference-required", detail: "id or externalKey names the card to act on" });
    }
    if (verb === "knowledge-promote" && member.state !== "promoted" && member.state !== "rejected") {
      problems.push({ index, verb, rule: "state-known", detail: `state=${String(member.state)}` });
    }
  });
  return problems;
}

export async function applyKnowledgeBatch(
  workspaceRoot: string,
  document: unknown,
  options: KnowledgeBatchOptions,
): Promise<Readonly<Record<string, JsonValue>>> {
  if (!isObject(document) || document.schemaVersion !== KNOWLEDGE_BATCH_SCHEMA_VERSION || !Array.isArray(document.members)) {
    throw new WorkspaceError("WORK_BATCH_MALFORMED", `a knowledge batch is ${KNOWLEDGE_BATCH_SCHEMA_VERSION} with a members array`);
  }
  const members = document.members as readonly unknown[];
  if (members.length === 0 || members.length > KNOWLEDGE_BATCH_MEMBER_LIMIT) {
    throw new WorkspaceError("WORK_BATCH_MALFORMED", `members=${members.length}`);
  }
  const problems = shapeProblems(members);
  if (problems.length > 0) {
    throw new WorkspaceError("WORK_BATCH_REFUSED", JSON.stringify({ stage: "shape", problems }));
  }
  const mutation = options.mutation ?? {};
  let version = options.expectedVersion;
  const applied: JsonValue[] = [];
  // Revisions observed inside this batch, so a later member acting on an earlier
  // member's card needs no revision arithmetic from the caller.
  const revisions = new Map<string, number>();
  if (options.alignFirst === true) {
    const aligned = await rebaseKnowledgeStore(workspaceRoot, { expectedVersion: version, at: options.occurredAt }, mutation);
    version = aligned.version as number;
    applied.push({ verb: "knowledge-rebase", reasonCode: aligned.reasonCode as string, version });
  }
  for (const [index, raw] of members.entries()) {
    const member = raw as Readonly<Record<string, unknown>>;
    try {
      if (member.verb === "knowledge-create") {
        const result = await createKnowledgeUnit(workspaceRoot, {
          ...(member as unknown as Omit<CreateKnowledgeUnitInput, "expectedVersion" | "occurredAt">),
          expectedVersion: version,
          occurredAt: options.occurredAt,
        }, mutation);
        version = result.version as number;
        revisions.set(result.id as string, result.revision as number);
        applied.push({ index, verb: "knowledge-create", id: result.id as string, revision: result.revision as number, version });
        continue;
      }
      const id = referencedId(member) as string;
      const expectedRevision = typeof member.expectedRevision === "number"
        ? member.expectedRevision
        : revisions.get(id);
      if (expectedRevision === undefined) {
        // Not derivable and not supplied: refusing here, with the remedy, beats letting
        // core report a revision mismatch the caller has no way to resolve.
        // WORK_BATCH_REFUSED rather than a knowledge code: the refusal is the batch's
        // own (a member under-specified), not the store's, and it must carry the same
        // structured payload every other member failure carries.
        throw new WorkspaceError("WORK_BATCH_REFUSED", JSON.stringify({
          stage: "apply",
          applied,
          failed: { index, verb: member.verb as string, reasonCode: "KNOWLEDGE_CAS_MISMATCH", detail: "expectedRevision is required for a card this batch did not touch" },
          notEvaluated: Array.from({ length: members.length - index - 1 }, (_, offset) => index + offset + 1),
        }));
      }
      const shared = { expectedVersion: version, expectedRevision, occurredAt: options.occurredAt, id };
      const result = member.verb === "knowledge-promote"
        ? await transitionKnowledgePromotion(workspaceRoot, { ...shared, promotionState: member.state as "promoted" | "rejected" }, mutation)
        : member.verb === "knowledge-retire"
          ? await retireKnowledgeUnit(workspaceRoot, shared, mutation)
          : await reverifyKnowledgeUnit(workspaceRoot, shared, mutation);
      version = result.version as number;
      if (typeof result.revision === "number") revisions.set(id, result.revision);
      applied.push({ index, verb: member.verb as string, id, version });
    } catch (error) {
      const carried = (error as { reasonCode?: unknown }).reasonCode;
      // A refusal this loop already shaped passes through untouched: wrapping it again
      // would bury the member's own reason code one level deeper on every hop.
      if (carried === "WORK_BATCH_REFUSED") throw error;
      throw new WorkspaceError("WORK_BATCH_REFUSED", JSON.stringify({
        stage: "apply",
        // Everything that landed, because it stays landed: this batch is per-member
        // atomic rather than all-or-nothing, and the honest receipt of a partial batch
        // is the exact list of what is now in the store.
        applied,
        failed: {
          index,
          verb: isNonEmptyString(member.verb) ? member.verb : null,
          reasonCode: typeof carried === "string" && carried.length > 0 ? carried : "KNOWLEDGE_ERROR",
          detail: error instanceof Error ? error.message : String(error),
        },
        notEvaluated: Array.from({ length: members.length - index - 1 }, (_, offset) => index + offset + 1),
      }));
    }
  }
  return {
    schemaVersion: "tcrn.knowledge-batch-result.v1",
    reasonCode: "KNOWLEDGE_BATCH_APPLIED",
    members: members.length,
    aligned: options.alignFirst === true,
    version,
    applied,
  };
}
