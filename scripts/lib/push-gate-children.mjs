// SPDX-License-Identifier: Apache-2.0
// The engine push-gate child list is data so the acceptance containment declaration
// can be checked against the executable wiring without importing a side-effectful gate.

export const ENGINE_PUSH_GATE_CHILDREN = Object.freeze([
  Object.freeze({ reasonCode: "PUSH_GATE_P1_FAILED", script: "verify:p1" }),
  Object.freeze({ reasonCode: "PUSH_GATE_P8_FAILED", script: "verify:p8" }),
  Object.freeze({ reasonCode: "PUSH_GATE_GUARDS_UNPROVEN", script: "guard-check" }),
]);
