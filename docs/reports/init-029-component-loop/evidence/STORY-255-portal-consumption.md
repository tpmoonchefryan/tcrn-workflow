> 已脱敏，非逐字；原件见平台档案 `init-032-review-remediation/original/STORY-255-portal-consumption.md`。

# STORY-255 门户消费 DS 构件回流证据

状态目标：`pending-owner-acceptance`；`done` 仍只属于 Owner。本单没有发版、发布、push、tag 或 deploy。

## 交付范围与三层边界

S255 重新从 DS `tcrnComponentCss` 导出生成签入快照，并把门户从八个 B 线自写根类切到 S254 已回流的公开构件根类。门户运行期仍是 zero-dependency：不 import DS 包、不解析 sibling 仓、不通过旧根类做语义硬映射；`data-ui` 行为契约保持不变。

| 层 | 当前实现 | 证据与边界 |
| --- | --- | --- |
| DS 快照 / 构件层 | `portal/ds-component-css.snapshot.css`；`portal/index.html` 的 `<style id="tcrn-ds-component-css" data-source="snapshot">`；八个消费根类：`tcrn-switch`、`tcrn-stat-card`、`tcrn-setting-row`、`tcrn-field-provenance`、`tcrn-line-numbered-editor`、`tcrn-app-status-bar`、`tcrn-definition-list`、`tcrn-lock-hint` | snapshot 与 inline 都是 98206 UTF-8 bytes，SHA256 为 `4fb41b272bb969bfcd7aebe0129c261a9a944abf41ba2fda39fa920bcbc62a15`；动态 DOM 门逐一查询八个根。 |
| 门户域层 | 统计卡、设置行、布尔开关、persona provenance/lock、编辑器的页面编排、vocabulary 与搜索/领域状态；代表性门户域根包括 `.tcrn-editor-shell`、`.tcrn-editor__bar`、`.tcrn-editor__status`、`.tcrn-editor__directory`、`.tcrn-vocabulary`、`.tcrn-vocabulary__terms`、`.tcrn-manage`、`.tcrn-subnav`、`.tcrn-search-results`、`.tcrn-search-result`、`.tcrn-brand`、`.tcrn-list`、`.tcrn-meta`、`.tcrn-highlight`、`.tcrn-paths` | `node scripts/s253-class-alignment-proof.mjs` 的当前门户自有 style 根计数为 51；这些域类只承担页面业务语义，不冒充 DS 构件。 |
| 布局骨架层 | `.tcrn-app`、`.tcrn-product-shell`、`.tcrn-product-shell__workspace`、`.tcrn-product-shell__main`、`.tcrn-main`、`.tcrn-grid` | 只负责应用/外壳/主区/网格布局，不替换 DS 构件；AppStatusBar 已移入 workspace 的最后一行，浏览器中可见。 |

具体实现指认：

- 静态 dashboard 的四张统计卡在 `portal/index.html` 使用 `.tcrn-stat-card` 与 `__label/__value/__note`；门户旧 `.tcrn-stat` 基线已删除。
- `controlFor()` 的 boolean 分支输出 `.tcrn-switch`、`role="switch"` 的 input 与 `__label`；`renderSettings()` 输出 `SettingRow` 的 key/name/description/control/tools/modified/reset 槽，并保留 `data-setting-row`、`data-ui`。
- persona 编辑器的 factory 值输出 `.tcrn-field-provenance`，锁定提示输出 `.tcrn-lock-hint`；`persona-ghost`、`persona-name-lock` 行为钩子不改名。
- prose 静态根与动态 findings 使用 `.tcrn-line-numbered-editor`、`__gutter`、`__content`、`__control`、`__findings`；门户保留 `.tcrn-editor-shell` 作为编排骨架。
- `renderVocabulary()` 输出语义 `<dl class="tcrn-definition-list">`、`dt`/`dd` 与 `__term/__definition`；旧 `.tcrn-term` 自写根已删除。
- 状态栏使用 `.tcrn-app-status-bar`、`role="status"`、`__command/__state/__action`；状态栏的 receipt action 仍调用同一个 `drawer-button`。

## 根类收敛与快照对账

S253/S255 的可复核命令为 `node scripts/s253-class-alignment-proof.mjs`。它只统计门户第二个 style 块中的 unique class-root token，排除 BEM parts 与 modifiers；不是 DS 快照根类总数。

