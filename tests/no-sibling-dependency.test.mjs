// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-INC-215 — the dependency-direction gate, both sides.
//
// A gate that has only ever been seen green proves nothing, so every red is exercised
// here against an injected shape. The three legitimate ways to name a sibling are
// exercised too: a gate that fires on a provenance citation gets muted within a week,
// and a muted gate is worth less than no gate, because it still looks like coverage.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  canonicalSiblingRoster,
  findReachingLines,
  judgeNoSiblingDependency,
  REPO_ROOT,
} from "../scripts/no-sibling-dependency-proof.mjs";
import { INSTALL_MANIFEST } from "../dist/build/packages/core/src/index.js";

const SIBLINGS = ["TCRN-AOS", "TCRN-Design-System"];

/** Judge one synthetic source file without touching the repository. */
function judgeSource(text, siblings = SIBLINGS) {
  const findings = findReachingLines({
    repoRoot: "/repo",
    siblings,
    files: ["/repo/scripts/subject.mjs"],
    read: () => text,
  });
  return findings;
}

test("the real repository carries no reaching line", () => {
  // The gate's own test file (no-sibling-dependency.test.mjs) is exempted from scanning
  // because it contains synthetic violation samples for testing red legs. A gate that fires
  // on its own test fixtures gets muted within a week, and a muted gate is worth less than
  // no gate because it still looks like coverage. The repository as a whole must have no
  // reaching lines after INC-214 cleared them. This check ensures the gate remains armed.
  const result = judgeNoSiblingDependency();
  assert.deepEqual(result.findings, [], "the repository must carry no reaching lines");
  assert.equal(result.reasonCode, "NO_SIBLING_DEPENDENCY", "gate result must have correct reason code");
  // Verify the gate's own test file is excluded and does not appear in findings
  const gateTestFindings = result.findings.filter((f) => f.file === "tests/no-sibling-dependency.test.mjs");
  assert.deepEqual(gateTestFindings, [], "gate test file should be excluded from scanning");
});

test("the validated install-manifest supplies a canonical roster and Helper identity", () => {
  const roster = canonicalSiblingRoster({ repoRoot: REPO_ROOT, manifest: INSTALL_MANIFEST });
  assert.deepEqual(roster.siblings, ["TCRN-AOS", "TCRN-Design-System", "TCRN-TMS", "joi-button", "tcrn-workflow-helper"]);
  assert.equal(roster.self, "tcrn-workflow");
  assert.equal(roster.helperIdentity, "tcrn-workflow-helper");
  assert.match(roster.manifestDigest, /^[a-f0-9]{64}$/u);
});

