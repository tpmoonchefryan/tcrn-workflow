// SPDX-License-Identifier: Apache-2.0

// STORY-300 slice 3: apply an ordered, heterogeneous sequence of work-record writes as
// one act -- one lease, one CAS decision, one clock reading, one view projection, one
// time-attestation receipt.
//
// The Story this belongs to opens with the cost it exists to remove: recording N facts
// should cost O(1) chain-write round trips. Filing four knowledge cards on 2026-08-19 took
// sixteen, because every record needs its version read, its write made, and its receipt
// read back. That is the ceremony the platform's own audit called backwards.
//
// Two things here are less obvious than the batching.
//
// FAILURE ATTRIBUTION. The acceptance criterion asks that a member which failed only
// because an earlier member did be structurally distinguishable from one that failed on
// its own -- and it must be structural, not a difference in message wording. That falls
// out of running two passes. The shape pass needs no state, so every member is judged
// independently and all of its verdicts are reported together: those are failures a
// member owns. The apply pass is ordered and all-or-nothing, so the first member to fail
// against accumulated state ends it, and the members after it were never evaluated at
// all. "Not evaluated" is a different fact from "evaluated and failed", and reporting it
// as its own list is the distinction the criterion is about.
//
// INTRA-BATCH REFERENCES. A work id is derived from its external key, so a member acting
// on a record an earlier member created would otherwise have to carry a hash the caller
// computed by hand. Members may name `externalKey` instead of `id`, and `parentExternalKey`
// instead of `parentId`, and the batch derives both. That second one is not a convenience:
// a Story must hang under a parent, so without it the commonest batch there is -- open an
// Epic and the Stories beneath it -- cannot be written at all.

import {
  PROTOCOL_LIMITS,
  canonicalExternalKey,
  deriveStableId,
} from "../../protocol/src/index.js";
import type { JsonValue } from "../../protocol/src/index.js";
import {
  WorkspaceError,
  appendEvents,
  createWorkDelta,
  annotateWorkDelta,
  transitionWorkDelta,
} from "./workspace.js";
import type { MutationDelta, WorkspaceLease, WorkspaceState } from "./workspace.js";

export const WORK_BATCH_SCHEMA_VERSION = "tcrn.work-batch.v1" as const;
export const WORK_BATCH_VERBS = Object.freeze(["work-create", "work-transition", "work-annotate"]);

const WORK_KINDS = Object.freeze(["Initiative", "Epic", "Story", "Subtask", "Incident", "Release"]);
const WORK_STATUSES = Object.freeze(["planned", "ready", "active", "done", "cancelled"]);

export interface WorkBatchProblem {
  readonly index: number;
  readonly verb: string | null;
  readonly rule: string;
  readonly detail: string;
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= PROTOCOL_LIMITS.maxStringLength;
}

// Resolving a reference by external key is what lets one member act on what an earlier
// member created. `id` still wins when both are given, so an explicit id is never
// silently replaced by a derivation.
function referencedId(member: Readonly<Record<string, unknown>>): string | null {
  if (isNonEmptyString(member.id)) return member.id;
  if (isNonEmptyString(member.externalKey)) return deriveStableId("work", canonicalExternalKey(member.externalKey));
  return null;
}

// The shape pass. Every member is judged against the same rules the single verbs apply at
// their CLI boundary, with no workspace state involved -- which is precisely why every
// verdict here belongs to the member that earned it.
function shapeProblems(members: readonly unknown[]): readonly WorkBatchProblem[] {
  const problems: WorkBatchProblem[] = [];
  members.forEach((member, index) => {
    if (!isObject(member)) {
      problems.push({ index, verb: null, rule: "member-object", detail: "a batch member is an object" });
      return;
    }
    const verb = isNonEmptyString(member.verb) ? member.verb : null;
    if (verb === null || !WORK_BATCH_VERBS.includes(verb)) {
      problems.push({ index, verb, rule: "verb-known", detail: `verb must be one of ${WORK_BATCH_VERBS.join(", ")}` });
      return;
    }
    if (verb === "work-create") {
      for (const field of ["projectId", "externalKey", "kind"]) {
        if (!isNonEmptyString(member[field])) problems.push({ index, verb, rule: "field-required", detail: field });
      }
      if (member.kind !== undefined && !WORK_KINDS.includes(member.kind as string)) {
        problems.push({ index, verb, rule: "kind-known", detail: `kind=${String(member.kind)}` });
      }
      if (member.status !== undefined && !WORK_STATUSES.includes(member.status as string)) {
        problems.push({ index, verb, rule: "status-known", detail: `status=${String(member.status)}` });
      }
      // The engine refuses a scopeless Story at the reducer, but doing it here means the
      // whole batch is reported at once rather than one member per round trip.
      if (member.kind === "Story" && member.scope === undefined) {
        problems.push({ index, verb, rule: "story-scope-required", detail: "a new Story carries its complete scope atomically" });
      }
      return;
    }
    if (referencedId(member) === null) {
      problems.push({ index, verb, rule: "reference-required", detail: "id or externalKey names the record to act on" });
    }
    if (verb === "work-transition") {
      if (!WORK_STATUSES.includes(member.status as string)) {
        problems.push({ index, verb, rule: "status-known", detail: `status=${String(member.status)}` });
      }
      return;
    }
    if (member.scope === undefined && member.decidedBy === undefined && member.sprint === undefined) {
      problems.push({ index, verb, rule: "advisory-required", detail: "an annotation carries at least one of scope, decidedBy, sprint" });
    }
  });
  return problems;
}

