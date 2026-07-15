// SPDX-License-Identifier: Apache-2.0

// Package-private test instrumentation. This module is absent from the package
// index and package exports; production callers cannot arm it by arguments,
// environment, repository state, or persisted Workspace state.
let quarantineReplacementArmed = false;

export async function withQuarantineReplacementTestInstrumentation<T>(operation: () => Promise<T>): Promise<T> {
  if (quarantineReplacementArmed) {
    throw new Error("quarantine replacement instrumentation is already armed");
  }
  quarantineReplacementArmed = true;
  try {
    return await operation();
  } finally {
    quarantineReplacementArmed = false;
  }
}

export function consumeQuarantineReplacementTestInstrumentation(): boolean {
  if (!quarantineReplacementArmed) {
    return false;
  }
  quarantineReplacementArmed = false;
  return true;
}

export function isQuarantineReplacementTestInstrumentationArmed(): boolean {
  return quarantineReplacementArmed;
}