test("a clone-layout checkout agrees with the manifest roster without inspecting parent directories", () => {
  const root = mkdtempSync(join(tmpdir(), "tcrn-siblings-clone-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "tcrn-workflow" }));
    const roster = canonicalSiblingRoster({ repoRoot: root, manifest: INSTALL_MANIFEST });
    assert.deepEqual(roster.siblings, ["TCRN-AOS", "TCRN-Design-System", "TCRN-TMS", "joi-button", "tcrn-workflow-helper"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("canonical roster findings remain comparable for a synthetic sibling violation", () => {
  const roster = canonicalSiblingRoster({ repoRoot: REPO_ROOT, manifest: INSTALL_MANIFEST });
  const findings = judgeSource(`const raw = readFileSync(resolve(PLATFORM_ROOT, "TCRN-AOS/docs/thing.json"), "utf8");`, roster.siblings);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].sibling, "TCRN-AOS");
  const spawned = judgeSource(`spawn(process.execPath, [join(root, "tcrn-workflow-helper/scripts/check.mjs")]);`, roster.siblings);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].sibling, "tcrn-workflow-helper");
});

test("invalid, incomplete, and ambiguous manifest inputs are not-verifiable", () => {
  const invalid = judgeNoSiblingDependency({ repoRoot: REPO_ROOT, manifest: { schemaVersion: "wrong" } });
  assert.equal(invalid.reasonCode, "SIBLING_DEPENDENCY_NOT_VERIFIABLE");
  assert.equal(invalid.comparable, false);

  const missingSelf = { ...INSTALL_MANIFEST, projects: INSTALL_MANIFEST.projects.filter((project) => project.name !== "tcrn-workflow") };
  const incomplete = judgeNoSiblingDependency({ repoRoot: REPO_ROOT, manifest: missingSelf });
  assert.equal(incomplete.reasonCode, "SIBLING_DEPENDENCY_NOT_VERIFIABLE");
  assert.equal(incomplete.comparable, false);

  const helperItems = INSTALL_MANIFEST.items.filter((item) => item.acceptanceProbe.includes("probe:helper-skill-digest"));
  const ambiguous = { ...INSTALL_MANIFEST, items: INSTALL_MANIFEST.items.map((item) => item === helperItems[0] ? { ...item, pathTemplate: "<HOME>/.agents/skills/other-helper" } : item) };
  const ambiguousResult = judgeNoSiblingDependency({ repoRoot: REPO_ROOT, manifest: ambiguous });
  assert.equal(ambiguousResult.reasonCode, "SIBLING_DEPENDENCY_NOT_VERIFIABLE");
  assert.equal(ambiguousResult.comparable, false);
});

test("an unreadable scan input is not-verifiable rather than green", () => {
  const result = judgeNoSiblingDependency({
    repoRoot: REPO_ROOT,
    manifest: INSTALL_MANIFEST,
    files: ["/unreadable/sibling-proof.mjs"],
    read: () => { throw new Error("synthetic unreadable input"); },
  });
  assert.equal(result.reasonCode, "SIBLING_DEPENDENCY_NOT_VERIFIABLE");
  assert.equal(result.comparable, false);
});

test("REDS on a spawn of a sibling script", () => {
  const findings = judgeSource(`const child = spawn(process.execPath, [join(root, "TCRN-AOS/deploy/x.mjs")]);`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].sibling, "TCRN-AOS");
  assert.equal(findings[0].operation, "process-spawn");
});

test("REDS on a filesystem read of a sibling file", () => {
  const findings = judgeSource(`const raw = readFileSync(resolve(PLATFORM_ROOT, "TCRN-AOS/docs/thing.json"), "utf8");`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].operation, "filesystem-read");
});

test("REDS on an existsSync probe — asking whether a sibling is there is still reaching in", () => {
  const findings = judgeSource(`if (existsSync(join(PLATFORM_ROOT, "TCRN-Design-System/x.json"))) return true;`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].sibling, "TCRN-Design-System");
});

test("REDS on a dynamic import of a sibling module", () => {
  const findings = judgeSource(`const mod = await import("../../TCRN-AOS/deploy/aos-local-client/topology.mjs");`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].operation, "filesystem-read");
});

test("GREENS on a provenance citation: a string compared, never a file opened", () => {
  // The story-rule registry records which sibling document a rule came from. Firing here
  // would push someone to delete the citation, which falsifies where the rule came from.
  const findings = judgeSource(`  "TCRN-AOS/docs/reports/init-020/HANDOVER-2026-08-08-final-codex.md",`);
  assert.deepEqual(findings, []);
});

test("GREENS on a classified command sample: the observer reads these, it does not run them", () => {
  const findings = judgeSource(`  { id: "A14", command: \`pnpm --dir TCRN-AOS engine-host:verify\`, expect: "PASS" },`);
  assert.deepEqual(findings, []);
});

test("GREENS on a generic tool aimed at a directory", () => {
  // `codegraph serve --path <sibling>` runs this platform's own binary; an absent sibling
  // leaves a dead config entry rather than a broken dependency.
  const findings = judgeSource(`    addMcpServer("codegraph-aos", "pnpm", ["--dir", tms, "exec", "codegraph", "serve", "--path", aos]),`);
  assert.deepEqual(findings, []);
});

test("GREENS on a comment that explains the rule", () => {
  // This gate has to be sayable in its own source and in the convention describing it.
  const findings = judgeSource(`// spawning TCRN-AOS/deploy/x.mjs is exactly what this gate forbids`);
  assert.deepEqual(findings, []);
});

test("a reaching line names its file, line, sibling and operation", () => {
  const findings = judgeSource(`const raw = readFileSync("TCRN-AOS/x.json", "utf8");`);
  assert.deepEqual(Object.keys(findings[0]).sort(), ["file", "line", "operation", "sample", "sibling"]);
  assert.equal(findings[0].line, 1, "a finding without a line number cannot be acted on");
});

