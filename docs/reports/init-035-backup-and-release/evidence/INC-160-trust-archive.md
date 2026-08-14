已脱敏，非逐字；原件见平台档案 init-035-backup-and-release/。

# INC-160 trust archive freshness

## 交付

- install-manifest 与 doctor 新增信任档案新鲜度探针：校验档案内部 digest、档案覆盖在位
  文件全集、三个已发现消费者副本与档案的一致性，并校验安装副本版本等于部署位引擎版本。
- 已查明 `.agents/skills/tcrn-workflow-helper` 是真实消费者：其锁定文件声明该 skill，
  在位副本已纳入 manifest 的 digest 探针；没有删除消费者，也没有改写信任档案。
- 合成临时目录覆盖档案缺失、档案漂移、消费者额外文件和版本 marker 漂移；新测试已登记
  coverage baseline。

## 先红留证

当前红端为 `PLATFORM_TRUST_ARCHIVE_STALE`：信任档案登记 15 项，而三个消费者各有 18
项在位文件；档案与副本存在 digest 漂移，安装副本 marker 仍为旧版本而部署位引擎已前进。
原始 doctor 输出保存在平台档案；本文件是脱敏摘要，不称为 verbatim。

绿端留给 STORY-273：由 agent:fable 通过正规安装流重钉并刷新信任档案后再验收。本单不
擅自把红端改绿，不删除 `.agents` 消费者，不改变 Owner 决策。

状态：`pending-owner-acceptance`。不推送、不打 tag、不发版。
