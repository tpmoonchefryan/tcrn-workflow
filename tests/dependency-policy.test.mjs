// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DependencyGraphError,
  assertNoKnownVulnerabilities,
  validateFrozenDependencyGraph,
} from "../scripts/lib/dependency-graph.mjs";

async function dependencyInputs() {
  const [packageJson, dependencyPolicy, lockContent] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../scripts/policy/dependency-policy.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../pnpm-lock.yaml", import.meta.url), "utf8"),
  ]);
  return { packageJson, dependencyPolicy, lockContent };
}

test("the exact frozen dependency graph has complete policy and integrity closure", async () => {
  const graph = validateFrozenDependencyGraph(await dependencyInputs());
  assert.equal(graph.records.length, 8);
  assert.deepEqual(graph.directIdentities, [
    "@types/node@24.13.2",
    "ajv@8.17.1",
    "typescript@5.9.3",
  ]);
  assert.deepEqual(graph.transitiveIdentities, [
    "fast-deep-equal@3.1.3",
    "fast-uri@3.1.3",
    "json-schema-traverse@1.0.0",
    "require-from-string@2.0.2",
    "undici-types@7.18.2",
  ]);
});

test("each exact Ajv transitive is checked by the vulnerability denylist", async () => {
  const graph = validateFrozenDependencyGraph(await dependencyInputs());
  assert.doesNotThrow(() => assertNoKnownVulnerabilities(graph, []));
  for (const identity of graph.transitiveIdentities) {
    const separator = identity.lastIndexOf("@");
    const vulnerability = {
      package: identity.slice(0, separator),
      version: identity.slice(separator + 1),
    };
    assert.throws(
      () => assertNoKnownVulnerabilities(graph, [vulnerability]),
      (error) => error instanceof DependencyGraphError && error.reasonCode === "VULNERABLE_DEPENDENCY",
      identity,
    );
  }
});

test("unapproved lock packages and integrity drift fail closed", async () => {
  const inputs = await dependencyInputs();
  const missingPolicy = structuredClone(inputs.dependencyPolicy);
  delete missingPolicy.dependencies["fast-uri@3.1.3"];
  assert.throws(
    () => validateFrozenDependencyGraph({ ...inputs, dependencyPolicy: missingPolicy }),
    (error) => error instanceof DependencyGraphError && error.reasonCode === "DEPENDENCY_GRAPH_POLICY_MISMATCH",
  );
  const wrongIntegrity = structuredClone(inputs.dependencyPolicy);
  wrongIntegrity.dependencies["fast-uri@3.1.3"].integrity = "sha512-invalid";
  assert.throws(
    () => validateFrozenDependencyGraph({ ...inputs, dependencyPolicy: wrongIntegrity }),
    (error) => error instanceof DependencyGraphError && error.reasonCode === "DEPENDENCY_GRAPH_INTEGRITY_MISMATCH",
  );
  const importerDrift = inputs.lockContent.replace("specifier: 8.17.1", "specifier: 8.17.0");
  assert.throws(
    () => validateFrozenDependencyGraph({ ...inputs, lockContent: importerDrift }),
    (error) => error instanceof DependencyGraphError && error.reasonCode === "DEPENDENCY_LOCK_IMPORTER_NOT_EXACT",
  );
});

test("a scoped lock identity parses through its surrounding pnpm quotes", async () => {
  const inputs = await dependencyInputs();
  // pnpm quotes every lock key beginning with "@". Before the identity match stripped
  // those quotes the version pattern saw a trailing quote and the whole graph failed to
  // parse, so no scoped dependency could be admitted at all.
  assert.match(inputs.lockContent, /^ {2}'@types\/node@24\.13\.2':$/mu);
  const graph = validateFrozenDependencyGraph(inputs);
  assert.ok(graph.directIdentities.includes("@types/node@24.13.2"));
  const scoped = graph.records.find((record) => record.identity === "@types/node@24.13.2");
  assert.equal(scoped.name, "@types/node");
  assert.equal(scoped.version, "24.13.2");
});