// TCRN-CROSS-INC-274: New detection rules for paths outside repository
test("REDS on relative ascent escape (3+ consecutive ../) with filesystem read", () => {
  const findings = judgeSource(`const config = readFileSync("../../../sibling-or-container/file.json", "utf8");`);
  assert.equal(findings.length, 1, "three-level ascent with read operation must be flagged");
  assert.equal(findings[0].outsideReference, "relative-ascent-escape");
  assert.equal(findings[0].operation, "filesystem-read");
  assert.ok(findings[0].sample.includes("../../../"), "sample must contain the ascent pattern");
});

test("REDS on relative ascent escape (3+ consecutive ../) with process spawn", () => {
  const findings = judgeSource(`spawn("node", ["../../../platform-root/engine/script.mjs"]);`);
  assert.equal(findings.length, 1, "three-level ascent with spawn must be flagged");
  assert.equal(findings[0].outsideReference, "relative-ascent-escape");
  assert.equal(findings[0].operation, "process-spawn");
});

test("REDS on relative ascent escape with existsSync", () => {
  const findings = judgeSource(`if (existsSync("../../../other/config.json")) { }`);
  assert.equal(findings.length, 1, "three-level ascent with existsSync must be flagged");
  assert.equal(findings[0].outsideReference, "relative-ascent-escape");
});

test("GREENS on two-level relative ascent (../../) — normal within repository", () => {
  const findings = judgeSource(`const base = readFileSync("../../config.json", "utf8");`);
  assert.deepEqual(findings, [], "two-level ascent is normal and should not be flagged");
});

test("GREENS on single-level relative ascent (../) — normal within repository", () => {
  const findings = judgeSource(`const sibling = readFileSync("../other-module/data.json", "utf8");`);
  assert.deepEqual(findings, [], "single-level ascent is normal and should not be flagged");
});

test("REDS on platform workspace assembly via join with .tcrn and workspace fragments", () => {
  const findings = judgeSource(`const path = [".tcrn", "workspace"].join("-"); readFileSync(path, "utf8");`);
  assert.equal(findings.length, 1, "assembly of .tcrn-workspace path with read operation must be flagged");
  assert.equal(findings[0].outsideReference, "platform-workspace-assembly");
  assert.equal(findings[0].operation, "filesystem-read");
});

test("REDS on platform workspace assembly with fragments in opposite order", () => {
  const findings = judgeSource(`const pieces = ["workspace", ".tcrn"]; const p = pieces.join("-"); existsSync(p);`);
  assert.equal(findings.length, 1, "assembly fragments in reverse order with operation must be flagged");
  assert.equal(findings[0].outsideReference, "platform-workspace-assembly");
});

test("REDS on platform workspace assembly with spawn", () => {
  const findings = judgeSource(`spawn("node", [".tcrn", "workspace"].join("-") + "/script.mjs");`);
  assert.equal(findings.length, 1, "assembly with spawn must be flagged");
  assert.equal(findings[0].outsideReference, "platform-workspace-assembly");
});

test("GREENS on array join that mentions workspace but not .tcrn", () => {
  const findings = judgeSource(`const path = [".config", "workspace"].join("-"); readFileSync(path, "utf8");`);
  assert.deepEqual(findings, [], "join of unrelated words that happen to include workspace should not be flagged");
});

test("GREENS on .tcrn mention without workspace fragment", () => {
  const findings = judgeSource(`const path = [".tcrn", "config"].join("-"); readFileSync(path, "utf8");`);
  assert.deepEqual(findings, [], "assembly that includes .tcrn but not workspace should not be flagged");
});

test("REDS on direct .tcrn-workspace reference with readFileSync", () => {
  const findings = judgeSource(`const data = readFileSync(".tcrn-workspace/partition/workspace/file.json", "utf8");`);
  assert.equal(findings.length, 1, "direct .tcrn-workspace reference with read must be flagged");
  assert.equal(findings[0].outsideReference, "platform-workspace-direct");
  assert.equal(findings[0].operation, "filesystem-read");
});

test("REDS on direct .tcrn-workspace reference with spawn", () => {
  const findings = judgeSource(`execSync("node .tcrn-workspace/agent/main.mjs");`);
  assert.equal(findings.length, 1, "direct .tcrn-workspace reference with spawn must be flagged");
  assert.equal(findings[0].outsideReference, "platform-workspace-direct");
  assert.equal(findings[0].operation, "process-spawn");
});

test("REDS on direct .tcrn-workspace reference with lstatSync", () => {
  const findings = judgeSource(`if (lstatSync(".tcrn-workspace/exists")) { }`);
  assert.equal(findings.length, 1, "direct .tcrn-workspace reference with lstatSync must be flagged");
  assert.equal(findings[0].outsideReference, "platform-workspace-direct");
});

