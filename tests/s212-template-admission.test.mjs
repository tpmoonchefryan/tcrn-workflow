// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../dist/build/packages/cli/src/index.js";
import { BUILTIN_TEMPLATES, initializeWorkspace } from "../dist/build/packages/core/src/index.js";
import { canonicalJson } from "../dist/build/packages/protocol/src/index.js";

const instant = (second) => `2026-08-11T00:00:${String(second).padStart(2, "0")}Z`;

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-s212-")));
  const roots = [];
  for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
    const path = join(base, kind);
    await mkdir(path);
    roots.push({ kind, path });
  }
  const workspace = join(base, "workspace");
  const state = await initializeWorkspace({ roots, externalKey: "S212-SCRATCH", createdAt: instant(0), segmentEventLimit: 2 });
  return { base, workspace, state, async close() { await rm(base, { recursive: true, force: true }); } };
}

async function invoke(args) {
  let output = "";
  try {
    await runCli(args, { write: (value) => { output += value; } });
    return { ok: true, output, value: output.length === 0 ? null : JSON.parse(output) };
  } catch (error) {
    return { ok: false, output, reasonCode: error?.reasonCode, error: String(error?.message ?? error) };
  }
}

const defectScope = (credentials = "ref:vault/s212-credentials") => [
  `【URI】为谁=模板作者与读链者;目的锚=S212;符合性判据=实例可复跑;判定人=Owner。`,
  "【Preconditions】证据=测试工作区已初始化。",
  "【Steps to Reproduce】命令=template-admit 后创建 Incident。",
  "【Actual】现象与证据=模板绑定可回读;实现=引擎校验。",
  "【Expected】GIVEN 模板已准入 WHEN 创建绑定记录 THEN 通过。",
  `【Credentials 引用】${credentials}`,
  "【Attachments 引用】attachment:s212-evidence",
].join("\n");

const legacyStoryScope = [
  "【Goal】为谁=旧记录读链者;目的锚=STORY-105;符合性判据=validate 通过;判定人=Owner。",
  "【Requirements】现象与证据=前纪元记录;修复项=保留兼容。",
  "【Acceptance Criteria】GIVEN 旧记录 WHEN validate THEN 通过。",
  "【Business Background】证据=历史链。",
  "【Preconditions】无——原因：历史记录。",
  "【Assumptions】无——原因：不改变协议。",
  "【Use Cases & Examples】无——原因：前纪元。",
  "【Feature Toggle & Setting】无——原因：无开关。",
  "【Permissions】Owner。",
  "【Implementation Notes】决策与状态=planned。",
].join("\n");

