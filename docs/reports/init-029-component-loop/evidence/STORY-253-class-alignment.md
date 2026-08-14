# STORY-253 门户类名对齐与处置表证据

状态目标：`pending-owner-acceptance`；`done` 仍只属于 Owner。

## 交付范围

门户把可证明同义的根类换成 DS 公开类名；语义不合的类保留在门户域，并把
理由写入处置表。`data-ui` 行为契约没有改动。静态和动态渲染都落在同一套
类名上，执行 DOM 门直接查询最终 DOM，而不是读取 API、静态 `innerHTML` 或
字符串包含。

## 处置表

| 门户候选 | 处置 | 实现指认 | 理由 / 收口边界 |
| --- | --- | --- | --- |
| `topbar` | 改名 | `header.tcrn-top-bar`、`.tcrn-top-bar__brand/module/actions` | 与 DS TopBar 族同名且结构已对齐。 |
| `drawer` | 改名 | `#receipt-drawer.tcrn-detail-drawer`、`.tcrn-detail-drawer__head` | 收据侧栏就是 detail drawer；保留 `data-ui="receipt-drawer"`。 |
| `confirm-popover` | 改名 | `#persona-delete-confirm.tcrn-confirm-dialog`、`.tcrn-confirm-dialog__actions` | 删除确认是确认对话框，不是普通浮层。 |
| `chip` / 状态变体 | 改名 | `#receipt-chip`、`#health-chip`、审计结果均为 `tcrn-badge` + `--positive/--danger/--warning` | DS Badge 的状态变体与门户状态语义一致。 |
| `tabs` / `tab` | 改名 | `[data-ui="workspace-tabs"].tcrn-section-tabs`、`[data-ui="entity-tabs"].tcrn-section-tabs` | 选中态由 `data-selected` 与既有 `aria-selected` 同步；`data-ui` 不变。 |
| `segmented` | 改名 | 设置枚举控制动态渲染为 `.tcrn-segmented-nav`，按钮写 `data-selected` | DS SegmentedNav 的按钮选中语法可直接承载这个枚举控制。 |
| `nav` / `nav-item` | 改名 | 外层 `.tcrn-side-nav`，按钮 `.tcrn-nav-item`、`__content`、`__label` | 门户导航与 DS SideNav/NavItem 结构一致。 |
| `shell` | 改名 | `.tcrn-product-shell`、`__sidebar`、`__workspace`、`__main` | 外壳已改成 DS ProductShell 族；状态栏仍在门户 app 行中。 |
| `card` | 改名 | 统计卡、页面面板和模型计划均使用 `.tcrn-surface`、`__head`、`__note` | 这些面板都是 surface，不再维护门户独有 card 基线。 |
| `empty` | 改名 | 空内容分支统一输出 `.tcrn-state-surface` | 空态是反馈状态面，不是普通容器。 |
| `key` / `mono` | 改名 | 设置键、模型值、复核 finding 值与 persona model 值使用 `.tcrn-machine-token--compact` + `__value` | 机器可读值对齐 DS MachineToken；不把人类说明文字机器化。 |
| `audit` | 改名 | `#dashboard-audit`、`#drawer-audit` 为 `.tcrn-work-activity-feed`，条目为 `__item/time/summary` | 会话写入记录是 activity feed；状态徽章仍是 Badge。 |
| `receipt` | 改名 | `#receipt-body.tcrn-readback-panel`，行使用 `__row/__key/__value` | 引擎读回面板与 DS ReadbackPanel 语义一致。 |
| `entity-detail` | 改名 | `#persona-detail.tcrn-detail-inspector`，内部使用 `__head/actions/identity` | persona 详情是 inspector，不是泛化 detail 容器。 |
| `directory` | 暂按候选改名 | `#prose-directory.tcrn-knowledge-toc-rail`；门户的 `tcrn-directory__item` 子项仍保留 | 根 rail 的布局可消费 DS 语法；“Rules 标题目录是否属于 Knowledge TOC”是 Owner 待裁，未把子项硬套成知识结果。 |
| `meta` | 保留 | `.tcrn-meta` 出现在 ID、说明和来源 caption | 它是 caption utility；DS MetadataRail 是结构化元数据区域，语义不同。 |
| `highlight` | 保留 | `.tcrn-highlight` 用于全局搜索命中的设置行 | 这是行级注意 ring；DS HighlightMark 是行内文字标记，不能硬套。 |
| `manage` / `subnav` | 保留 | `.tcrn-manage`、`.tcrn-subnav` 用于 Settings/Vocabulary 分类导航 | DS WorkManagementSubnav 面向工作项导航；本处是门户配置分类，语义不同。 |
| `search-results` / `search-result` | 保留 | `#search-results`、`.tcrn-search-result` 服务全局 settings/persona/vocabulary command search | DS KnowledgeSearchResults 面向知识库结果，不能把全局命令搜索伪装成知识搜索。 |
| `brand` | 保留 | `.tcrn-brand` 是点击导航的文字 wordmark button | DS BrandMark 是图形品牌标记；当前没有可等价替换的图形资产。 |
| `list` | 保留 | `.tcrn-list` / `__row` 用于设置、健康检查、persona 列表 | 通用门户列表与 DS WorkList 的工作项行语义不同，保留通用域名。 |
| `switch` | 回流后消费 | `.tcrn-switch` + `.tcrn-switch__control` 包住 Boolean `role="switch"` input | DS `tcrn-product-switcher` 仍是产品切换器；S254 回流提供了正确的布尔开关语义。 |
| `stat` | 回流后消费 | 四个统计卡使用 `.tcrn-stat-card` + `__label/__value/__note` | S254 的 StatCard 已注册，门户删除 `.tcrn-stat` 自写样式。 |
| `statusbar` | 回流后消费 | app 尾部改为 `.tcrn-app-status-bar` + `__command/__state/__action` | AppStatusBar 的状态槽与 receipt action 可直接承载原有职责。 |
| `ghost` | 回流后消费 | factory value 使用 `.tcrn-field-provenance` + `__value/__source/__action` | FieldProvenance 保留 ghost/恢复语义；`data-ui` 仍指向同一行为节点。 |
| `term` / vocabulary rows | 回流后消费 | 术语列表使用 `<dl class="tcrn-definition-list">` 与 `__term/__definition` | DefinitionList 的术语表语义与 vocabulary rows 一致，删除 `.tcrn-term` 自写基线。 |
| `setting-row` | 回流后消费 | `.tcrn-setting-row` + `__key/__name/__description/__control/__tools/__modified/__reset` | S254 SettingRow 的修改点、重置和 control 槽承载原有三列行为。 |
| `editor` | 回流后消费 | `.tcrn-line-numbered-editor` + `__gutter/__control/__findings`，`.tcrn-editor-shell` 仅保留布局骨架 | LineNumberedEditor 已接管行号、warning 标记与滚动同步；门户只保留页面编排。 |
| `lock-hint` | 回流后消费 | `.tcrn-lock-hint` + `__icon/__text`，`data-ui="persona-name-lock"` 不变 | LockHint 已接管不可更改提示的视觉结构，行为契约不变。 |

