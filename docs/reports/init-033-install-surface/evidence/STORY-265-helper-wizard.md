> 已脱敏，非逐字；主机绝对路径与原始回执仅存于平台档案 `init-033-install-surface/S265-helper-repin.stdout.json`。

# STORY-265：多语言安装面向导与 helper 重钉

## 结论

helper 已在本地提交 `0c22924`（`0.1.0-candidate.41`），目标 Workflow
身份固定为 `v0.11.15`。源 skill、Claude、Codex 及 `~/.agents` 安装副本均为
18 个文件、逐字节一致；这里的第四份比较对象是 `~/.agents` 安装副本，
不是机器 trust archive。候选归档、源码归档和 bootstrap pin 已由
`PUSH_GATE_VERIFIED` 读回。此提交没有 push、tag 或 release。

## 意图门与语言矩阵

`references/install-surface-wizard.md` 固定覆盖五种语言与两种操作：

| language | operations | confirmation |
| --- | --- | --- |
| en | install / update | matching-language question |
| zh-CN | install / update | matching-language question |
| ja | install / update | matching-language question |
| ko | install / update | matching-language question |
| fr | install / update | matching-language question |

每种语言有两条相似请求示例；示例只是意图信号，不是命令。只有用户在
相同语言明确确认后才进入完整向导；否定或含糊回答不写入、不生成回执。
向导要求先展示完整 `install-manifest` 计划，再使用规范引擎 API 物化
Claude 与 Codex 两种适配器，并区分引擎物化、主机配置、主机批准、真实
触发、Owner acceptance 与外部发布等证据等级。

项目映射保留精确小写目录 `joi-button`。向导不写控制树、不改 Workspace
地址、不执行路径迁移动作，也不把测试绿态或 helper 重钉写成 Owner
acceptance。

## 验证

- `pnpm test`：`MATRIX_TESTS_VERIFIED`；bootstrap、shard、serial 与
  release-negative 检查均通过。
- `pnpm verify`：`RELEASE_ARTIFACTS_VALIDATED`。
- `pnpm build`：通过。
- `pnpm artifacts:repro`：`ARTIFACTS_REPRODUCIBLE`。
- `pnpm push-gate`：`PUSH_GATE_VERIFIED`；仅完成本地门禁，没有执行推送。

## Boundary

本证据证明 helper 候选内容、语言意图门、安装面步骤、源 skill 与三个安装副本
的一致性及
本地门禁。它不证明宿主批准、真实运行时 pair、Owner acceptance、`done`、
push、tag 或 release。
