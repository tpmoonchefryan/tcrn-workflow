// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { COMMAND_CATALOG, runCli } from "../dist/build/packages/cli/src/index.js";
import { acquireWorkspaceLease, annotateWork, createProject, createWork, initializeWorkspace, transitionWork } from "../dist/build/packages/core/src/index.js";
import { validateStoryScope } from "../dist/build/packages/core/src/story-scope-compliance.js";
import { validateStoryScope as validateCloseoutStoryScope } from "../scripts/story-scope-compliance.mjs";

const headings = [
  "Goal",
  "Requirements",
  "Acceptance Criteria",
  "Business Background",
  "Preconditions",
  "Assumptions",
  "Use Cases & Examples",
  "Feature Toggle & Setting",
  "Permissions",
  "Implementation Notes",
];

function scope() {
  return [
    "【Goal】为谁改变什么=Owner 的 Story 交付；目的锚=STORY-209；符合性判据=门输出可复跑；判定人=Owner。",
    "【Requirements】现象与证据=命令可复跑；修复项=实现规则门。",
    "【Acceptance Criteria】GIVEN 十区块齐全 WHEN 运行规则门 THEN 返回绿；GIVEN 删除任一块 WHEN 运行规则门 THEN 返回红。",
    "【Business Background】证据=历史单据曾缺少机器约束。",
    "【Preconditions】无——原因：规则基线已冻结。",
    "【Assumptions】无——原因：不改变事件历史。",
    "【Use Cases & Examples】无——原因：示例由验收命令覆盖。",
    "【Feature Toggle & Setting】无——原因：禁止永久 bypass。",
    "【Permissions】Owner 负责判定，执行方只写代码与测试。",
    "【Implementation Notes】决策点及裁定状态=planned；修复项由实现记录，状态=planned。",
  ].join("\n");
}