## 根类收敛数字

复核脚本的 metric 是“门户自有第二个 style 块中的 unique class-root token”，排除
BEM `__` 部件与 `--` 修饰符；不是 DS 快照里的 101 根类计数。S253 原交付阶段为
62；S255 继续消费八个回流根类后，本次收口复核为 51：

```verbatim:node scripts/s253-class-alignment-proof.mjs
{
  "schemaVersion": "tcrn.inc253-class-alignment-proof.v1",
  "metric": "unique portal-owned CSS class-root tokens; BEM parts and modifiers excluded",
  "rootCounts": {
    "handoverBaseline": 71,
    "afterS252SnapshotDeduplication": 66,
    "afterS253Alignment": 51
  },
  "s252RemovedSharedRoots": [
    "tcrn-button",
    "tcrn-field",
    "tcrn-input",
    "tcrn-sr-only",
    "tcrn-textarea"
  ],
  "s253RemovedAliases": [
    "tcrn-audit",
    "tcrn-card",
    "tcrn-chip",
    "tcrn-confirm-popover",
    "tcrn-drawer",
    "tcrn-editor-wrap",
    "tcrn-empty",
    "tcrn-entity-detail",
    "tcrn-ghost",
    "tcrn-key",
    "tcrn-lock-hint",
    "tcrn-modified-dot",
    "tcrn-mono",
    "tcrn-nav",
    "tcrn-prose-findings",
    "tcrn-receipt",
    "tcrn-segmented",
    "tcrn-setting-reset",
    "tcrn-setting-row",
    "tcrn-shell",
    "tcrn-stat",
    "tcrn-statusbar",
    "tcrn-switch",
    "tcrn-tab",
    "tcrn-tabs",
    "tcrn-term",
    "tcrn-topbar"
  ],
  "s253AddedDsRoots": [
    "tcrn-confirm-dialog",
    "tcrn-detail-drawer",
    "tcrn-detail-inspector",
    "tcrn-machine-token",
    "tcrn-nav-item",
    "tcrn-product-shell",
    "tcrn-readback-panel",
    "tcrn-section-tabs",
    "tcrn-side-nav",
    "tcrn-surface",
    "tcrn-top-bar",
    "tcrn-work-activity-feed"
  ]
}
```

