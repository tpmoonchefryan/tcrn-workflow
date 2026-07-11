// SPDX-License-Identifier: Apache-2.0

import { compareCanonicalText } from "./canonical-order.mjs";

export class DependencyGraphError extends Error {
  constructor(reasonCode, message) {
    super(message);
    this.name = "DependencyGraphError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode, message) {
  throw new DependencyGraphError(reasonCode, message);
}

function splitIdentity(identity) {
  const separator = identity.lastIndexOf("@");
  if (separator < 1 || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(identity.slice(separator + 1))) {
    fail("DEPENDENCY_LOCK_PARSE", identity);
  }
  return { name: identity.slice(0, separator), version: identity.slice(separator + 1) };
}

function parseLock(lockContent) {
  const packages = new Map();
  const snapshots = new Map();
  const importerDirect = new Map();
  let section = "";
  let currentIdentity = null;
  let dependencyBlock = false;
  let importerDependencyBlock = false;
  let currentImporterDependency = null;
  for (const line of lockContent.split("\n")) {
    if (line === "importers:") {
      section = "importers";
      continue;
    }
    if (line === "packages:") {
      section = "packages";
      currentIdentity = null;
      continue;
    }
    if (section === "importers") {
      if (line === "  .:") {
        importerDependencyBlock = false;
        currentImporterDependency = null;
        continue;
      }
      if (/^    (?:dependencies|devDependencies|optionalDependencies):$/u.test(line)) {
        importerDependencyBlock = true;
        currentImporterDependency = null;
        continue;
      }
      const importerDependencyMatch = importerDependencyBlock ? line.match(/^      ['"]?([^'"\s:]+)['"]?:$/u) : null;
      if (importerDependencyMatch) {
        currentImporterDependency = importerDependencyMatch[1];
        if (importerDirect.has(currentImporterDependency)) {
          fail("DEPENDENCY_LOCK_DUPLICATE", currentImporterDependency);
        }
        importerDirect.set(currentImporterDependency, { specifier: null, version: null });
        continue;
      }
      if (currentImporterDependency) {
        const fieldMatch = line.match(/^        (specifier|version): ([^\s]+)$/u);
        if (fieldMatch) {
          importerDirect.get(currentImporterDependency)[fieldMatch[1]] = fieldMatch[2];
          continue;
        }
      }
      if (/^  \S/u.test(line)) {
        importerDependencyBlock = false;
        currentImporterDependency = null;
      }
    }
    if (line === "snapshots:") {
      section = "snapshots";
      currentIdentity = null;
      continue;
    }
    const identityMatch = line.match(/^  ([^\s].+):(?: \{\})?$/u);
    if (identityMatch && ["packages", "snapshots"].includes(section)) {
      currentIdentity = identityMatch[1];
      splitIdentity(currentIdentity);
      dependencyBlock = false;
      if (section === "packages") {
        if (packages.has(currentIdentity)) {
          fail("DEPENDENCY_LOCK_DUPLICATE", currentIdentity);
        }
        packages.set(currentIdentity, { integrity: null });
      } else {
        if (snapshots.has(currentIdentity)) {
          fail("DEPENDENCY_LOCK_DUPLICATE", currentIdentity);
        }
        snapshots.set(currentIdentity, []);
      }
      continue;
    }
    if (section === "packages" && currentIdentity) {
      const integrityMatch = line.match(/^    resolution: \{integrity: ([A-Za-z0-9+/_=-]+)\}$/u);
      if (integrityMatch) {
        packages.get(currentIdentity).integrity = integrityMatch[1];
      }
    }
    if (section === "snapshots" && currentIdentity) {
      if (line === "    dependencies:") {
        dependencyBlock = true;
        continue;
      }
      if (/^    \S/u.test(line)) {
        dependencyBlock = false;
      }
      if (dependencyBlock) {
        const dependencyMatch = line.match(/^      ['"]?([^'"\s:]+)['"]?: ([^\s]+)$/u);
        if (dependencyMatch) {
          snapshots.get(currentIdentity).push(`${dependencyMatch[1]}@${dependencyMatch[2]}`);
        }
      }
    }
  }
  if (packages.size === 0 || snapshots.size !== packages.size) {
    fail("DEPENDENCY_LOCK_PARSE", `packages=${packages.size};snapshots=${snapshots.size}`);
  }
  for (const [identity, entry] of packages) {
    if (!entry.integrity || !snapshots.has(identity)) {
      fail("DEPENDENCY_LOCK_INTEGRITY_MISSING", identity);
    }
  }
  for (const [name, entry] of importerDirect) {
    if (!entry.version || entry.version !== entry.specifier) {
      fail("DEPENDENCY_LOCK_IMPORTER_NOT_EXACT", `${name}:${entry.specifier}:${entry.version}`);
    }
  }
  return { packages, snapshots, importerDirect };
}

export function validateFrozenDependencyGraph({ packageJson, dependencyPolicy, lockContent }) {
  const { packages, snapshots, importerDirect } = parseLock(lockContent);
  const directIdentities = [];
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [name, version] of Object.entries(packageJson[section] ?? {})) {
      if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
        fail("DEPENDENCY_DIRECT_NOT_EXACT", `${name}@${version}`);
      }
      directIdentities.push(`${name}@${version}`);
    }
  }
  directIdentities.sort(compareCanonicalText);
  const importerIdentities = [...importerDirect.entries()]
    .map(([name, entry]) => `${name}@${entry.version}`)
    .sort(compareCanonicalText);
  if (JSON.stringify(importerIdentities) !== JSON.stringify(directIdentities)) {
    fail("DEPENDENCY_LOCK_IMPORTER_MISMATCH", `lock=${importerIdentities.join(",")};package=${directIdentities.join(",")}`);
  }
  const policyEntries = dependencyPolicy?.dependencies;
  if (policyEntries === null || typeof policyEntries !== "object" || Array.isArray(policyEntries)) {
    fail("DEPENDENCY_POLICY_INVALID", "dependencies");
  }
  const policyIdentities = Object.keys(policyEntries).sort(compareCanonicalText);
  const lockIdentities = [...packages.keys()].sort(compareCanonicalText);
  if (JSON.stringify(policyIdentities) !== JSON.stringify(lockIdentities)) {
    fail("DEPENDENCY_GRAPH_POLICY_MISMATCH", `policy=${policyIdentities.join(",")};lock=${lockIdentities.join(",")}`);
  }
  const approvedDirect = policyIdentities.filter((identity) => policyEntries[identity].direct).sort(compareCanonicalText);
  if (JSON.stringify(approvedDirect) !== JSON.stringify(directIdentities)) {
    fail("DEPENDENCY_GRAPH_DIRECT_MISMATCH", `policy=${approvedDirect.join(",")};package=${directIdentities.join(",")}`);
  }

  const reachable = new Set();
  const pending = [...directIdentities];
  while (pending.length > 0) {
    const identity = pending.pop();
    if (reachable.has(identity)) {
      continue;
    }
    if (!packages.has(identity) || !snapshots.has(identity)) {
      fail("DEPENDENCY_GRAPH_REFERENCE_MISSING", identity);
    }
    reachable.add(identity);
    for (const dependency of snapshots.get(identity)) {
      if (!packages.has(dependency)) {
        fail("DEPENDENCY_GRAPH_REFERENCE_MISSING", `${identity}->${dependency}`);
      }
      pending.push(dependency);
    }
  }
  const reachableIdentities = [...reachable].sort(compareCanonicalText);
  if (JSON.stringify(reachableIdentities) !== JSON.stringify(lockIdentities)) {
    fail("DEPENDENCY_GRAPH_UNREACHABLE", lockIdentities.filter((identity) => !reachable.has(identity)).join(","));
  }

  const directSet = new Set(directIdentities);
  const records = lockIdentities.map((identity) => {
    const { name, version } = splitIdentity(identity);
    const policy = policyEntries[identity];
    const lock = packages.get(identity);
    if (policy.integrity !== lock.integrity) {
      fail("DEPENDENCY_GRAPH_INTEGRITY_MISMATCH", identity);
    }
    if (Boolean(policy.direct) !== directSet.has(identity) || typeof policy.license !== "string") {
      fail("DEPENDENCY_POLICY_INVALID", identity);
    }
    return {
      identity,
      name,
      version,
      integrity: lock.integrity,
      direct: directSet.has(identity),
      dependencies: [...snapshots.get(identity)].sort(compareCanonicalText),
      license: policy.license,
    };
  });
  return {
    records,
    identities: new Set(lockIdentities),
    directIdentities,
    transitiveIdentities: lockIdentities.filter((identity) => !directSet.has(identity)),
  };
}

export function assertNoKnownVulnerabilities(graph, knownVulnerabilities) {
  if (!Array.isArray(knownVulnerabilities)) {
    fail("VULNERABILITY_POLICY_INVALID", "knownVulnerabilities");
  }
  for (const vulnerability of knownVulnerabilities) {
    if (typeof vulnerability?.package !== "string" || typeof vulnerability.version !== "string") {
      fail("VULNERABILITY_POLICY_INVALID", JSON.stringify(vulnerability));
    }
    const identity = `${vulnerability.package}@${vulnerability.version}`;
    if (graph.identities.has(identity)) {
      fail("VULNERABLE_DEPENDENCY", identity);
    }
  }
  return { checkedPackages: graph.records.length, knownVulnerabilityTuples: knownVulnerabilities.length };
}
