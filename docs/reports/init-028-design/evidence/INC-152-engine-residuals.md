# INC-152 — 引擎残余与同名守卫红腿

状态：实现完成，待 Owner 验收。

## 先红：修复前的两个元判据腿

两个守卫的判据先保持不变，只把实现临时改成代码级恒假比较；每次先构建，
再 grep `dist` 确认变异字节确实进入编译产物，最后运行指名测试。两条门均
在修复前真实退出 1。

### `execution-config.ts:285` active preset guard

变异命令将 active 分支追加为
`state.personas.some((persona) => persona.name === "__mutation-never-matches__")`。
构建退出 0，`rg` 命中编译字节：

```text
171:        }, name, state.personaTombstones) && state.personas.some((persona)=>persona.name === "__mutation-never-matches__")) {
```

原始红腿关键输出：

```text
✖ INC-152 PERSONA_NAME_CONFLICT rejects active and tombstoned preset names
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
+ actual 'PERSONA_WRITE_COMMITTED'
- expected 'PERSONA_NAME_CONFLICT'
```

### `execution-config.ts:288` tombstone guard

变异命令将 `state.personaTombstones.includes(name)` 改为
`state.personaTombstones.includes("__mutation-never-matches__")`。构建退出 0，
`rg` 命中编译字节：

```text
174:        if (state.personaTombstones.includes("__mutation-never-matches__")) {
```

原始红腿关键输出：

```text
✔ INC-145 PERSONA_NAME_CONFLICT names the custom-versus-preset route
✖ INC-152 PERSONA_NAME_CONFLICT rejects active and tombstoned preset names
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
+ actual 'PERSONA_WRITE_COMMITTED'
- expected 'PERSONA_NAME_CONFLICT'
```

两次变异均已恢复；门的判据没有被修复单改写。

## 修复与绿腿

- active preset 使用 `personaNameExists(..., state.personaTombstones)`，而
  tombstone 分支保持可达；自定义同名和 tombstone 同名分别被具名拒绝。
- `MODEL_PLAN_IN_USE`、preset-in-use 回调返回具体 `setting <key>` 或
  `model plan <host>/<name>`，拒绝消息指向释放引用的动作。
- `SettingKey` union 与 `catalogEntries` 在源中独立按 canonical text 排序；
  `settingsEnums` 只输出 `controlType === "enum"` 的 catalog 项；legacy
  CLI 早拒绝并指向现役只读动词族。

复核命令=`pnpm build && node --test tests/s244-model-plan.test.mjs tests/s245-subagent-plan-keys.test.mjs tests/s246-persona-overlay.test.mjs tests/s247-vocabulary.test.mjs`。
当前结果为 10 tests、10 pass、0 fail；build 返回
`{"ok":true,"command":"build","reasonCode":"BUILD_VERIFIED","files":55}`。

## 待裁与边界

- legacy `execution-config` 的最终处置仍有“只读兼容/明确迁移告知/完全移除”
  三种方向，当前只保留 replay 兼容并对公共 CLI 具名早拒，未替 Owner 决定。
- `reviewOnlyDispatchable` 的真源落点仍未裁，归 Owner；不把当前 vocabulary
  读面包装成该方向已裁定。
- 0.11.15、helper c40、push/tag/deploy 停放。