function deltaFor(member: Readonly<Record<string, unknown>>, occurredAt: string): (state: WorkspaceState) => MutationDelta {
  if (member.verb === "work-create") {
    return createWorkDelta({
      projectId: member.projectId as string,
      externalKey: member.externalKey as string,
      kind: member.kind as never,
      parentId: isNonEmptyString(member.parentId)
        ? member.parentId
        : isNonEmptyString(member.parentExternalKey)
          ? deriveStableId("work", canonicalExternalKey(member.parentExternalKey))
          : null,
      ...(member.status === undefined ? {} : { status: member.status as never }),
      ...(member.scope === undefined ? {} : { scope: member.scope as string }),
      ...(member.decidedBy === undefined ? {} : { decidedBy: member.decidedBy as readonly string[] }),
      occurredAt,
    });
  }
  const id = referencedId(member) as string;
  if (member.verb === "work-transition") {
    return transitionWorkDelta({ id, status: member.status as never, occurredAt });
  }
  return annotateWorkDelta({
    id,
    ...(member.scope === undefined ? {} : { scope: member.scope as string }),
    ...(member.decidedBy === undefined ? {} : { decidedBy: member.decidedBy as readonly string[] }),
    ...(member.sprint === undefined ? {} : { sprint: member.sprint as never }),
    occurredAt,
  });
}

export interface WorkBatchOptions {
  // The head sentinel is resolved at the CLI boundary like every other verb, so this
  // takes the number it resolved to and nothing here has to know the sentinel exists.
  readonly expectedVersion: number;
  readonly occurredAt: string;
  readonly actorId?: string;
}

export async function applyWorkBatch(
  workspaceRoot: string,
  lease: WorkspaceLease,
  document: unknown,
  options: WorkBatchOptions,
): Promise<WorkspaceState> {
  if (!isObject(document) || document.schemaVersion !== WORK_BATCH_SCHEMA_VERSION || !Array.isArray(document.members)) {
    throw new WorkspaceError("WORK_BATCH_MALFORMED", `a batch is ${WORK_BATCH_SCHEMA_VERSION} with a members array`);
  }
  const members = document.members as readonly unknown[];
  if (members.length === 0) {
    throw new WorkspaceError("WORK_BATCH_MALFORMED", "a batch carries at least one member");
  }
  if (members.length > PROTOCOL_LIMITS.maxRecords) {
    throw new WorkspaceError("WORK_BATCH_MALFORMED", `members=${members.length}`);
  }
  const problems = shapeProblems(members);
  if (problems.length > 0) {
    // Every shape verdict at once. A member is refused here on its own terms, never
    // because of a neighbour, so there is nothing consequential to separate out.
    throw new WorkspaceError("WORK_BATCH_REFUSED", JSON.stringify({ stage: "shape", problems }));
  }
  const deltas = members.map((member) => deltaFor(member as Readonly<Record<string, unknown>>, options.occurredAt));
  try {
    return await appendEvents(workspaceRoot, lease, deltas, options);
  } catch (error) {
    // The index comes from appendEvents, which is the only thing that knows it. Counting
    // completed closures from out here was wrong three ways: the counter advanced after
    // the closure returned while actor injection and event construction ran afterwards
    // and throw too, a pre-loop failure (instant, lease, CAS) left it at zero and blamed
    // member zero, and a last-member failure fell through unattributed.
    const failing = (error as { memberIndex?: unknown }).memberIndex;
    if (typeof failing !== "number") throw error;
    const carried = (error as { reasonCode?: unknown }).reasonCode;
    const reason = typeof carried === "string" && carried.length > 0 ? carried : "WORKSPACE_ERROR";
    const detail = error instanceof Error ? error.message : String(error);
    const phase = (error as { memberPhase?: unknown }).memberPhase;
    const member = members[failing] as Readonly<Record<string, unknown>>;
    // The apply pass is ordered and all-or-nothing, so exactly one member is ever
    // evaluated-and-failed and everything after it is unevaluated. Reporting the second
    // group as its own list is the structural distinction: those members are not being
    // called invalid, they are being called unjudged.
    throw new WorkspaceError("WORK_BATCH_REFUSED", JSON.stringify({
      stage: "apply",
      failed: {
        index: failing,
        verb: isObject(member) ? member.verb ?? null : null,
        // "the closure refused this member" and "the event this member produced could not
        // be built" are different facts about the same index, and a caller deciding what
        // to fix needs to know which.
        phase: typeof phase === "string" ? phase : "delta",
        reasonCode: reason,
        detail,
      },
      notEvaluated: Array.from({ length: members.length - failing - 1 }, (_, offset) => failing + offset + 1),
    }));
  }
}

export function workBatchReceipt(state: WorkspaceState, members: number): Readonly<Record<string, JsonValue>> {
  return {
    schemaVersion: "tcrn.work-batch-result.v1",
    reasonCode: "WORK_BATCH_APPLIED",
    members,
    version: state.version,
    headEventHash: state.headEventHash,
  };
}
