已脱敏：本文件不含本机路径、用户名或主机标识；原始证据仅存平台档案。

# INC-159：paired-backup 方向查明

## 只读观察

本调查只读取 LaunchAgent、scheduler 输出、错误输出和一次性归档清单；没有
重载、执行复原、改变编排或写入任何备份状态。当前调度 label 在册，间隔为
六小时，最近一次退出码为 1。该次 due run 覆盖五个分区，五个分区均
`due: true`、`took: false`、`pairId: null`，失败 reason 为
`chain_half_is_not_live`；因此没有产生可替代既有成功回执的新配对证据。

交接中提到的一次性 archive 只作为一次性链备份留存，不能被表述为 recurring
paired-backup 已恢复。原始调查见 `INC-159-backup-investigation.stdout.json`。

## 待 Owner 裁定的三个方向

| 方向 | 代价 | 可行性 | 对 AOS 遗留架构的影响 |
| --- | --- | --- | --- |
| 编排改指本机 paired backup | 低到中；需改调度目标、验证完整五分区配对并重建运行回执 | 中；依赖本机继续持有两半且 Owner 明确接受该拓扑 | 保留 paired 语义但放弃当前异地主机分工，旧 remote-half 路径会变成遗留配置 |
| 重建异地半边 | 高；需要恢复远端运行时、网络/认证、远端存储与逐文件核验 | 当前未证；外部主机与权限是前置 | 最接近既有设计，保留异地灾备语义，修复迁置后 vacated 半边 |
| 退役 paired，改用本地 snapshot | 中；需定义 snapshot 保留、校验、恢复演练并处理旧 scheduler | 本机路径可做，但保护模型需要重新裁定 | 简化 paired 代码与调度，但丢失异地副本语义；AOS 遗留接口和告警需有序退役 |

本表是报告，不替 Owner 选择；在裁定前不执行任何一个方向。

## Boundary

本单只证明当前失败状态与决策面，不证明 restore、远端写入、真实生产备份、
Owner acceptance、`done`、push、tag 或发布。
