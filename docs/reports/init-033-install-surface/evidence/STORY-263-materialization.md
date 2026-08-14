> 已脱敏，非逐字；原件见平台档案 `init-033-install-surface/S263-materialize.stdout.json`。

# STORY-263：平台安装面一次真实物化

## 结论

本次在一个真实本机平台容器完成了一次 materialization，未修改链、未写
`.tcrn-workspace`，也未执行任何路径迁移动作。平台容器、五个项目根和
两种宿主各得到一份由规范引擎命令产生的惰性适配器包，共 12 份安装回执。
每份回执均用对应的引擎 read API 校验；惰性包不代表宿主已经激活。

安装清单为 `tcrn.install-manifest.v1`，共 27 项、6 个根。项目名中
`joi-button` 保持精确小写。

## 主机自有面

- Claude 设置文件由 `claude-adapter-settings-fragment` 与
  `claude-adapter-settings-merge` 生成，输入来自既有平台分类设置；物化
  结果为 3935 bytes，sha256
  `44351a45f3b5e19df44f40d8bb94aed64b925727e0ba8ce620c6db506614be00`。
- MCP 注册由 Claude host CLI 完成，读回 6 个 server 名称：
  `tcrn-workflow`、`tcrn-workflow-aos-read`、`aos-mcp-write`、
  `codegraph-tms`、`codegraph-ds`、`codegraph-aos`。当前 authority
  pins bundle 未观察到，因此这里只证明注册存在，不把它写成 authority
  接受或发布许可。
- `com.tcrn.aos.paired-backup` 已加载、列出并 kickstart；触发器确实运行，
  但五个分区均以 `chain_half_is_not_live` fail-closed，未取得 pair。
  这是外部链现实的只读边界，本 Story 不碰链，也不以失败运行覆盖较强回执。

## 七项 wiring disposition

| artifact | disposition |
| --- | --- |
| `com.tcrn.aos.paired-backup` | 已按现有模板建立用户级 LaunchAgent，并完成 load/list/kickstart 读回 |
| `read-face-refresh` | pending-owner-acceptance；本次只保留 handover note，未加载 |
| `platform-runner` | pending-owner-acceptance；本次只保留 handover note，未加载 |
| `codex-config` | pending-owner-acceptance；机器级用户配置差异未代 Owner 决定 |
| `platform-claude-settings` | 作为输入比较面，最终由引擎 merge 生成 |
| `platform-mcp` | 作为注册比较面；未观察到当前 authority pins bundle |
| `user-claude-settings` | pending-owner-acceptance；用户级差异未代 Owner 决定 |

## Boundary

本证据只覆盖本机真实写入、引擎回执、host CLI 注册和 LaunchAgent 触发
读回。它不声称生产激活、真实 pair 成功、Owner acceptance、done、推送、
tag 或发布。
