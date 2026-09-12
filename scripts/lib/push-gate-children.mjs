// SPDX-License-Identifier: Apache-2.0
// The engine push-gate child list is data so the acceptance containment declaration
// can be checked against the executable wiring without importing a side-effectful gate.

export const ENGINE_PUSH_GATE_CHILDREN = Object.freeze([
  Object.freeze({ reasonCode: "PUSH_GATE_P1_FAILED", script: "verify:p1" }),
  Object.freeze({ reasonCode: "PUSH_GATE_P8_FAILED", script: "verify:p8" }),
  Object.freeze({ reasonCode: "PUSH_GATE_GUARDS_UNPROVEN", script: "guard-check" }),
]);

function containmentError(reasonCode, detail) {
  const error = new Error(detail);
  error.reasonCode = reasonCode;
  return error;
}

function groupMap(declaration) {
  if (declaration?.schemaVersion !== "tcrn.gate-containment.v1" || !Array.isArray(declaration.groups)) {
    throw containmentError("GATE_CONTAINMENT_INVALID", "schemaVersion or groups");
  }
  const groups = new Map();
  for (const group of declaration.groups) {
    if (!group || typeof group.id !== "string" || group.id.length === 0 || groups.has(group.id) || !Array.isArray(group.contains)) {
      throw containmentError("GATE_CONTAINMENT_INVALID", "duplicate or malformed group");
    }
    groups.set(group.id, group);
  }
  return groups;
}

function commandText(group) {
  if (typeof group.command === "string" && group.command.trim().length > 0) return group.command.trim();
  if (typeof group.executable === "string" && Array.isArray(group.argv)) return [group.executable, ...group.argv].join(" ");
  throw containmentError("GATE_CONTAINMENT_COMMAND_MISSING", group.id);
}

/**
 * Build the one-run execution plan from the containment declaration.
 * `selected` contains only top-level roots. Every other reachable group is
 * represented once with its root and containment path, so a caller cannot
 * accidentally run a parent and then flatten its children a second time.
 */
export function buildContainedExecutionPlan(declaration) {
  const groups = groupMap(declaration);
  const roots = Array.isArray(declaration.topLevel) ? [...declaration.topLevel] : [];
  const order = Array.isArray(declaration.executionOrder) ? [...declaration.executionOrder] : roots;
  if (roots.length === 0 || new Set(roots).size !== roots.length || JSON.stringify(order) !== JSON.stringify(roots)) {
    throw containmentError("GATE_CONTAINMENT_ROOT_ORDER_INVALID", "executionOrder must equal unique topLevel roots");
  }
  const selected = [];
  const covered = [];
  const seen = new Set();
  const active = new Set();
  const visit = (id, rootId, path) => {
    const group = groups.get(id);
    if (!group) throw containmentError("GATE_CONTAINMENT_UNKNOWN_GROUP", id);
    if (active.has(id)) throw containmentError("GATE_CONTAINMENT_CYCLE", id);
    if (seen.has(id)) throw containmentError("GATE_CONTAINMENT_DUPLICATE_REACHABILITY", id);
    seen.add(id);
    active.add(id);
    const record = { id, command: commandText(group), rootId, path: [...path, id] };
    if (id === rootId) selected.push({ ...record, selected: true, coveredBy: null, reason: "top-level acceptance root" });
    else covered.push({ ...record, selected: false, coveredBy: rootId, reason: "covered by selected parent/root" });
    for (const child of group.contains) visit(child, rootId, [...path, id]);
    active.delete(id);
  };
  for (const rootId of roots) visit(rootId, rootId, []);
  if (seen.size !== groups.size) {
    const unreachable = [...groups.keys()].filter((id) => !seen.has(id));
    throw containmentError("GATE_CONTAINMENT_UNREACHABLE_GROUP", unreachable.join(","));
  }
  const pushGate = groups.get("engine-release");
  const declaredPushChildren = pushGate?.contains ?? [];
  const expectedPushChildren = ENGINE_PUSH_GATE_CHILDREN.map(({ script }) => script).map((script) => script === "verify:p1" ? "engine-p1" : script === "verify:p8" ? "engine-p8" : "engine-guards");
  if (JSON.stringify(declaredPushChildren) !== JSON.stringify(expectedPushChildren)) {
    throw containmentError("GATE_CONTAINMENT_PUSH_CHILDREN_DRIFT", `${declaredPushChildren.join(",")} != ${expectedPushChildren.join(",")}`);
  }
  return Object.freeze({
    schemaVersion: "tcrn.gate-execution-plan.v1",
    roots: Object.freeze(selected),
    selected: Object.freeze(selected),
    coveredBy: Object.freeze(covered),
    all: Object.freeze([...selected, ...covered]),
  });
}

export function pushGateExecutionPlan(declaration) {
  const plan = buildContainedExecutionPlan(declaration);
  const root = plan.selected.find((entry) => entry.id === "engine-release");
  const childIds = new Set((plan.coveredBy.filter((entry) => entry.rootId === "engine-release")).map((entry) => entry.id));
  const children = ENGINE_PUSH_GATE_CHILDREN.map((entry) => ({ ...entry, id: [...childIds].find((id) => commandText(declaration.groups.find((group) => group.id === id)) === `pnpm ${entry.script}`) ?? null }));
  if (!root || children.some((entry) => entry.id === null)) throw containmentError("GATE_CONTAINMENT_PUSH_PLAN_INVALID", "engine-release child command mapping");
  return Object.freeze({ ...plan, pushGateChildren: Object.freeze(children) });
}
