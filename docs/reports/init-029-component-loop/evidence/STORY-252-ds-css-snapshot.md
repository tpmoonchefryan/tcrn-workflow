> 已脱敏，非逐字；原件见平台档案 `init-032-review-remediation/original/STORY-252-ds-css-snapshot.md`。

# STORY-252 DS CSS 快照内联与六同名根去重证据

状态目标：`pending-owner-acceptance`；Owner 仍是唯一 `done` 判定者。

## 交付

- `scripts/generate-ds-component-css-snapshot.mjs` 从相邻 DS 仓
  `packages/ui-react/src/components/Navigation/Navigation.tsx` 的
  `tcrnComponentCss` 导出生成签入文件
  `portal/ds-component-css.snapshot.css`。
- `portal/index.html` 在 `/tokens.css` 后以内联
  `<style id="tcrn-ds-component-css" data-source="snapshot">` 消费快照；门户运行期没有
  DS import、包解析或 sibling-repository 依赖。
- 门户自有第二个 style 块不再定义六个共享根的重复基线：
  `tcrn-button`、`tcrn-field`、`tcrn-input`、`tcrn-select`、`tcrn-textarea`、
  `tcrn-sr-only`。领域修饰类和布局骨架仍留在门户，六根的基线由快照提供。
- `scripts/ds-component-css-reconcile.mjs` 做快照/内联与 DS 源的字节级对账；
  `scripts/ds-component-css-proof.mjs` 对源字节、快照字节和 DS 源缺失三种变异逐一取证。

## 数字与对账读回

平台上持有两仓源时的 `node scripts/ds-component-css-reconcile.mjs` 输出摘要如下，数字直接来自命令输出：

```json
{"ok":true,"reasonCode":"DS_COMPONENT_CSS_RECONCILED","snapshot":{"path":"portal/ds-component-css.snapshot.css","bytes":88370,"sha256":"a777a39db89e59e69ab9b48c2ff461404fe0768ac94af702647d4578bb9a9cb8"},"inline":{"path":"portal/index.html","marker":"<style id=\"tcrn-ds-component-css\" data-source=\"snapshot\">","bytes":88370,"sha256":"a777a39db89e59e69ab9b48c2ff461404fe0768ac94af702647d4578bb9a9cb8","matchesSnapshot":true},"reconciliation":{"source":"../TCRN-Design-System/packages/ui-react/src/components/Navigation/Navigation.tsx","sourceStatus":"verified","sourceBytes":88370,"sourceSha256":"a777a39db89e59e69ab9b48c2ff461404fe0768ac94af702647d4578bb9a9cb8","sourceMatchesSnapshot":true,"countedAsGreen":true}}
```

无 DS sibling 的 CI leg 不是假绿：`DS_COMPONENT_CSS_SNAPSHOT_SELF_SUFFICIENT` 仅表示快照可独立启动，
对账报告的 `sourceStatus` 是 `unverified` 且 `countedAsGreen` 是 `false`；它没有被标为 `skipped`。

## UI / 前后对照

`node --test portal/tests/ui-presence.test.mjs` 的执行 DOM 门通过 5/5。门直接读取执行后的 DOM，确认内联
快照节点存在，并确认六个真实 class root 均有渲染节点；它不是 API 返回值或静态 `innerHTML` 包含判定。
`node portal/scripts/design-proof.mjs` 的四腿也通过：token-fidelity、no-literal-colours、
no-inline-style-attributes、interactive-tcrn-class-coverage。

静态页在同一 1440×1000 viewport、JS disabled、同一 `tokens.css` 下的前后渲染：

| | 改动前 | 改动后 |
| --- | --- | --- |
| 视觉基线 | 门户自写 `.tcrn-button` 的 32px 基线、较轻字重与旧 hover；表单根由门户 style 块定义 | 六根由签入 DS 快照提供；按钮、焦点/交互反馈与表单基线切换到 DS CSS |
| 取证文件 | 未入库 | 未入库 |

> 取证截图 `STORY-252-before.png` / `STORY-252-after.png` 在本仓从未存在。表格原先以图片链接形式引用它们，读起来像是证据已保留。发现于 `TCRN-CROSS-INC-232` 新增的链接门首跑；同批 STORY-255 的两张截图确实在册，所以这不是整类证据的约定，是这一条漏了归档。此处记录缺失而非移除引用。

截图是本地静态渲染的前后对照，不冒充 Owner 的视觉接受；视觉差异的接受度仍归 Owner 裁定。

## 变异门逐字输出

复核命令=`node scripts/ds-component-css-proof.mjs`

```verbatim:node scripts/ds-component-css-proof.mjs
{
  "schemaVersion": "tcrn.inc252-ds-component-css-meta-proof.v1",
  "cases": [
    {
      "name": "baseline source and inline snapshot",
      "exitCode": 0,
      "reasonCode": "DS_COMPONENT_CSS_RECONCILED",
      "sourceStatus": "verified",
      "sourceReconciled": true
    },
    {
      "name": "mutated DS source byte",
      "exitCode": 0,
      "reasonCode": "DS_COMPONENT_CSS_INLINE_RECONCILED",
      "sourceMatchesSnapshot": false,
      "sourceReconciled": false,
      "observedReasonCodes": [
        "DS_COMPONENT_CSS_SOURCE_DRIFT"
      ]
    },
    {
      "name": "mutated snapshot byte",
      "exitCode": 1,
      "reasonCode": "DS_COMPONENT_CSS_INLINE_DRIFT",
      "sourceMatchesSnapshot": false,
      "inlineMatchesSnapshot": false
    },
    {
      "name": "DS source absent in CI",
      "exitCode": 0,
      "reasonCode": "DS_COMPONENT_CSS_SNAPSHOT_SELF_SUFFICIENT",
      "sourceStatus": "unverified",
      "sourceReconciled": false
    },
    {
      "name": "restore all mutations",
      "exitCode": 0,
      "reasonCode": "DS_COMPONENT_CSS_RECONCILED",
      "sourceStatus": "verified",
      "sourceReconciled": true
    }
  ]
}
```

## 边界

- 未证——归 Owner：截图所示视觉变化是否符合门户验收预期；本单只交付可复核的本地前后对照。
- `0.11.15` 发版、helper c40 重钉、两仓 push/tag/deploy 均停放。
