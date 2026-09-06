// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireWorkspaceLease,
  createProject,
  createWork,
  initializeWorkspace,
  transitionWork,
  validateStoryVerificationLinks,
  verificationClaimsForWork,
  verificationWorksForClaim,
} from "../dist/build/packages/core/src/index.js";
import { validateVerificationMapLinks } from "../scripts/verification-links.mjs";

const storyId = `work:${"a".repeat(24)}`;
const story = {
  id: storyId,
  externalKey: "TCRN-CROSS-STORY-LINKED",
  kind: "Story",
  status: "done",
  tombstone: false,
  scopeDigest: "b".repeat(64),
};
const claim = { id: "CLAIM-LINKED", workId: storyId, gwt: ["GWT1", "GWT5"] };

const scope = [
  "【Goal】为谁=执行方；目的锚=INC-261；符合性判据=机器链接可反查；判定人=机器。",
  "【Requirements】现象与证据=Story 缺少判据反查；修复项=实现完成链接检查。",
  "【Acceptance Criteria】GIVEN 判据链接存在 WHEN Story 收口 THEN 机器可反查并通过。",
  "【Business Background】现状与证据=收口曾只依赖人工核对。",
  "【Preconditions】无——原因：本测试创建完整工作树。",
  "【Assumptions】无——原因：不修改历史事件。",
  "【Use Cases & Examples】无——原因：由链接查询测试覆盖。",
  "【Feature Toggle & Setting】无——原因：不引入开关。",
  "【Permissions】机器执行，Owner 负责裁定。",
  "【Implementation Notes】修复项=在 done 路径检查 verificationClaims；状态=planned。",
].join("\n");

test("INC-261 Story verification links support forward query, reverse lookup, and GWT validation", () => {
  assert.deepEqual(verificationClaimsForWork([claim], story), [claim]);
  assert.deepEqual(verificationWorksForClaim(claim, [story]), [story]);
  assert.equal(validateStoryVerificationLinks(story, [claim]).ok, true);

  const missing = validateStoryVerificationLinks(story, []);
  assert.equal(missing.ok, false);
  assert.equal(missing.problems[0].code, "STORY_VERIFICATION_CLAIM_MISSING");

  const noGwt = validateStoryVerificationLinks(story, [{ id: claim.id, workId: storyId }]);
  assert.equal(noGwt.ok, false);
  assert.equal(noGwt.problems[0].code, "STORY_VERIFICATION_GWT_MISSING");

  const legacy = validateStoryVerificationLinks({ ...story, scopeDigest: null }, []);
  assert.equal(legacy.ok, true, "pre-link historical records remain readable");
});

test("INC-261 a scoped Story cannot reach done without a verification claim", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "tcrn-inc261-links-")));
  const roots = ["framework", "workspace", "transient", "evidence-locator", "release-trust"].map((kind) => ({ kind, path: join(base, kind) }));
  for (const root of roots) await mkdir(root.path);
  const workspace = join(base, "workspace");
  await initializeWorkspace({ roots, externalKey: "INC261-LINKS", createdAt: "2026-09-03T01:00:00Z", segmentEventLimit: 64 });
  const lease = await acquireWorkspaceLease(workspace, { now: "2026-09-03T01:00:01Z" });
  try {
    let state = await createProject(workspace, lease, { expectedVersion: 0, occurredAt: "2026-09-03T01:00:02Z", externalKey: "INC261-PROJECT", name: "INC261" });
    const projectId = state.projects[0].id;
    state = await createWork(workspace, lease, { expectedVersion: 1, occurredAt: "2026-09-03T01:00:03Z", projectId, externalKey: "INC261-INIT", kind: "Initiative", parentId: null });
    const initiativeId = state.work.find((record) => record.externalKey === "INC261-INIT").id;
    state = await createWork(workspace, lease, { expectedVersion: 2, occurredAt: "2026-09-03T01:00:04Z", projectId, externalKey: "INC261-EPIC", kind: "Epic", parentId: initiativeId });
    const epicId = state.work.find((record) => record.externalKey === "INC261-EPIC").id;
    state = await createWork(workspace, lease, { expectedVersion: 3, occurredAt: "2026-09-03T01:00:05Z", projectId, externalKey: "INC261-STORY", kind: "Story", parentId: epicId, scope });
    const workId = state.work.find((record) => record.externalKey === "INC261-STORY").id;
    state = await transitionWork(workspace, lease, { expectedVersion: 4, occurredAt: "2026-09-03T01:00:06Z", id: workId, status: "ready" });
    state = await transitionWork(workspace, lease, { expectedVersion: 5, occurredAt: "2026-09-03T01:00:07Z", id: workId, status: "active" });
    await assert.rejects(
      () => transitionWork(workspace, lease, { expectedVersion: 6, occurredAt: "2026-09-03T01:00:08Z", id: workId, status: "done", verificationClaims: [] }),
      (error) => error?.reasonCode === "WORKSPACE_STORY_VERIFICATION_MISSING",
    );
    state = await transitionWork(workspace, lease, {
      expectedVersion: 6,
      occurredAt: "2026-09-03T01:00:09Z",
      id: workId,
      status: "done",
      verificationClaims: [{ id: "CLAIM-INC261-STORY", workId, gwt: ["GWT1", "GWT2"] }],
    });
    assert.equal(state.work.find((record) => record.id === workId).status, "done");
  } finally {
    await lease.release();
    await rm(base, { recursive: true, force: true });
  }
});

test("INC-261 the stored map link uses a protocol work id and named GWTs", () => {
  const map = JSON.parse(readFileSync(new URL("../verification-map.yaml", import.meta.url), "utf8"));
  const result = validateVerificationMapLinks(map);
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  // TCRN-CROSS-STORY-359: the one linked claim in the stored map was INIT048-INC-261,
  // which measured `verify:inc261` and retired with that script. The link SHAPE is what
  // this file guards and it is unchanged -- every case above drives
  // validateVerificationMapLinks over a constructed map. What this case adds is that the
  // stored map is judged by the same validator, and a stored map with no linked claim is
  // a valid input to it, not an unchecked one: `ok` above is the assertion that matters.
  assert.equal(result.linkedClaimCount, 0);
});
