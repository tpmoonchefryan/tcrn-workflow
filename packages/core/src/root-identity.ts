// SPDX-License-Identifier: Apache-2.0

import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, normalize, parse, relative, resolve, sep } from "node:path";

import type { ExplicitRoot, RootKind } from "./index.js";

const REQUIRED_ROOT_KINDS: readonly RootKind[] = [
  "framework",
  "workspace",
  "transient",
  "evidence-locator",
  "release-trust",
];

export class RootIdentityError extends Error {
  readonly reasonCode: string;

  constructor(reasonCode: string, message: string) {
    super(message);
    this.name = "RootIdentityError";
    this.reasonCode = reasonCode;
  }
}

export interface CanonicalRoot extends ExplicitRoot {
  readonly canonicalPath: string;
  readonly portableIdentity: string;
}

function fail(reasonCode: string, message: string): never {
  throw new RootIdentityError(reasonCode, message);
}

function portableIdentity(path: string): string {
  return normalize(path).normalize("NFC").toLocaleLowerCase("en-US");
}

// WSR-1: the relocation ledger records destinations that do not exist on the host
// writing them, so it needs the portable-identity derivation and the shape half of
// the distinctness rules WITHOUT the filesystem half. Exported here rather than
// duplicated: a second copy of this normalisation would drift silently, and the
// drift would only surface as a ledger that reads clean on one host and not the
// other.
export function rootPortableIdentity(path: string): string {
  return portableIdentity(path);
}

// The SHAPE half of assertDistinctRoots: exactly the five kinds in the metadata
// index order, absolute lexically-canonical paths, no portable-identity collision
// and no containment. It performs NO filesystem access, by design.
export function assertDistinctRootShape(
  roots: readonly { readonly kind: string; readonly canonicalPath: string }[],
): void {
  if (roots.length !== REQUIRED_ROOT_KINDS.length) {
    fail("ROOT_SET_INCOMPLETE", "Exactly five roots are required");
  }
  for (const [index, kind] of REQUIRED_ROOT_KINDS.entries()) {
    if (roots[index]?.kind !== kind) {
      fail("ROOT_KIND_INVALID", `root ${index} must be ${kind}`);
    }
  }
  for (const root of roots) {
    if (root.canonicalPath.length === 0 || !isAbsolute(root.canonicalPath) ||
      normalize(root.canonicalPath) !== root.canonicalPath || resolve(root.canonicalPath) !== root.canonicalPath) {
      fail("ROOT_PATH_ALIAS", `${root.kind} is not an absolute canonical path`);
    }
  }
  for (let leftIndex = 0; leftIndex < roots.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < roots.length; rightIndex += 1) {
      const left = roots[leftIndex];
      const right = roots[rightIndex];
      if (!left || !right) {
        fail("ROOT_INTERNAL_ERROR", "Root index is missing");
      }
      const leftIdentity = portableIdentity(left.canonicalPath);
      const rightIdentity = portableIdentity(right.canonicalPath);
      if (leftIdentity === rightIdentity) {
        fail("ROOT_PATH_COLLISION", `${left.kind} and ${right.kind} resolve to the same portable identity`);
      }
      const leftToRight = relative(leftIdentity, rightIdentity);
      const rightToLeft = relative(rightIdentity, leftIdentity);
      const leftContainsRight = leftToRight !== "" && !leftToRight.startsWith("..") && !leftToRight.startsWith(sep);
      const rightContainsLeft = rightToLeft !== "" && !rightToLeft.startsWith("..") && !rightToLeft.startsWith(sep);
      if (leftContainsRight || rightContainsLeft) {
        fail("ROOT_PATH_CONTAINMENT", `${left.kind} and ${right.kind} overlap by containment`);
      }
    }
  }
}

