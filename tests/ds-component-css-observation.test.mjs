// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-INC-223. The DS reconciliation used to answer one question with two
// legs: does this tree agree with itself, and has the Design System moved on. Only
// the first is something this repository owns and can answer the same way on every
// machine — CI has no sibling checkout, so the second made the verdict depend on
// where it ran. Splitting them is only half a fix; the other half is proving the
// downgraded leg is still *seen*, because "reported beside the verdict" and
// "quietly dropped" are indistinguishable from the verdict alone.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { INLINE_MARKER, reconcile } from "../scripts/ds-component-css-reconcile.mjs";

const SOURCE_SUFFIX = "packages/ui-react/src/components/Navigation/Navigation.tsx";
const CSS = ":root { --tcrn-probe: #246f80; }\n";

/** The DS source shape the extractor reads: one tagged template export. */
const sourceFixture = (css) => `export const tcrnComponentCss = \`${css}\`;\n`;

async function fixture(context, { snapshotCss = CSS, inlineCss = CSS, sourceCss = CSS } = {}) {
  const base = await mkdtemp(join(tmpdir(), "tcrn-inc223-"));
  context.after(() => rm(base, { recursive: true, force: true }));
  const snapshotPath = join(base, "snapshot.css");
  const indexPath = join(base, "index.html");
  const sourcePath = join(base, "ds", SOURCE_SUFFIX);
  await writeFile(snapshotPath, snapshotCss, "utf8");
  await writeFile(indexPath, `<html>${INLINE_MARKER}${inlineCss}</style></html>\n`, "utf8");
  if (sourceCss !== null) {
    await mkdir(dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, sourceFixture(sourceCss), "utf8");
  }
  return { snapshotPath, indexPath, sourcePath };
}

test("INC-223 all three agreeing is a plain green with nothing to observe", async (context) => {
  const report = await reconcile(await fixture(context));
  assert.equal(report.ok, true);
  assert.equal(report.reasonCode, "DS_COMPONENT_CSS_RECONCILED");
  assert.deepEqual(report.observations, []);
  assert.equal(report.reconciliation.sourceReconciled, true);
});

test("INC-223 a moved Design System source is observed, not judged", async (context) => {
  const report = await reconcile(await fixture(context, { sourceCss: ":root { --tcrn-probe: #246f81; }\n" }));
  assert.equal(report.ok, true, "a sibling repository's edit cannot turn this repository red");
  assert.equal(report.reasonCode, "DS_COMPONENT_CSS_INLINE_RECONCILED");
  assert.equal(report.reconciliation.sourceMatchesSnapshot, false);
  assert.equal(report.reconciliation.sourceReconciled, false);
  // The whole point of the downgrade: still visible, and it names the way out.
  assert.equal(report.observations.length, 1);
  assert.equal(report.observations[0].reasonCode, "DS_COMPONENT_CSS_SOURCE_DRIFT");
  assert.match(report.observations[0].remedy, /generate-ds-component-css-snapshot/u);
  assert.notEqual(report.observations[0].sourceSha256, report.observations[0].snapshotSha256);
});

test("INC-223 the leg this repository owns still goes red", async (context) => {
  const report = await reconcile(await fixture(context, { inlineCss: ":root { --tcrn-probe: #246f82; }\n" }));
  assert.equal(report.ok, false);
  assert.equal(report.reasonCode, "DS_COMPONENT_CSS_INLINE_DRIFT");
  assert.equal(report.inline.matchesSnapshot, false);
});

test("INC-223 a machine without the Design System says so rather than claiming agreement", async (context) => {
  const report = await reconcile(await fixture(context, { sourceCss: null }));
  assert.equal(report.ok, true);
  assert.equal(report.reasonCode, "DS_COMPONENT_CSS_SNAPSHOT_SELF_SUFFICIENT");
  assert.equal(report.reconciliation.sourceStatus, "unverified");
  assert.equal(report.reconciliation.sourceReconciled, false);
  assert.deepEqual(report.observations, [], "absence is not drift — there is nothing to compare");
});
