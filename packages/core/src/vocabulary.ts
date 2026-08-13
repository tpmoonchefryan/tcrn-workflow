// SPDX-License-Identifier: Apache-2.0

import {
  CONFERENCE_EXECUTION_FORMS,
  CONFERENCE_TYPES,
  independenceFloorCovers,
} from "./conference.js";
import { MODEL_PLAN_HOSTS } from "./model-plan.js";
import { PERSONA_ROLE_DEFINITIONS } from "./persona-store.js";
import { SETTINGS_CATALOG } from "./settings.js";

export const VOCABULARY_VERSION = "tcrn.vocabulary.v1" as const;

const INDEPENDENCE_FLOORS = Object.freeze(["none", "verification", "verification-and-risk", "all"] as const);

const CONFERENCE_TYPE_DESCRIPTIONS: Readonly<Record<typeof CONFERENCE_TYPES[number], string>> = Object.freeze({
  strategy: "Sets direction and intended outcomes",
  architecture: "Examines structural and technical choices",
  risk: "Surfaces threats, mitigations, and exposure",
  verification: "Tests whether a claim or delivery is sound",
  release: "Coordinates a release or publication decision",
  incident: "Responds to a live failure or discrepancy",
  retrospective: "Captures learning after an execution cycle",
});

const EXECUTION_FORM_DESCRIPTIONS: Readonly<Record<typeof CONFERENCE_EXECUTION_FORMS[number], string>> = Object.freeze({
  independent: "Positions were formed in separate contexts",
  "single-context": "Positions were formed in one shared context",
});

/**
 * Read-only engine vocabulary. Every field is derived from the same constants
 * consumed by validation; the portal must not maintain a parallel enum table.
 */
export function readVocabulary(): Readonly<{
  readonly schemaVersion: typeof VOCABULARY_VERSION;
  readonly roles: typeof PERSONA_ROLE_DEFINITIONS;
  readonly hosts: typeof MODEL_PLAN_HOSTS;
  readonly conferenceTypes: readonly {
    readonly value: typeof CONFERENCE_TYPES[number];
    readonly description: string;
    readonly coveredByIndependenceFloors: readonly string[];
  }[];
  readonly executionForms: readonly {
    readonly value: typeof CONFERENCE_EXECUTION_FORMS[number];
    readonly description: string;
  }[];
  readonly settingsEnums: readonly {
    readonly key: string;
    readonly type: string;
    readonly controlType: string;
    readonly defaultValue: string | null;
    readonly allowedValues: readonly string[];
    readonly valueSource: string;
    readonly min?: number;
    readonly max?: number;
  }[];
}> {
  return Object.freeze({
    schemaVersion: VOCABULARY_VERSION,
    roles: PERSONA_ROLE_DEFINITIONS,
    hosts: MODEL_PLAN_HOSTS,
    conferenceTypes: Object.freeze(CONFERENCE_TYPES.map((value) => Object.freeze({
      value,
      description: CONFERENCE_TYPE_DESCRIPTIONS[value],
      coveredByIndependenceFloors: Object.freeze(INDEPENDENCE_FLOORS.filter((floor) => independenceFloorCovers(floor, value))),
    }))),
    executionForms: Object.freeze(CONFERENCE_EXECUTION_FORMS.map((value) => Object.freeze({
      value,
      description: EXECUTION_FORM_DESCRIPTIONS[value],
    }))),
    // This category is an enum dictionary, not a second settings catalog. Keep
    // dynamic model-plan selectors because their control type is enum even
    // though their values come from the model-plan read surface.
    settingsEnums: Object.freeze(SETTINGS_CATALOG.filter((entry) => entry.controlType === "enum").map((entry) => Object.freeze({
      key: entry.key,
      type: entry.type,
      controlType: entry.controlType,
      defaultValue: entry.defaultValue,
      allowedValues: Object.freeze([...(entry.allowedValues ?? [])]),
      valueSource: entry.key === "execution.claudeCodeSubagentPlan"
        ? "model-plan-list:claude-code"
        : entry.key === "execution.codexSubagentPlan"
          ? "model-plan-list:codex"
          : "settings-catalog",
      ...(entry.min === undefined ? {} : { min: entry.min }),
      ...(entry.max === undefined ? {} : { max: entry.max }),
    }))),
  });
}