## DOM 门与变异

`node --test portal/tests/ui-presence.test.mjs`：5 tests、5 pass；门实际执行门户
脚本后查询 `header.tcrn-top-bar`、`.tcrn-product-shell`、两处
`[data-ui].tcrn-section-tabs`、`#persona-detail.tcrn-detail-inspector`、
`#receipt-body.tcrn-readback-panel` 等最终 DOM 节点。

变异命令=`TCRN_UI_MUTATION=s253-old-class node --test portal/tests/ui-presence.test.mjs`：
退出码 1；它把实际 `header` 的 `tcrn-top-bar` 改成旧 `tcrn-topbar`，门以
`the executed DOM must expose the S253 DS class alignment` 红掉，说明门不是
静态字符串包含的假门。恢复后同一门重新 5/5。

## 其它复核

- 复核命令=`pnpm portal:test`：21 tests、21 pass、0 fail。
- 复核命令=`node portal/scripts/design-proof.mjs`：4 legs 全部 `ok: true`，包括
  `no-inline-style-attributes` 与 `interactive-tcrn-class-coverage`。
- 复核命令=`node scripts/ds-component-css-reconcile.mjs`：快照与 inline 为
  98206 bytes、SHA256 `4fb41b272bb969bfcd7aebe0129c261a9a944abf41ba2fda39fa920bcbc62a15`，
  reason `DS_COMPONENT_CSS_RECONCILED`。
- 复核命令=`node scripts/verbatim-evidence-proof.mjs --check`：本文件加入逐字块后，
  全部 evidence blocks 通过；数字与行号以该门读回为准。

## 待裁与停放

- 未证——归 Owner：Rules 标题目录是否正式归入 `tcrn-knowledge-toc-rail`；本单只
  提供可回滚的根类候选，未改写目录子项语义。
- 未证——归 Owner：`meta`、`search-results`、`brand` 是否需要各自的新 DS 语义
  组件；没有方向裁定前不硬套 `MetadataRail`、`KnowledgeSearchResults` 或 `BrandMark`。
- 未证——归 Owner：DS 视觉切换后的接受度；本单提供 DOM 级对齐和本地门，不代替
  Owner 视觉验收。
- `0.11.15` 发版、helper c40 重钉、push/tag/deploy 均停放；平台根 0 字节
  `AGENTS.md` 未写入。
