#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// STORY-278: read-only three-way coverage report for the portal/DS boundary.

import { readFile } from "node:fs/promises";

const PORTAL = process.env.TCRN_PORTAL_INDEX ?? "portal/index.html";
const SNAPSHOT = process.env.TCRN_PORTAL_DS_SNAPSHOT ?? "portal/ds-component-css.snapshot.css";
const ROSTER = process.env.TCRN_PORTAL_CLASS_ROOTS ?? "scripts/policy/portal-class-roots.json";

function rootNames(source) {
  return [...new Set([...source.matchAll(/\.tcrn-[a-z0-9-]+/gu)]
    .map((match) => match[0].slice(1))
    .filter((name) => !name.includes("__") && !name.includes("--")))]
    .sort();
}

function portalStyle(source) {
  const styles = [...source.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/gu)];
  if (styles.length === 0) throw new Error("PORTAL_STYLE_BLOCK_MISSING");
  return styles.length === 1 ? styles[0][1] : styles[1][1];
}

function usageCount(source, className) {
  return [...source.matchAll(new RegExp(`class=(?:"|')[^"']*\\b${className}\\b`, "gu"))].length;
}

// INC-197: the baseline is a versioned roster, not `git show HEAD:portal/index.html`.
// Reading it from HEAD made the verdict depend on whether the portal change was
// committed yet: the same working tree measured 51 roots before the commit that
// carried the portal rewrite into HEAD and 64 after, so the frozen `=== 51` went
// red on a change that added nothing unregistered. The roster fails closed in both
// directions the way source-allowlist.json does — see the file's own `discipline`.
const currentText = await readFile(PORTAL, "utf8");
const snapshotText = await readFile(SNAPSHOT, "utf8");
const rosterText = await readFile(ROSTER, "utf8");
const baselineRoots = [...JSON.parse(rosterText).roots].sort();
const currentRoots = rootNames(portalStyle(currentText));
const snapshotRoots = rootNames(snapshotText);
const removedBySnapshotDiff = baselineRoots.filter((name) => !currentRoots.includes(name));
const addedBySnapshotDiff = currentRoots.filter((name) => !baselineRoots.includes(name));

const returnedComponents = [
  { name: "Switch", className: "tcrn-switch", replacement: "Use the DS snapshot class; no portal-local duplicate." },
  { name: "StatCard", className: "tcrn-stat-card", replacement: "Use the DS snapshot class; no portal-local duplicate." },
  { name: "SettingRow", className: "tcrn-setting-row", replacement: "Use the DS snapshot class; no portal-local duplicate." },
  { name: "FieldProvenance", className: "tcrn-field-provenance", replacement: "Use the DS snapshot class; no portal-local duplicate." },
  { name: "LineNumberedEditor", className: "tcrn-line-numbered-editor", replacement: "Use the DS snapshot class; no portal-local duplicate." },
  { name: "AppStatusBar", className: "tcrn-app-status-bar", replacement: "Use the DS snapshot class; no portal-local duplicate." },
  { name: "DefinitionList", className: "tcrn-definition-list", replacement: "Use the DS snapshot class; no portal-local duplicate." },
  { name: "LockHint", className: "tcrn-lock-hint", replacement: "Use the DS snapshot class; no portal-local duplicate." },
  { name: "Ninth slot decision", className: "tcrn-readback-panel", replacement: "No new S254 component: the existing DS readback panel is the substitute; do not add a duplicate." },
];
const componentRows = returnedComponents.map((component) => {
  const snapshotRegistered = snapshotRoots.includes(component.className);
  const portalUsage = usageCount(currentText, component.className);
  return {
    ...component,
    snapshotRegistered,
    portalUsage,
    status: snapshotRegistered && portalUsage > 0 ? "covered" : "missing",
  };
});

// Rows cover the union, so a root the portal defines without listing it gets a row
// of its own rather than going unmentioned: that is the second direction the old
// baseline could not express.
const classRows = [...new Set([...baselineRoots, ...currentRoots])].sort().map((className) => {
  const registered = baselineRoots.includes(className);
  const present = currentRoots.includes(className);
  return {
    className,
    baselinePresent: registered,
    currentPresent: present,
    snapshotPresent: snapshotRoots.includes(className),
    status: registered && present ? "covered" : registered ? "missing" : "unregistered",
  };
});

const missingComponents = componentRows.filter((row) => row.status !== "covered");
const missingPortalClasses = classRows.filter((row) => row.status === "missing");
const unregisteredPortalClasses = classRows.filter((row) => row.status === "unregistered");
const renamedOrRemoved = removedBySnapshotDiff.length > 0;
const ok = missingComponents.length === 0
  && missingPortalClasses.length === 0
  && unregisteredPortalClasses.length === 0
  && !renamedOrRemoved;

process.stdout.write(`${JSON.stringify({
  schemaVersion: "tcrn.inc278-component-coverage.v1",
  ok,
  reasonCode: ok ? "COMPONENT_COVERAGE_CONSERVATION_GREEN" : "COMPONENT_COVERAGE_CONSERVATION_RED",
  execution: "read-only source and snapshot comparison; no portal, CLI, or engine execution",
  portalOwnedClassBaseline: {
    source: ROSTER,
    expectedCount: baselineRoots.length,
    actualCount: currentRoots.length,
    rows: classRows,
    snapshotDiff: {
      removedOrRenamed: removedBySnapshotDiff,
      added: addedBySnapshotDiff,
      method: "set difference between the versioned S253 class-root roster and the current class-root set",
    },
  },
  returnedComponents: {
    expectedCount: 9,
    rows: componentRows,
  },
  decisionSummary: {
    platformLayer: "Keep the rostered S253 portal class roots stable; consume the eight named S254 return components from the DS snapshot; use the existing readback panel for the ninth slot and add no new component.",
    followUp: "Any visual change stays in portal-owned CSS; any component-contract change waits for an Owner-approved DS workflow.",
  },
}, null, 2)}\n`);
if (!ok) process.exitCode = 1;
