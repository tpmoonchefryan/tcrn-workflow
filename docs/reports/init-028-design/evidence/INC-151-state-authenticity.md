# INC-151 — 状态面真实性

状态：实现完成，待 Owner 验收。

## 现象与证据

复核依据指出门户把 `engineVersion` 写死为当前偶然相同的值，健康卡在顶层
状态失败时仍可能呈绿，actor 检查也曾是恒真腿。本单把这些值接回运行期
状态，并让失败态进入同一张真实 DOM 健康卡。

## 修复指针

- `portal/portal.mjs` 从 CLI status body 读取 `engineVersion`；
  `TCRN_PORTAL_ACTOR` 为空或全空白时写面拒绝，health check 返回
  `PORTAL_ACTOR_MISSING`，不再恒真。
- `portal/index.html` 对 `status.ok === false` 进行失败态归一化，健康
  chip、计数和行都不再在顶层失败时显示绿色。
- `portal/tests/portal.test.mjs` 验证 API 读到变异的 engine version 和
  actor failure；`portal/tests/ui-presence.test.mjs` 在执行 DOM 中验证
  `#stat-engine` 与失败健康 chip。

## 绿腿原始关键输出

复核命令=`pnpm portal:test`（单独串行执行）。当前结果：

```text
ℹ tests 21
ℹ pass 21
ℹ fail 0
```

复核命令=`node --test portal/tests/ui-presence.test.mjs`。当前结果：

```text
✔ INC-151 rendered engine card follows the engine status value
✔ INC-151 rendered health card turns red when actor configuration is absent
ℹ tests 5
ℹ pass 5
ℹ fail 0
```

两条 UI 判据是在 linkedom 中执行真实 portal boot script 后查询 DOM；API
测试只作为状态来源的辅助证据。

## 待裁与边界

- `linkedom` 是 test-only DOM 环境；是否改用真实浏览器驱动未裁，归 Owner。
- 本地状态读面不等于真实第三方账号健康或实际派发授权；发版、部署、
  push/tag、helper c40 均停放。
