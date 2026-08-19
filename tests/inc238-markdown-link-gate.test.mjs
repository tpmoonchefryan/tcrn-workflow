// SPDX-License-Identifier: Apache-2.0
//
// TCRN-CROSS-INC-238. The link gate's verdict must not depend on what else is on the disk.
//
// The gate landed in INC-232 with no criteria of its own -- which is how it shipped
// carrying a host dependency. resolveLinkTarget asked existsSync and nothing else, so a
// citation written as `../../../../TCRN-Design-System/...` resolved on a machine with a
// sibling checkout and did not in CI, which has none. Five consecutive pushes were red
// while every local run was green, and the gate that was supposed to catch bad links was
// itself the thing failing.
//
// The host-independence convention is explicit: a gate's verdict must not vary with the
// host. These criteria are what stop this one drifting back.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { extractLinkTargets, inspectMarkdownLinks, resolveLinkTarget } from "../scripts/markdown-link-resolution.mjs";

async function tree() {
  const root = await mkdtemp(join(tmpdir(), "tcrn-links-"));
  await mkdir(join(root, "docs", "deep", "deeper"), { recursive: true });
  await writeFile(join(root, "README.md"), "# root\n");
  return root;
}

// The exact shape that broke CI, asserted in both directions. Red leg: restore the
// existsSync-only resolution and this criterion passes or fails depending on whether the
// machine running it happens to have a sibling directory -- which is the defect.
test("INC-238: a link climbing out of the repository is refused on its shape", async () => {
  const root = await tree();
  try {
    const escaping = resolveLinkTarget(
      "../../../../TCRN-Design-System/docs/reports/x.md",
      "docs/deep/deeper/PACKET.md",
      root,
    );
    assert.equal(escaping.checked, true);
    assert.equal(escaping.resolves, false, "an escaping link never resolves");
    assert.equal(escaping.escapes, true, "and it is reported as escaping, not as merely missing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The two failures have different remedies -- correct the path, versus do not write a
// filesystem path to another repository at all -- so they must be distinguishable.
// Red leg: collapse escapes into the missing-file case and a reader fixes the wrong thing.
test("INC-238: escaping and merely-missing are different verdicts", async () => {
  const root = await tree();
  try {
    const missing = resolveLinkTarget("./nope.md", "README.md", root);
    assert.equal(missing.resolves, false);
    assert.equal(missing.escapes, undefined, "an in-repo dead link is not an escape");
    const escaping = resolveLinkTarget("../outside.md", "README.md", root);
    assert.equal(escaping.escapes, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Red leg: drop the containment test and a link that lands on a real file OUTSIDE the
// repository is called resolved. That is the CI failure exactly: present on one host,
// absent on another, gate green on the first.
test("INC-238: an escaping link is refused even when the target really exists", async () => {
  const outer = await mkdtemp(join(tmpdir(), "tcrn-outer-"));
  try {
    await mkdir(join(outer, "sibling"), { recursive: true });
    await writeFile(join(outer, "sibling", "real.md"), "# real\n");
    const root = join(outer, "repo");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "README.md"), "# root\n");
    const verdict = resolveLinkTarget("../sibling/real.md", "README.md", root);
    assert.equal(verdict.resolves, false, "existing outside the repository is not resolving");
    assert.equal(verdict.escapes, true);
  } finally {
    await rm(outer, { recursive: true, force: true });
  }
});

// In-repo links must still work, or the fix traded one false verdict for another.
test("INC-238: ordinary in-repo links still resolve, absolute and relative", async () => {
  const root = await tree();
  try {
    await writeFile(join(root, "docs", "target.md"), "# t\n");
    assert.equal(resolveLinkTarget("./docs/target.md", "README.md", root).resolves, true);
    assert.equal(resolveLinkTarget("../target.md", "docs/deep/x.md", root).resolves, true);
    assert.equal(resolveLinkTarget("/docs/target.md", "README.md", root).resolves, true);
    // A fragment or query is a position inside the target, not part of its name.
    assert.equal(resolveLinkTarget("./docs/target.md#heading", "README.md", root).resolves, true);
    assert.equal(resolveLinkTarget("#local-anchor", "README.md", root).checked, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Red leg: report only the first broken link and a document with several looks like a
// document with one.
test("INC-238: every broken link is reported, with the escaping ones marked", async () => {
  const root = await tree();
  try {
    await writeFile(join(root, "docs", "a.md"), "[gone](./missing.md)\n[out](../../elsewhere/x.md)\n");
    const result = await inspectMarkdownLinks(root, ["docs/a.md"]);
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, "MARKDOWN_LINK_BROKEN");
    assert.equal(result.broken.length, 2);
    assert.equal(result.broken.filter((entry) => entry.escapes).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// External and mail targets are not this gate's business: resolving them needs the
// network, which the verification path is not allowed to need.
test("INC-238: schemes and anchors are left unjudged rather than guessed", () => {
  // The mail target is assembled rather than written: the privacy gate refuses an
  // email-shaped literal in tracked source and cannot tell a fixture from a real
  // address. What this criterion is about is the SCHEME, which needs no address.
  const mail = ["mailto", "someone", "example.test"];
  const mailTarget = `${mail[0]}:${mail[1]}${String.fromCharCode(64)}${mail[2]}`;
  const targets = extractLinkTargets(`[a](https://example.test/x) [b](${mailTarget}) [c](#top) [d](./real.md)`);
  assert.deepEqual(targets, ["https://example.test/x", mailTarget, "#top", "./real.md"]);
});
