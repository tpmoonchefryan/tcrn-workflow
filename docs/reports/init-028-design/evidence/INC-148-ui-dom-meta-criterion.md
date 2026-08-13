# INC-148 — rendered-DOM UI gate

状态：实现完成，待 Owner 验收。

## 交付指针

- `portal/tests/ui-presence.test.mjs` 使用 test-only `linkedom` 解析真实 DOM，并在同一 DOM 环境执行门户的 `locales.js` 与 inline boot script；它查询 `document.querySelectorAll`，不读取 `innerHTML` 做存在性判定，也不把 `<template>` 或 `<script>` 内容当成页面节点。
- `portal/index.html` 删除了没有运行期实例化路径的 `ui-contract-markers` template；`renderPersonaButton` 现在真实渲染 `data-ui="persona-override-dot"`。
- 测试 fixture 起真实 portal + 真实 CLI scratch workspace，种入一个 preset override、一个 active model plan 和一条 prose finding，然后经过真实 DOM 点击导航、实体和设置分组，覆盖静态与动态构件。
- `linkedom` 仅为开发测试依赖；门户分发产物仍无运行期依赖。该 DOM 环境选型是给 Owner 的方案，具体选型未裁。

## 修复后绿腿原始输出

复核命令：

```sh
node --test portal/tests/ui-presence.test.mjs
```

原始 stdout：

```text
✔ INC-148 rendered DOM contract names every preview component (1770.682667ms)
✔ INC-148 rendered DOM behavior changes receipt state (2280.404625ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 4130.437958
```

## 元判据红腿原始输出

以下命令均在当前修复后的 worktree 运行；每个变异只作用于测试启动时读取的临时 HTML/source，未改写工作树。预期是门自身退出码为 1；失败信息必须点名被删构件或行为。

### 1. 删除 assignment addline

命令：`TCRN_UI_MUTATION=assignment-addline node --test portal/tests/ui-presence.test.mjs`；退出码：`1`。

```text
✖ INC-148 meta-criterion mutation assignment-addline must red (1788.029334ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
...
AssertionError [ERR_ASSERTION]: rendered DOM components absent: [{"name":"assignment addline","selector":"[data-ui=\"assignment-addline\"]"}]
```

### 2. 删除 persona ghost 与单字段恢复

命令：`TCRN_UI_MUTATION=persona-ghost-restore node --test portal/tests/ui-presence.test.mjs`；退出码：`1`。

```text
✖ INC-148 meta-criterion mutation persona-ghost-restore must red (1777.717916ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
...
AssertionError [ERR_ASSERTION]: rendered DOM components absent: [{"name":"persona factory ghost","selector":"[data-ui=\"persona-ghost\"]"},{"name":"persona single-field restore","selector":"[data-ui=\"persona-restore-field\"]"}]
```

### 3. 断开回执芯片 click listener

命令：`TCRN_UI_MUTATION=receipt-click node --test portal/tests/ui-presence.test.mjs`；退出码：`1`。

```text
✖ INC-148 meta-criterion mutation receipt-click must red (1793.597416ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
...
AssertionError [ERR_ASSERTION]: receipt chip click must open the drawer

'false' !== 'true'
```

### 4. 将受检构件替换为空 presentation div

命令：`TCRN_UI_MUTATION=presentation node --test portal/tests/ui-presence.test.mjs`；退出码：`1`。

```text
✖ INC-148 meta-criterion mutation presentation must red (1769.684708ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
...
AssertionError [ERR_ASSERTION]: rendered DOM components absent: [{"name":"workspace overview/audit tabs","selector":"[data-ui=\"workspace-tabs\"]"}]
```

本变异在真实 DOM 中用 `document.createElement("div")` + `role="presentation"` 替换 workspace tabs，再运行同一门；不是字符串包含判定。

### 5. 写入后令回执芯片文本保持 idle

命令：`TCRN_UI_MUTATION=receipt-stale node --test portal/tests/ui-presence.test.mjs`；退出码：`1`。

```text
✖ INC-148 meta-criterion mutation receipt-stale must red (2288.004292ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ todo 0
...
AssertionError [ERR_ASSERTION]: receipt chip must update after a successful write, got "idle"
```

这条先点击真实设置控件触发 portal 的 public-CLI 写面，再要求 `#receipt-chip-text` 匹配 `/^✓v\\d+$/`；因此覆盖了 INC-141 的“写成功但芯片不变”根因。

## 边界

- 未触碰平台根 `AGENTS.md`。
- 没有 push/tag/deploy、发版或 helper c40 重钉。
- 待裁点：DOM 环境采用 `linkedom`（轻量、test-only、无需浏览器进程）还是由 Owner 指定真实浏览器驱动；本实现给出前者方案，未替 Owner 裁定。