test("GREENS on .tcrn reference without workspace (not the platform dir)", () => {
  const findings = judgeSource(`const conf = readFileSync(".tcrn/config.json", "utf8");`);
  assert.deepEqual(findings, [], ".tcrn without workspace suffix should not be flagged");
});

test("GREENS on .tcrn-cache or similar that has dash-workspace but not .tcrn-workspace", () => {
  const findings = judgeSource(`const cache = readFileSync(".project-workspace/cache.json", "utf8");`);
  assert.deepEqual(findings, [], "dash-workspace pattern that does not start with .tcrn should not be flagged");
});

test("REDS on home directory access via process.env.HOME with readFileSync", () => {
  const findings = judgeSource(`const conf = readFileSync(join(process.env.HOME, ".agents/config.json"), "utf8");`);
  assert.equal(findings.length, 1, "process.env.HOME reference with read must be flagged");
  assert.equal(findings[0].outsideReference, "home-environment-reference");
  assert.equal(findings[0].operation, "filesystem-read");
});

test("REDS on home directory access via $HOME shell variable with spawn", () => {
  const findings = judgeSource(`execSync("bash -c 'source $HOME/.bashrc'");`);
  assert.equal(findings.length, 1, "$HOME reference with spawn must be flagged");
  assert.equal(findings[0].outsideReference, "home-environment-reference");
});

test("REDS on home directory access via ~/ tilde expansion with existsSync", () => {
  const findings = judgeSource(`if (existsSync("~/config.json")) { }`);
  assert.equal(findings.length, 1, "~/ path reference with operation must be flagged");
  assert.equal(findings[0].outsideReference, "home-environment-reference");
});

test("REDS on process.env.HOME with readdir", () => {
  const findings = judgeSource(`const files = readdir(process.env.HOME, (err, items) => {});`);
  assert.equal(findings.length, 1, "process.env.HOME with readdir must be flagged");
  assert.equal(findings[0].outsideReference, "home-environment-reference");
});

test("GREENS on process.env.HOME mention without reaching operation", () => {
  const findings = judgeSource(`const home = process.env.HOME;`);
  assert.deepEqual(findings, [], "mention of process.env.HOME without file operation should not be flagged");
});

test("GREENS on HOME mentioned in a string but not accessed", () => {
  const findings = judgeSource(`const msg = "set HOME=..."; console.log(msg);`);
  assert.deepEqual(findings, [], "HOME in a string literal without operation should not be flagged");
});

test("GREENS on fixture-rooted path with sibling name (TCRN-CROSS-INC-274 exemption)", () => {
  // Paths rooted at fixture.home are synthetic test artifacts, not real reaches into siblings
  const findings = judgeSource(
    `const skillPath = join(fixture.home, ".agents", "skills", "tcrn-workflow-helper", "SKILL.md"); const content = readFileSync(skillPath, "utf8");`
  );
  assert.deepEqual(findings, [], "fixture-rooted path containing sibling name must not be flagged");
});

test("REDS on non-fixture-rooted path containing sibling name, even via tmpdir exemption", () => {
  // A path that reaches into a sibling directory must be flagged, regardless of route
  const findings = judgeSource(
    `const engineRoot = resolve("/opt/engine"); const path = resolve(engineRoot, "../tcrn-workflow-helper"); readFileSync(path, "utf8");`,
    ["TCRN-AOS", "tcrn-workflow-helper"]
  );
  assert.equal(findings.length, 1, "non-fixture-rooted path with sibling name must be flagged");
  assert.equal(findings[0].sibling, "tcrn-workflow-helper");
  assert.equal(findings[0].operation, "filesystem-read");
});

test("GREENS on tmpdir-rooted path (local fixture exemption)", () => {
  const findings = judgeSource(
    `const tmp = mkdtemp(join(tmpdir(), "test-")); const content = readFileSync(join(tmp, "file.json"), "utf8");`
  );
  assert.deepEqual(findings, [], "tmpdir-rooted path should not be flagged (local fixture)");
});

test("GREENS on mkdtemp-created path (local fixture exemption)", () => {
  const findings = judgeSource(
    `const testDir = mkdtemp("test-"); readFileSync(join(testDir, "config.json"), "utf8");`
  );
  assert.deepEqual(findings, [], "mkdtemp-rooted path should not be flagged (local fixture)");
});