```json
{
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
  ]
}
```

当前 `node scripts/ds-component-css-reconcile.mjs` 读回：

```json
{"ok":true,"reasonCode":"DS_COMPONENT_CSS_RECONCILED","snapshot":{"path":"portal/ds-component-css.snapshot.css","bytes":98206,"sha256":"4fb41b272bb969bfcd7aebe0129c261a9a944abf41ba2fda39fa920bcbc62a15"},"inline":{"path":"portal/index.html","marker":"<style id=\"tcrn-ds-component-css\" data-source=\"snapshot\">","bytes":98206,"sha256":"4fb41b272bb969bfcd7aebe0129c261a9a944abf41ba2fda39fa920bcbc62a15","matchesSnapshot":true},"reconciliation":{"source":"../TCRN-Design-System/packages/ui-react/src/components/Navigation/Navigation.tsx","sourceStatus":"verified","sourceBytes":98206,"sourceSha256":"4fb41b272bb969bfcd7aebe0129c261a9a944abf41ba2fda39fa920bcbc62a15","sourceMatchesSnapshot":true,"countedAsGreen":true}}
```

`node scripts/ds-component-css-proof.mjs` 的五腿为：baseline `DS_COMPONENT_CSS_RECONCILED` 绿；DS 源单字节变异 `DS_COMPONENT_CSS_SOURCE_DRIFT` 红；快照单字节变异 `DS_COMPONENT_CSS_INLINE_DRIFT` 红；DS source absent 为 `DS_COMPONENT_CSS_SNAPSHOT_SELF_SUFFICIENT`，`sourceStatus=unverified` 且 `countedAsGreen=false`；恢复后再次 `DS_COMPONENT_CSS_RECONCILED` 绿。无 sibling 的 self-sufficient 只证明快照能启动，不被记作源对账绿。

## UI 主张：执行 DOM 证据与先红门

本单的 UI 主张使用实际执行 DOM，不以 API 返回、静态 HTML、`innerHTML` 字符串包含或 CSS 文本命中作为唯一依据。`portal/tests/ui-presence.test.mjs` 的 `assertDomContract()`（当前约第 204–257 行）在 `linkedom` 页面加载门户脚本并等待渲染后：

1. 确认 marker template 已从 DOM 消失；
2. 查询 `style#tcrn-ds-component-css[data-source="snapshot"]`；
3. 对八个返回根类逐一查询 DS CSS root 与执行 DOM 节点；
4. 查询 S253 对齐后的 `header.tcrn-top-bar`、`.tcrn-product-shell`、`.tcrn-side-nav`、两处 `data-ui` tabs、`.tcrn-surface`、persona inspector、knowledge TOC、receipt badge/drawer/readback、activity feed；
5. 继续运行行为断言：persona restore、receipt drawer open/close、设置写入后 receipt chip 更新。

复核命令 `node --test portal/tests/ui-presence.test.mjs`：5 tests、5 pass、0 fail。

强化门在修复后仍保留可复现的红 leg。命令：

```text
TCRN_UI_MUTATION=s255-missing-component-css node --test portal/tests/ui-presence.test.mjs
```

退出码为 1；只运行 1 个 mutation test，0 pass、1 fail，断言为“the executed page must consume every returned construct from the inlined DS snapshot”，实际缺失 `tcrn-switch`，期望缺失列表为 `[]`。该 mutation 把 `.tcrn-switch {` 改成 `.tcrn-switch-mutated {`；恢复源后上述 5/5 变绿。红 leg 是修复前/变异现状的门取证，不是修复后补写的假门；修复单没有放宽判据。

## 浏览器实际渲染与计算样式

用本地 Chrome headless/CDP 打开运行中的门户（1440×900 viewport）并查询执行后的节点与 `getComputedStyle()`；不是 in-app browser 或生产账户证据。截图：

- [dashboard actual render](./STORY-255-portal-dashboard.png)
- [settings / execution actual render](./STORY-255-portal-settings.png)

dashboard 读回：`page=dashboard`、`statusVisible=true`、`statusRect={x:280,y:845,width:1160,height:55}`、`snapshotBytes=98206`；四个 `.tcrn-stat-card` 的 computed `display=grid`、背景为 `rgb(255, 255, 255)`；`.tcrn-line-numbered-editor` 为 `display=grid`；`.tcrn-app-status-bar` 为 `display=flex`、背景为 `rgb(242, 242, 240)`。