describe("STORY-209 Story scope contract", () => {
  test("the ten blocks are exact, ordered, and parity-matched at closeout", () => {
    const compliant = validateStoryScope(scope());
    const closeout = validateCloseoutStoryScope(scope());
    assert.equal(compliant.ok, true, JSON.stringify(compliant.problems));
    assert.deepEqual(closeout, compliant);
    for (const heading of headings) {
      const missing = scope().split("\n").filter((line) => !line.startsWith(`【${heading}】`)).join("\n");
      const result = validateStoryScope(missing);
      assert.equal(result.ok, false, `${heading} deletion must be red`);
      assert.ok(result.problems.some((problem) => problem.code === "STORY_SCOPE_HEADING_MISSING" && problem.heading === heading));
    }
  });

  test("a duplicate heading and an empty section are red, while explicit no-reason text is green", () => {
    const duplicate = `${scope()}\n【Goal】重复标题必须红`;
    const duplicateResult = validateStoryScope(duplicate);
    assert.equal(duplicateResult.ok, false);
    assert.ok(duplicateResult.problems.some((problem) => problem.code === "STORY_SCOPE_HEADING_DUPLICATE" && problem.heading === "Goal"));
    const explicitNoReason = scope().replace("【Assumptions】无——原因：规则基线已冻结。", "【Assumptions】无——本 Story 不引入假设。");
    assert.equal(validateStoryScope(explicitNoReason).ok, true);
    const empty = scope().replace("【Permissions】Owner 负责判定，执行方只写代码与测试。", "【Permissions】");
    assert.equal(validateStoryScope(empty).ok, false);
    assert.ok(validateStoryScope(empty).problems.some((problem) => problem.code === "STORY_SCOPE_SECTION_EMPTY" && problem.heading === "Permissions"));
  });

  test("each purpose anchor and each legacy element remains independently enforceable", () => {
    for (const anchor of ["为谁", "目的锚", "符合性判据", "判定人"]) {
      const result = validateStoryScope(scope().replace(new RegExp(`${anchor}[^；。]*[；。]`, "u"), ""));
      assert.equal(result.ok, false, `${anchor} must be required`);
      assert.ok(result.problems.some((problem) => problem.code === "STORY_SCOPE_PURPOSE_INVALID"), anchor);
    }
    const legacyCases = [
      [scope().replace(/现象与证据=命令可复跑；/u, "").replace(/证据=历史单据曾缺少机器约束。/u, ""), "legacy evidence"],
      [scope().replace(/修复项=实现规则门。/u, "").replace(/修复项由实现记录，/u, ""), "legacy fix"],
      [scope().replace(/GIVEN[^；。]*[；。]/gu, ""), "legacy acceptance"],
      [scope().replace(/判定人=Owner。/u, "").replace(/Owner/gu, "").replace(/(?:决策点及裁定|)状态=planned[；。]/gu, ""), "legacy decision"],
    ];
    for (const [candidate, label] of legacyCases) {
      const result = validateStoryScope(candidate);
      assert.equal(result.ok, false, label);
      assert.ok(result.problems.some((problem) => ["STORY_SCOPE_LEGACY_ELEMENT_MISSING", "STORY_SCOPE_ACCEPTANCE_INVALID", "STORY_SCOPE_SECTION_EMPTY"].includes(problem.code)), label);
    }
  });

  test("the catalog exposes the atomic Story scope path", () => {
    const create = COMMAND_CATALOG.find((entry) => entry.name === "work-create");
    assert.ok(create);
    assert.deepEqual(create.flags.filter((flag) => ["scope", "decided-by"].includes(flag.name)), [
      { name: "scope", required: false, valueKind: "string" },
      { name: "decided-by", required: false, valueKind: "list" },
    ]);
  });

  test("the CLI cannot create a Story without an atomic scope", async () => {
    const { mkdtemp, mkdir, realpath, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-story-scope-cli-")));
    try {
      const roots = [];
      for (const kind of ["framework", "workspace", "transient", "evidence-locator", "release-trust"]) {
        const path = join(base, kind);
        await mkdir(path);
        roots.push({ kind, path });
      }
      const workspace = join(base, "workspace");
      await initializeWorkspace({ roots, externalKey: "FIXTURE-STORY-SCOPE-CLI", createdAt: "2026-08-09T00:00:00Z", segmentEventLimit: 64 });
      let lease = await acquireWorkspaceLease(workspace, { now: "2026-08-09T00:00:01Z" });
      let projectId;
      let epicId;
      try {
        let state = await createProject(workspace, lease, { expectedVersion: 0, occurredAt: "2026-08-09T00:00:02Z", externalKey: "PROJECT-STORY-SCOPE", name: "Story scope" });
        projectId = state.projects[0].id;
        state = await createWork(workspace, lease, { expectedVersion: 1, occurredAt: "2026-08-09T00:00:03Z", projectId, externalKey: "INIT-STORY-SCOPE", kind: "Initiative", parentId: null });
        const initiativeId = state.work.find((record) => record.externalKey === "INIT-STORY-SCOPE").id;
        state = await createWork(workspace, lease, { expectedVersion: 2, occurredAt: "2026-08-09T00:00:04Z", projectId, externalKey: "EPIC-STORY-SCOPE", kind: "Epic", parentId: initiativeId });
        epicId = state.work.find((record) => record.externalKey === "EPIC-STORY-SCOPE").id;
      } finally {
        await lease.release();
      }
      await assert.rejects(
        () => runCli(["work-create", "--workspace", workspace, "--expected-version", "3", "--at", "2026-08-09T00:00:05Z", "--project-id", projectId, "--external-key", "STORY-NO-SCOPE", "--kind", "Story", "--parent-id", epicId], { write() {} }),
        (error) => error?.reasonCode === "WORKSPACE_STORY_SCOPE_REQUIRED",
      );

      lease = await acquireWorkspaceLease(workspace, { now: "2026-08-09T00:00:06Z" });
      let state = await createWork(workspace, lease, {
        expectedVersion: 3,
        occurredAt: "2026-08-09T00:00:07Z",
        projectId,
        externalKey: "STORY-OWNER-ACCEPTANCE",
        kind: "Story",
        parentId: epicId,
        scope: scope(),
      });
      const storyId = state.work.find((record) => record.externalKey === "STORY-OWNER-ACCEPTANCE").id;
      await lease.release();

      lease = await acquireWorkspaceLease(workspace, { now: "2026-08-09T00:00:08Z" });
      state = await transitionWork(workspace, lease, { expectedVersion: 4, occurredAt: "2026-08-09T00:00:09Z", id: storyId, status: "ready" });
      await lease.release();
      lease = await acquireWorkspaceLease(workspace, { now: "2026-08-09T00:00:10Z" });
      state = await transitionWork(workspace, lease, { expectedVersion: 5, occurredAt: "2026-08-09T00:00:11Z", id: storyId, status: "active" });
      await lease.release();
      lease = await acquireWorkspaceLease(workspace, { now: "2026-08-09T00:00:12Z" });
      await assert.rejects(
        () => transitionWork(workspace, lease, { expectedVersion: 6, occurredAt: "2026-08-09T00:00:13Z", id: storyId, status: "done" }),
        (error) => error?.reasonCode === "WORKSPACE_OWNER_ACCEPTANCE_REQUIRED",
      );
      state = await annotateWork(workspace, lease, {
        expectedVersion: 6,
        occurredAt: "2026-08-09T00:00:14Z",
        id: storyId,
        decidedBy: ["minutes:" + "a".repeat(24)],
      });
      state = await transitionWork(workspace, lease, { expectedVersion: 7, occurredAt: "2026-08-09T00:00:15Z", id: storyId, status: "done" });
      assert.equal(state.work.find((record) => record.id === storyId).status, "done");
      await lease.release();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
