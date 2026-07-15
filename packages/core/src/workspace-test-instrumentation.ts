// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks";

// Package-private test instrumentation. This module is absent from the package
// index and package exports; production callers cannot arm it by arguments,
// environment, repository state, or persisted Workspace state. The capability
// is scoped to one wrapper-owned async operation, not to the process.
type OperationCapability = {
  state: "armed" | "consumed" | "closed";
};
const replacementOperation = new AsyncLocalStorage<OperationCapability>();

export async function withQuarantineReplacementTestInstrumentation<T>(operation: () => Promise<T>): Promise<T> {
  if (replacementOperation.getStore() !== undefined) {
    throw new Error("quarantine replacement instrumentation nesting is unsupported");
  }
  const capability: OperationCapability = { state: "armed" };
  try {
    return await replacementOperation.run(capability, operation);
  } finally {
    capability.state = "closed";
  }
}

export function consumeQuarantineReplacementTestInstrumentation(): boolean {
  const capability = replacementOperation.getStore();
  if (capability?.state !== "armed") {
    return false;
  }
  capability.state = "consumed";
  return true;
}

export function isQuarantineReplacementTestInstrumentationArmed(): boolean {
  const capability = replacementOperation.getStore();
  return capability?.state === "armed";
}
