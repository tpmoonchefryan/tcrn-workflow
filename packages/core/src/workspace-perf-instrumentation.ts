// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks";

// WSA-5: package-private operation-count instrumentation. Absent from the package
// index and exports; production callers cannot arm it by arguments, environment,
// repository state, or persisted Workspace state. It counts the load-bearing
// replay/validation operations so the O(delta) engine properties (WSA-1/WSA-2) are
// proven by closed-form equality, not by wall-clock timing.
export interface WorkspacePerfMetrics {
  // Full event-log replays (materialize invocations).
  fullMaterialize: number;
  // Terminal full-graph validateWorkGraph calls over the whole work set.
  terminalGraphValidation: number;
  // Per-event O(delta) closure validations, with the summed record count they visit.
  closureValidation: number;
  closureRecordsVisited: number;
}

const store = new AsyncLocalStorage<WorkspacePerfMetrics>();

export async function withWorkspacePerfInstrumentation<T>(operation: () => Promise<T>): Promise<{ readonly result: T; readonly metrics: WorkspacePerfMetrics }> {
  const metrics: WorkspacePerfMetrics = { fullMaterialize: 0, terminalGraphValidation: 0, closureValidation: 0, closureRecordsVisited: 0 };
  const result = await store.run(metrics, operation);
  return { result, metrics };
}

export function recordFullMaterialize(): void {
  const metrics = store.getStore();
  if (metrics) metrics.fullMaterialize += 1;
}

export function recordTerminalGraphValidation(): void {
  const metrics = store.getStore();
  if (metrics) metrics.terminalGraphValidation += 1;
}

export function recordClosureValidation(recordsVisited: number): void {
  const metrics = store.getStore();
  if (metrics) {
    metrics.closureValidation += 1;
    metrics.closureRecordsVisited += recordsVisited;
  }
}
