# INC-153 — 全量恢复、字面量清理与证据校正

状态：实现完成，待 Owner 验收。

## 修复指针

- 预设 override 详情真实渲染 `data-ui="persona-restore-all"`，全量恢复
  handler 发送不带 `field` 的 `persona-preset-restore`；单字段恢复仍保留
  `data-ui="persona-restore-field"`。真实 DOM 行为包含 restore 后 receipt
  读回，而不是只查 HTML 文本。
- `portal/index.html` 用 setting key 派生 host 和 plan setting，移除
  host/role 的三元式字面量；角色选项来自 vocabulary，新增 persona 没有
  偷塞固定 reviewer。
- STORY-244..251 的复核命令、测试数量和 i18n 数字已按当前命令输出校正；
  INC-137、INC-146、INC-140 的历史证据字段也改为当前实际 leg 名/字段。

## 绿腿原始关键输出

复核命令=`node --test portal/tests/ui-presence.test.mjs`。当前结果：

```excerpt
✔ INC-148 rendered DOM contract names every preview component
✔ INC-148 rendered DOM behavior changes receipt state
✔ INC-151 rendered engine card follows the engine status value
✔ INC-151 rendered health card turns red when actor configuration is absent
✔ INC-150 vocabulary descriptions are localized in the executed DOM
ℹ tests 5
ℹ pass 5
ℹ fail 0
```

复核命令的旧回读写成了“exit 1、无匹配”，这是错误的。本次改为机械重跑，
真实 exit 0 且有 4 处匹配；这些匹配是 `typeof` 守卫以及对派生 host 的比较，
不是 host/role 的硬编码三元式。下面的 verbatim 块同时钉住数字、行号和字节。

```verbatim:node scripts/verbatim-evidence-proof.mjs inc153-host-role-scan
{
  "scan": "rg -n 'claude-code|codex|reviewer|role ===|host ===|host \\?' portal/index.html",
  "exitCode": 0,
  "matches": [
    "3868:  const roleValue = (role) => typeof role === \"string\" ? role : role?.value;",
    "3976:  const activePlan = (host) => { const entry = planSettingForHost(host); return state.execution?.plans?.find((plan) => plan.host === host && plan.name === entry?.currentValue); };",
    "3978:    const values = entry.key.includes(\"SubagentPlan\") ? [\"\", ...(state.execution?.plans || []).filter((plan) => plan.host === hostFromPlanKey(entry.key)).map((plan) => plan.name)] : [...(entry.allowedValues || [])];",
    "4100:      const hostPlans = plans.filter((plan) => plan.host === host);"
  ]
}
```

复核命令=`pnpm verify:source` 在新增五份 incident evidence 后应以
`SOURCE_ALLOWLIST_VERIFIED` 和 `files:513, exactEntries:513` 读回；最终
命令输出以收口实录为准。

## 待裁与边界

- 侧栏名称是否严格采用 MIN-073 R1 全称仍未裁；本单不擅自迁移信息架构。
- 浏览器视觉验收、0.11.15、helper c40、push/tag/deploy 仍停放。
