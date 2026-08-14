已脱敏：本文件不含本机路径、用户名或主机标识；原始证据仅存平台档案。

# STORY-271：helper 前置止血与表述更正

## 选择与结果

本单选择 payload 版本前置声明（A），没有选择机器副本回退。helper 已在本地
候选 `0.1.0-candidate.42` 中加入 install-surface preflight：在读取
`install-manifest` 之前，先读引擎版本与能力；安装面要求 Workflow `v0.11.16`
或更高且必须广告 `install-manifest`。旧版本、缺能力或 `CLI_UNKNOWN` 均停止
并报告 `ENGINE_CAPABILITY_PREFLIGHT_REQUIRED`，不写回执、不继续半套计划。

候选仍绑定当前已批准的 Workflow `v0.11.15`，因此“先发 Workflow `v0.11.16`
再重钉”的 Workflow-first 路径只记录为待 Owner 放行的停放项。本单没有 push、
tag、发版或把旧引擎伪装成支持新清单。

源 payload 与三个 host copies 共 18 个文件逐字节一致；bootstrap 对三个安装
副本的 `INSTALLED_COPY_VALIDATED` 读回均通过。候选归档、source archive、
checksums、release artifacts 与 reproducibility gates 通过；本地提交与 push
gate 仍按边界停放。

## 表述注记

- S262 Residence matrix 的 deny 与 hooks 两格明确写为“未观测”。
- S261 测试标题及摘要明确 required catalog 独立于被测 manifest。
- S265 明确第四个比较对象是 agent 安装副本，而不是机器 trust archive；
  结论不变。

## Boundary

这是安全前置与文字校准，不是 Workflow 版本发布、宿主批准、Owner acceptance
或 `done` 转换。