test("S212: admitted template binds work, red legs stay fail-closed, and pre-era Story remains valid", async () => {
  const fx = await fixture();
  try {
    const project = await invoke([
      "project-create", "--workspace", fx.workspace, "--expected-version", "0", "--at", instant(1),
      "--external-key", "S212-PROJECT", "--name", "S212 scratch",
    ]);
    assert.equal(project.ok, true, JSON.stringify(project));
    const template = BUILTIN_TEMPLATES.find((entry) => entry.id === "inc.defect.v1");
    assert.ok(template);
    const templatePath = join(fx.base, "inc-defect.template.json");
    await writeFile(templatePath, canonicalJson(template), "utf8");

    const validated = await invoke(["template-validate", "--template", templatePath]);
    assert.equal(validated.ok, true, JSON.stringify(validated));
    assert.equal(validated.value.reasonCode, "TEMPLATE_VALIDATED");

    const admitted = await invoke([
      "template-admit", "--workspace", fx.workspace, "--expected-version", "head", "--at", instant(2),
      "--template", templatePath, "--owner", "owner:s212", "--actor", "agent:codex",
    ]);
    assert.equal(admitted.ok, true, JSON.stringify(admitted));
    assert.equal(admitted.value.reasonCode, "TEMPLATE_ADMISSION_COMMITTED");
    const receiptJson = JSON.stringify(admitted.value.receipt);

    const initiative = await invoke([
      "work-create", "--workspace", fx.workspace, "--expected-version", "head", "--at", instant(3),
      "--project-id", project.value.record.id, "--external-key", "S212-LEGACY-INITIATIVE", "--kind", "Initiative",
    ]);
    assert.equal(initiative.ok, true, JSON.stringify(initiative));
    const epic = await invoke([
      "work-create", "--workspace", fx.workspace, "--expected-version", "head", "--at", instant(4),
      "--project-id", project.value.record.id, "--external-key", "S212-LEGACY-EPIC", "--kind", "Epic", "--parent-id", initiative.value.record.id,
    ]);
    assert.equal(epic.ok, true, JSON.stringify(epic));

    const bound = await invoke([
      "work-create", "--workspace", fx.workspace, "--expected-version", "head", "--at", instant(5),
      "--project-id", project.value.record.id, "--external-key", "S212-BOUND-INCIDENT", "--kind", "Incident",
      "--scope", defectScope(), "--template-receipt", receiptJson,
    ]);
    assert.equal(bound.ok, true, JSON.stringify(bound));
    assert.equal(bound.value.record.templateBinding.registrationId, "template:inc.defect.v1-1");
    assert.deepEqual(bound.value.record.templateBinding.binding, {
      schemaVersion: "tcrn.template-binding.v1",
      templateId: "inc.defect.v1",
      templateVersion: 1,
      templateDigest: admitted.value.receipt.templateDigest,
      receiptDigest: admitted.value.receipt.receiptDigest,
    });

    const shown = await invoke(["work-show", "--workspace", fx.workspace, "--id", bound.value.record.id]);
    assert.equal(shown.ok, true, JSON.stringify(shown));
    assert.equal(shown.value.record.templateBinding.registrationId, "template:inc.defect.v1-1");

    const missingSteps = await invoke([
      "work-create", "--workspace", fx.workspace, "--expected-version", "head", "--at", instant(4),
      "--project-id", project.value.record.id, "--external-key", "S212-MISSING-STEPS", "--kind", "Incident",
      "--scope", defectScope().split("\n").filter((line) => !line.startsWith("【Steps to Reproduce】")).join("\n"),
      "--template-receipt", receiptJson,
    ]);
    assert.equal(missingSteps.ok, false);
    assert.equal(missingSteps.reasonCode, "TEMPLATE_SCOPE_INVALID", JSON.stringify(missingSteps));

    const plaintextCredentials = await invoke([
      "work-create", "--workspace", fx.workspace, "--expected-version", "head", "--at", instant(5),
      "--project-id", project.value.record.id, "--external-key", "S212-PLAINTEXT-CREDENTIALS", "--kind", "Incident",
      "--scope", defectScope("password=not-a-reference"), "--template-receipt", receiptJson,
    ]);
    assert.equal(plaintextCredentials.ok, false);
    assert.equal(plaintextCredentials.reasonCode, "TEMPLATE_SCOPE_INVALID", JSON.stringify(plaintextCredentials));

    const legacy = await invoke([
      "work-create", "--workspace", fx.workspace, "--expected-version", "head", "--at", instant(6),
      "--project-id", project.value.record.id, "--external-key", "STORY-105", "--kind", "Story", "--parent-id", epic.value.record.id, "--scope", legacyStoryScope,
    ]);
    assert.equal(legacy.ok, true, JSON.stringify(legacy));
    assert.equal(legacy.value.record.templateBinding, undefined);

    const validatedWorkspace = await invoke(["validate", "--workspace", fx.workspace]);
    assert.equal(validatedWorkspace.ok, true, JSON.stringify(validatedWorkspace));
  } finally {
    await fx.close();
  }
});

test("S212: command catalog exposes the template admission verb family", async () => {
  const result = await invoke(["commands"]);
  assert.equal(result.ok, true, JSON.stringify(result));
  const names = result.value.commands.map((entry) => entry.name);
  assert.equal(names.includes("template-admit"), true);
  assert.equal(names.includes("template-validate"), true);
});
