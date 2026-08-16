// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-INC-215 — the dependency-direction gate, both sides.
//
// A gate that has only ever been seen green proves nothing, so every red is exercised
// here against an injected shape. The three legitimate ways to name a sibling are
// exercised too: a gate that fires on a provenance citation gets muted within a week,
// and a muted gate is worth less than no gate, because it still looks like coverage.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

import {
  findReachingLines,
  judgeNoSiblingDependency,
  siblingProjects,
  REPO_ROOT,
} from "../scripts/no-sibling-dependency-proof.mjs";

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
  const result = judgeNoSiblingDependency();
  assert.deepEqual(result.findings, [], "INC-214 cleared these; a finding here is a regression");
  assert.equal(result.reasonCode, "NO_SIBLING_DEPENDENCY");
});

test("siblings are discovered, not typed", () => {
  // Built on a synthetic tree, not the real platform one. Asserting that `TCRN-AOS` is
  // discovered would make this suite fail wherever the siblings are absent — including
  // `pnpm preflight`, whose isolated clone is the one world that proves this repository
  // stands up without them. A test that needs a sibling present to pass is itself the
  // dependency this gate exists to forbid (TCRN-CROSS-INC-218).
  const root = mkdtempSync(join(tmpdir(), "tcrn-siblings-"));
  try {
    for (const name of ["Zeta-Product", "Alpha-Product", "docs", "var", "tmp", ".hidden", "self-repo"]) {
      mkdirSync(join(root, name));
    }
    writeFileSync(join(root, "loose-file.md"), "not a project\n");
    const discovered = siblingProjects(root, "self-repo");
    assert.deepEqual(discovered, ["Alpha-Product", "Zeta-Product"], "projects only, sorted so a diff is readable");
    assert.ok(!discovered.includes("self-repo"), "this repository is not its own sibling");
    assert.ok(!discovered.includes("docs"), "the shared docs directory is not a project");
    assert.ok(!discovered.includes(".hidden"), "dot directories are not projects");
    assert.ok(!discovered.includes("loose-file.md"), "a file is not a project");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("self is read off the checkout, not written down", () => {
  // The constant `"tcrn-workflow"` was only ever this checkout's directory name. Under
  // preflight the clone is called `checkout`, and the repository then discovered itself.
  const root = mkdtempSync(join(tmpdir(), "tcrn-siblings-"));
  try {
    mkdirSync(join(root, basename(REPO_ROOT)));
    mkdirSync(join(root, "Some-Product"));
    assert.deepEqual(siblingProjects(root), ["Some-Product"], "the default self excludes this checkout by its real name");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.ok(!siblingProjects().includes(basename(REPO_ROOT)), "and it holds against the real parent too");
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
