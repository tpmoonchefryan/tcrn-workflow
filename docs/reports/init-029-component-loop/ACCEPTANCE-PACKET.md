> 已脱敏，非逐字；原件见平台档案 `init-032-review-remediation/original/ACCEPTANCE-PACKET.md`。

# INIT-029 component loop acceptance packet

本包对应 cross-project v3383 → 最终读回 v3399。执行顺序为 S252 → S253 → S254 → S255；本地实现、证据和质量门已完成，Owner acceptance 仍未完成。

## 链读回

引擎工作树：`<platform-root>/.tcrn-workspace/cross-project/workspace`；engine `0.11.15`；workspaceId `workspace:7732a51de4c38afb83bb77cf`。

最终 `status`：

```json
{
  "version": 3399,
  "headEventHash": "8b8d417f5fad30e12ec4b87588779c41877a31d89d57b6c69c8f700ecb63fde8",
  "engineVersion": "0.11.15"
}
```

| work | external key | final revision | final status |
| --- | --- | ---: | --- |
| `work:ccd96e8d419f96b26292dfdf` | `TCRN-CROSS-STORY-252` | 5 | `pending-owner-acceptance` |
| `work:fc510fde13df9af6d4033867` | `TCRN-CROSS-STORY-253` | 5 | `pending-owner-acceptance` |
| `work:a294b0ad44aa7de5bac92e75` | `TCRN-CROSS-STORY-254` | 5 | `pending-owner-acceptance` |
| `work:52947b140be11011e3b34715` | `TCRN-CROSS-STORY-255` | 5 | `pending-owner-acceptance` |

EPIC-082 (`work:2005f19c395258ff67f93ade`) 与 EPIC-083 (`work:39371a357b7bc2ac93dfba6e`) 保持 `planned`；本批没有把 Epic 或任何 Story 推到 `done`。四张 Story 均以 `agent:codex`、新鲜 numeric CAS、工作树引擎、attest-dir 和 readback 完成 transition/annotation。

## 证据包

- [S252 DS CSS snapshot evidence](./evidence/STORY-252-ds-css-snapshot.md)
- [S253 class alignment evidence](./evidence/STORY-253-class-alignment.md)
- S254 DS component return evidence: `TCRN-Design-System` repository, `docs/reports/init-029-component-loop/evidence/STORY-254-component-return.md`
- [S255 portal consumption evidence](./evidence/STORY-255-portal-consumption.md)
- [S255 dashboard browser capture](./evidence/STORY-255-portal-dashboard.png)
- [S255 settings browser capture](./evidence/STORY-255-portal-settings.png)

S255 最终快照为 98206 UTF-8 bytes，SHA256 `4fb41b272bb969bfcd7aebe0129c261a9a944abf41ba2fda39fa920bcbc62a15`。门户域 style-root 由 S253 proof 读回 `71 → 66 → 51`；八个回流根类均有执行 DOM 证据。强化门的 mutation red leg 记录在 S255 evidence：删除 `.tcrn-switch` 的快照 CSS 根后，执行 DOM 门实际缺失 `tcrn-switch`，退出码 1；恢复后绿。

## 最终质量门

Workflow 仓：

- `pnpm test`：最终 receipt `TESTS_VERIFIED`，全仓 1085 tests、0 fail。
- `pnpm portal:test`：21 tests、21 pass、0 fail；UI presence 使用执行 DOM 查询，不是 API 或静态字符串门。
- `pnpm verify:portal`：`PORTAL_VERIFY_TRAIN_GREEN`，9 个命令顺序执行，`unverified=[]`。
- `pnpm portal:proof`：`DESIGN_SYSTEM_COMPLIANT`；design 四腿全绿（含 no-inline-style-attributes 与 interactive-tcrn-class-coverage）；i18n `190 × 5 = 950` strings 全绿；dependency audit `NO_INTERNAL_IMPORTS`。
- `node scripts/ds-component-css-reconcile.mjs`：source/ snapshot/ inline 三方一致，`DS_COMPONENT_CSS_RECONCILED`。
- `node scripts/ds-component-css-proof.mjs`：源漂移、inline 漂移两腿红；source absent 仅 `SNAPSHOT_SELF_SUFFICIENT`、`sourceStatus=unverified`、`countedAsGreen=false`；恢复绿。
- coverage conservation：baseline completeness `93/93`，无 missing/stale；新增 UI 断言未造成测试/断言丢失。
- verbatim evidence：`EVIDENCE_VERBATIM_VERIFIED`，6 个既有逐字证据块通过；S255 证据使用执行 DOM/计算样式记录，不把字符串包含写成 UI 证明。

DS 仓：

- `pnpm verify`：exit code 0；typecheck/build/dist hygiene/test/tokens/exports/pack/storybook/readme/public-output/internal-vocab/scan/scaffold/internal-alpha 全列车通过。
- DS `@tcrn/ui-react` SSR：62/62；DOM：10/10。
- API manifest：109/109，missing 0、extraction errors 0；CSS template integrity：475 rules、findings 0。
- internal-alpha browser receipt：`storyCount=55`、`viewportCount=3`、`screenshotCount=265`、`axeViolationCount=0`、`visualSignatureRegressions=0`、`browserProofSummaryOk=true`、`storyCoverageManifestOk=true`、`storyHeightBudgetOk=true`、`localeLeakZhCnNewLeaks=0`。

## 验收边界

- `done` 只由 Owner 接受后产生；当前四单全部停在 `pending-owner-acceptance`。
- Owner 待裁：S254 `ModifiedIndicator` 是否继续并入 `SettingRow`，还是拆为第九个公开构件；S255 不自行决定。
- Owner 待裁：DS 回流后的视觉变化是否接受；本包提供 Storybook DOM、门户执行 DOM、computed style 和实际截图，不冒充视觉验收。
- Owner 待裁：Rules 目录、`meta`、`search-results`、`brand` 等语义是否需要新的 DS 构件；沿用 S253 处置表，不硬映射。
- DS sibling 缺失时快照可以自足启动，但源对账仍是 `unverified`，不计绿。
- `0.11.15` 发版、helper c40 重钉、两仓 push/tag/deploy 全部停放；平台根 0 字节 `AGENTS.md` 未写入。
