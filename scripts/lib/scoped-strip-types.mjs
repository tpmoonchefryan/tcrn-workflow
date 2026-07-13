// SPDX-License-Identifier: Apache-2.0

import { stripTypeScriptTypes } from "node:module";

export const STRIP_TYPES_EXPERIMENTAL_WARNING = "stripTypeScriptTypes is an experimental feature and might change at any time";

export class ScopedStripTypesError extends Error {
  constructor(reasonCode, message) {
    super(message);
    this.name = "ScopedStripTypesError";
    this.reasonCode = reasonCode;
  }
}

const processWarningState = { consumed: false };

function fail(reasonCode, message) {
  throw new ScopedStripTypesError(reasonCode, message);
}

export function stripTypesWithScopedExperimentalWarning(source, options, {
  transform = stripTypeScriptTypes,
  warningState = processWarningState,
} = {}) {
  if (warningState.consumed) {
    return transform(source, options);
  }
  const originalEmitWarning = process.emitWarning;
  let observed = 0;
  process.emitWarning = function emitWarning(warning, type, code, constructor) {
    if (warning === STRIP_TYPES_EXPERIMENTAL_WARNING && type === "ExperimentalWarning" && code === undefined && constructor === undefined) {
      observed += 1;
      if (observed !== 1) {
        fail("STRIP_TYPES_WARNING_REPEATED", "stripTypeScriptTypes emitted its expected ExperimentalWarning more than once");
      }
      return;
    }
    return originalEmitWarning.call(this, warning, type, code, constructor);
  };
  try {
    const output = transform(source, options);
    if (observed !== 1) {
      fail("STRIP_TYPES_WARNING_MISSING", "stripTypeScriptTypes did not emit its exact ExperimentalWarning");
    }
    warningState.consumed = true;
    return output;
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}