async function classifyMissingCaseAlias(path: string): Promise<never> {
  const normalized = normalize(path);
  const root = parse(normalized).root;
  const segments = relative(root, normalized).split(sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    let entries: string[];
    try {
      entries = await readdir(current);
    } catch {
      fail("ROOT_PATH_INVALID", `${path} does not resolve to a directory`);
    }
    if (entries.includes(segment)) {
      current = join(current, segment);
      continue;
    }
    const requested = segment.normalize("NFC").toLocaleLowerCase("en-US");
    if (entries.some((entry) => entry.normalize("NFC").toLocaleLowerCase("en-US") === requested)) {
      fail("ROOT_PATH_ALIAS", `${path} contains a case-aliased ancestor`);
    }
    fail("ROOT_PATH_INVALID", `${path} does not resolve to a directory`);
  }
  fail("ROOT_PATH_INVALID", `${path} does not resolve to a directory`);
}

export async function assertDistinctRoots(roots: readonly ExplicitRoot[]): Promise<readonly CanonicalRoot[]> {
  if (roots.length !== REQUIRED_ROOT_KINDS.length) {
    fail("ROOT_SET_INCOMPLETE", "Exactly five explicit roots are required");
  }
  const kinds = new Set<RootKind>();
  for (const root of roots) {
    if (!REQUIRED_ROOT_KINDS.includes(root.kind)) {
      fail("ROOT_KIND_INVALID", `Unknown root kind: ${root.kind}`);
    }
    if (kinds.has(root.kind)) {
      fail("ROOT_KIND_DUPLICATE", `Duplicate root kind: ${root.kind}`);
    }
    kinds.add(root.kind);
  }
  if (REQUIRED_ROOT_KINDS.some((kind) => !kinds.has(kind))) {
    fail("ROOT_SET_INCOMPLETE", "Every required root kind must be present");
  }

  const canonical = [] as CanonicalRoot[];
  for (const root of roots) {
    if (root.path.length === 0 || !isAbsolute(root.path)) {
      fail("ROOT_PATH_REQUIRED", `${root.kind} requires an absolute path`);
    }
    const normalized = normalize(root.path);
    if (normalized !== root.path || resolve(root.path) !== root.path) {
      fail("ROOT_PATH_ALIAS", `${root.kind} contains a lexical alias`);
    }
    let metadata;
    try {
      metadata = await lstat(root.path);
    } catch {
      // classifyMissingCaseAlias is declared Promise<never> and throws on every
      // path, so this return is unreachable at runtime; returning it lets the
      // compiler see that metadata is assigned on every path that continues.
      return await classifyMissingCaseAlias(root.path);
    }
    if (metadata.isSymbolicLink()) {
      fail("ROOT_PATH_SYMLINK", `${root.kind} must not be a symlink`);
    }
    if (!metadata.isDirectory()) {
      fail("ROOT_PATH_INVALID", `${root.kind} must be a directory`);
    }
    const resolved = await realpath(root.path);
    if (resolved !== normalized) {
      fail("ROOT_PATH_ALIAS", `${root.kind} is not the canonical real path`);
    }
    canonical.push({
      kind: root.kind,
      path: root.path,
      canonicalPath: resolved,
      portableIdentity: portableIdentity(resolved),
    });
  }

  for (let leftIndex = 0; leftIndex < canonical.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < canonical.length; rightIndex += 1) {
      const left = canonical[leftIndex];
      const right = canonical[rightIndex];
      if (!left || !right) {
        fail("ROOT_INTERNAL_ERROR", "Canonical root index is missing");
      }
      if (left.portableIdentity === right.portableIdentity) {
        fail("ROOT_PATH_COLLISION", `${left.kind} and ${right.kind} resolve to the same portable identity`);
      }
      const leftToRight = relative(left.portableIdentity, right.portableIdentity);
      const rightToLeft = relative(right.portableIdentity, left.portableIdentity);
      const leftContainsRight = leftToRight !== "" && !leftToRight.startsWith("..") && !leftToRight.startsWith(sep);
      const rightContainsLeft = rightToLeft !== "" && !rightToLeft.startsWith("..") && !rightToLeft.startsWith(sep);
      if (leftContainsRight || rightContainsLeft) {
        fail("ROOT_PATH_CONTAINMENT", `${left.kind} and ${right.kind} overlap by containment`);
      }
    }
  }
  return canonical;
}
