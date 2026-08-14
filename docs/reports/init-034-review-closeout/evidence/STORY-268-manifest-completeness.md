已脱敏：本文件不含本机路径、用户名或主机标识；原始证据仅存平台档案。

# STORY-268：清单完整性真变异

## 结果

required-item catalog 已与 manifest 解耦，测试不再从被测清单自动生成自身
的 required 集合。独立 scratch 夹具执行了控制腿与三次真实源变异：

| 变异 | 删除的 item id | 真编译 | 读完整性红腿 |
| --- | --- | --- | --- |
| container | `container.mcp` | green | `INSTALL_MANIFEST_ITEM_MISSING` |
| project | `project.TCRN-TMS` | green | `INSTALL_MANIFEST_ITEM_MISSING` |
| machine | `machine.portal-launcher-command` | green | `INSTALL_MANIFEST_ITEM_MISSING` |

每个变异都确认删除 id 不在新 dist 中，随后独立完整性测试 exit 1。原始机器
可读结果见 `S268-manifest-mutation.stdout.json`；控制腿仍为 green。

## 验证

```text
pnpm build
node --test tests/init033-install-surface.test.mjs
node scripts/init034-manifest-mutation-proof.mjs
```

S261 的测试标题与摘要已同步为“independent required-item catalog”，只改
表述，不改变结论，也未重开 INIT-033。

## Boundary

该单证明 manifest 删除会被独立 catalog 捕获；不证明 Owner acceptance、
`done`、发布列车或任何外部发布动作。
