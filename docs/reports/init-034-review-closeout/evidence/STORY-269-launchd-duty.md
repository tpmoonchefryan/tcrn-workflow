已脱敏：本文件不含本机路径、用户名或主机标识；原始证据仅存平台档案。

# STORY-269：launchd 值班腿

## 结果

doctor 不再维护 launchd label 常量，而是读取 manifest 的
`machine.launchd-paired-backup` acceptanceProbe。合成测试要求三件事同时
成立：label 在册、最近一次 exit 为 0、paired-backup 成功状态在 freshness
窗口内；失败、缺席、旧成功状态各有独立红 reasonCode。

当前真机读回为预期的诚实红：

```text
reasonCode = PLATFORM_LAUNCHD_LAST_RUN_FAILED
requiredLabel = com.tcrn.aos.paired-backup
lastExitCode = 1
```

五分区的 paired-backup 失败日志保留了 `due: true`、`took: false` 与
`chain_half_is_not_live`；见 `S269-launchd.log` 和 `S269-launchd.err`。本单
没有为了绿门而弱化判据。

## Boundary

该单证明 doctor 能读 manifest 并揭示调度停摆；不证明备份复原已执行，不把
失败运行写成成功，也不证明 Owner acceptance、`done`、push、tag 或发布。
