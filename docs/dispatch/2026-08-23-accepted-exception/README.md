# 已接受例外的派工载荷

本目录是 `docs/2026-08-23-accepted-exception-handoff.md` 的执行简报载荷，
不是链上第二份 scope，也不表示实现已经完成。

单在 **cross-project 分区**（`TCRN-CROSS-INC-246`），代码在**本仓**
（`scripts/platform-doctor.mjs`）—— 载荷放这里，是因为交接书与病因同处。

## 一件动手前要知道的

判据名册 `TCRN Platform/docs/acceptance-gate-groups.json` **不在任何 Git 仓里**：
容器根按 `AGENTS.md` 的设计不是仓，而 `platform-doctor.mjs:249` 以绝对路径读它。
所以本单交付的例外记录，其载体当前**不受版本控制** ——
这一条不要就地解决（搬仓属容器布局变更），但要在实现注释与报告里记下来。

## 验证

```bash
node scripts/dispatch-readiness-compliance.mjs --brief docs/dispatch/2026-08-23-accepted-exception/briefs/TCRN-CROSS-INC-246.brief.json
```

1/1 `DISPATCH_BRIEF_READY`。

## 边界

只是派工载荷：没有修改链上状态、没有推进到 `done`，没有 push、tag、部署或发布。
本单改的是 `done` 判据本身，落地后要能证明它仍拦得住真故障。
