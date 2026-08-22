# 已接受例外的派工载荷

本目录是 `docs/2026-08-23-accepted-exception-handoff.md` 的执行简报载荷，
不是链上第二份 scope，也不表示实现已经完成。

单在 **cross-project 分区**（`TCRN-CROSS-INC-246`），代码在**本仓**
（`scripts/platform-doctor.mjs`）—— 载荷放这里，是因为交接书与病因同处。

## 一处更正

首版 README 写着判据名册不在任何 Git 仓里。**那是错的**：`TCRN Platform/docs/` 本身就是一个
本地（无远端）Git 仓，`acceptance-gate-groups.json` 自始受追踪。
写单人当时只查了 tcrn-workflow / DS / AOS 三个仓，没查 docs 目录自己是不是仓。
例外记录因此有提交历史背书，不需要额外安排。

## 验证

```bash
node scripts/dispatch-readiness-compliance.mjs --brief docs/dispatch/2026-08-23-accepted-exception/briefs/TCRN-CROSS-INC-246.brief.json
```

1/1 `DISPATCH_BRIEF_READY`。

## 边界

只是派工载荷：没有修改链上状态、没有推进到 `done`，没有 push、tag、部署或发布。
本单改的是 `done` 判据本身，落地后要能证明它仍拦得住真故障。
