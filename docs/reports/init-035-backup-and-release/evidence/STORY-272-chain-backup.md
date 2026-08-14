已脱敏，非逐字；原件见平台档案 init-035-backup-and-release/。

# STORY-272 chain backup

## 交付

- 新增 `scripts/platform-chain-backup.mjs`：`--platform-root` 为必填；本地腿只读打包全部
  `.tcrn-workspace`，生成 sha256 manifest 与链版本记录，保留最近 14 份，并在删除旧件前
  校验最新快照。
- 新 launchd 条目使用新 label，每 6 小时以 `--if-due` 运行；运行时显式绑定 Node 和
  PATH，退出码、本地快照新鲜度与异地推送回执均由 doctor 检查。旧 paired 条目已卸载，
  原 plist 归档在平台档案，不进入公开仓。
- 快照以 gpg 加密，密钥只使用仓外引用；通过 BatchMode 文件传输写入封存 VM 的纯文件
  落点，不进入 VM 治理面、不在 VM 运行引擎。

## 首次全流程

首次实测结果为 `CHAIN_SNAPSHOT_AND_OFFSITE_VERIFIED`：产出、sha256 校验、加密、推送、
对端取回、解密和逐字节比对均成功，回执 `readbackVerified: true`。原始命令输出保存在
平台档案；本摘要不宣称逐字复现。

## 复核摘要

- 落地前新 launchd 腿为红；安装新任务并执行一次后，doctor 的 launchd 腿为绿，最近退出
  码为 0，本地与异地回执均新鲜。
- install-manifest 与独立解耦名册同步登记新 label、快照目录和两类回执；合成临时目录
  测试覆盖参数、轮转、加密回读和失败回执，且已登记 coverage baseline。
- 当前整个平台 doctor 的唯一红腿属于 INC-160 信任档案新鲜度，按交接由 STORY-273
  处理；本单不改写信任档案。

状态：`pending-owner-acceptance`。不迁移链，不写 `.tcrn-workspace`，不推送、不打 tag、
不发版。