settings/execution 读回：`page=settings`、`settingGroup=execution`、`statusVisible=true`、同一 `snapshotBytes=98206`；`.tcrn-switch` count=1/display=`grid`，`.tcrn-setting-row` count=5/display=`grid`，`.tcrn-app-status-bar` count=1/display=`flex`，背景为 `rgb(242, 242, 240)`。prose 路由实际 editor 根 count=1/display=`grid`；vocabulary 路由实际 definition list count=1/display=`grid`；entities/Verity browser state 的 lock hint count=2/display=`flex`。persona provenance 的 overridden state 由上述 executed-DOM fixture 以 `persona-preset-override` 写入并断言，未把当前 live workspace 的 absence 冒充成真实账户状态。

DS 构件源侧的对应主证据见 `TCRN-Design-System` 仓 `docs/reports/init-029-component-loop/evidence/STORY-254-component-return.md`：Storybook 实际 DOM proof 读回 `switchOn=true`、`statTones=[positive,warning]`、`settingModified=true`、`fieldOverridden=true`、`editorWarning=true`、`statusRole=true`、`definitionTerms=2`、`lockHint=true`，并明确第九槽 `ModifiedIndicator` 的合并仍为 `ownerDecision=unresolved_until_owner_acceptance`。

## 其它门与串行列车

- `pnpm portal:test`：21 tests、21 pass、0 fail。
- `pnpm portal:proof`：`DESIGN_SYSTEM_COMPLIANT`；四个 design legs（含 `no-inline-style-attributes`、`interactive-tcrn-class-coverage`）全绿；i18n `keyCount=190`、`localeCount=5`、`expectedStrings=950`、无 gaps；dependency audit `NO_INTERNAL_IMPORTS`。
- `node scripts/coverage-conservation.mjs`、coverage test/proof：coverage baseline 无丢失；本次没有新增 workflow test file，`portal/tests/ui-presence.test.mjs` 的断言增加纳入现有 baseline 复核。
- `node scripts/verbatim-evidence-proof.mjs --check`：当前 evidence 的逐字块通过；`node scripts/verbatim-evidence-meta-proof.mjs`：meta 通过。
- `pnpm test`：最终串行列车 receipt 为 `TESTS_VERIFIED`；全仓 1085 tests、0 fail。此前截图 allowlist 缺失导致的 `PROOF_ARTIFACT_UNAPPROVED_SOURCE` 已通过 allowlist 与 proof-artifact regeneration 收口，不计入最终结果。

## 逐个动词回指

本单只使用以下可被实现指认的动词：

| 动词 | 实现指认 | DOM / 计算样式证据 |
| --- | --- | --- |
| 消费 | portal inline snapshot + `renderSettings()`/`renderVocabulary()`/editor/static dashboard | `ui-presence` 执行 DOM 逐根查询；reconcile 字节对账；Chrome settings/dashboard/prose/vocabulary 查询 |
| 展示 | StatCard dashboard、SettingRow/Switch execution、AppStatusBar、DefinitionList vocabulary | 截图和 computed `display`/count/rect；状态栏可见且有 command/state/action 文本 |
| 实现 | DS 构件公开根与 portal 对应 DOM/行为契约 | S254 Storybook DOM proof、S254 62 SSR tests + 10 DOM tests、portal 5 DOM tests + mutation red leg |

没有证据支持的生产账户、发布结果或 Owner 视觉接受不在本单主张中。

## 待裁与停放

- 未证——归 Owner：S254 合并槽 `ModifiedIndicator` 是否保持并入 `SettingRow`，或拆出独立第九公开构件；本单不自行决定。
- 未证——归 Owner：六根/八构件回流后的视觉切换是否接受；本单给出 dashboard/settings 实际截图、Chrome computed-style 与 DOM 门，不代替视觉验收。
- 未证——归 Owner：DS sibling 缺失时只可记为 snapshot self-sufficient、源 leg unverified；不能跳过源对账。
- 未证——归 Owner：Rules 目录、`meta`、`search-results`、`brand` 等语义边界继续沿用 S253 处置表，不在 S255 擅自硬映射。
- `0.11.15` 发版、helper c40 重钉、两仓 push/tag/deploy 均停放；平台根 0 字节 `AGENTS.md` 未写入。
