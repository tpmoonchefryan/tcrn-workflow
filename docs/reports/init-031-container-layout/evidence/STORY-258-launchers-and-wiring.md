> 已脱敏，非逐字；原件见平台档案 `init-032-review-remediation/original/STORY-258-launchers-and-wiring.md`。

# STORY-258 启动器、档案定名与接线事实证据

状态目标：`pending-owner-acceptance`；`done` 仍只属于 Owner。本单未 push、tag、deploy 或发版。

## 启动器再生成与替换

当前仓内引擎 `tcrn-workflow/package.json` 为 `0.11.15`；原三个启动器指向的旧安装副本 `~/.tcrn-workflow/tcrn-workflow` 读回为 `0.11.14`，所以不是“现位即正位”，而是需要同质再生成。使用显式容器、prose 与输出目录生成，避免把临时对照件写回仓库：

```text
node portal/scripts/generate-launchers.mjs --container <platform-root>/.tcrn-workspace --output-dir <synthetic-temp-dir> --prose-root <platform-root>/TCRN Platform --port 4319
```

生成器回执为 `PORTAL_LAUNCHERS_GENERATED`，`symlinks=false`，三文件齐全。旧件与对照件的功能参数（`--container`、`--prose-root`、`--port`）一致，差异只在 portal 绝对入口指向旧安装副本或当前 `0.11.15` 仓内入口；`.cmd` 先按 CRLF 语境归一后再比较。按当前引擎对照件替换后，三文件分别与对照件字节相同：

| 文件 | 字节 | SHA-256 | 模式 |
| --- | ---: | --- | --- |
| `tcrn-workflow-portal.command` | 475 | `bd94c2ff56d1e0592393c70e9634d325d1af4951ac35237712861df2d63ba75c` | `755` |
| `tcrn-workflow-portal.sh` | 475 | `bd94c2ff56d1e0592393c70e9634d325d1af4951ac35237712861df2d63ba75c` | `755` |
| `tcrn-workflow-portal.cmd` | 505 | `d471f160482269e827f0de57a46f23b32e83d0b5763cf7c139cbc8079db04ea3` | `644`, CRLF |

## `.command` 实际启动与回收

实测 `<platform-root>/tcrn-workflow-portal.command` 一次，拉起后立即通过受控 `TERM` 回收并确认 `4319` 无残留 listener。启动输出：

```text
{"reasonCode":"PORTAL_LISTENING","url":"http://127.0.0.1:4319/","workspace":"<platform-root>/.tcrn-workspace/cross-project/workspace","container":"<platform-root>/.tcrn-workspace","partitionMode":true,"selectedPartition":"cross-project","proseRoot":"<platform-root>/TCRN Platform","actor":"agent:portal","cli":"<platform-root>/TCRN Platform/tcrn-workflow/scripts/tcrn-workflow.mjs"}
launcher_exit_probe=started_and_killed
```

随后 `lsof -nP -iTCP:4319 -sTCP:LISTEN` 无输出；未使用文件删除来回收进程。

## `.tcrn-artifacts` 定名事实表

平台根 `.tcrn-artifacts` 顶层 `find` 实测十项，已在本机 `AGENTS.md` 附录逐项定名：

| 名称 | 一行角色说明 |
| --- | --- |
| `aos-domain-archive` | AOS domain retained archive |
| `appsupport-legacy-2026-07` | legacy application-support materializations/evidence/keys/trust/transient/workspace records |
| `governance-archive` | historical ceremony receipts/session exports/governance archive |
| `legacy-archive` | pre-current-engine legacy archive |
| `observe` | retained observe and telemetry artifacts |
| `outer-git-backup-20260615` | outer Git metadata backup |
| `portal-repo-archived-2026-08-12` | archived portal repository snapshot |
| `pre-cleaninstall-wiring` | pre-clean-install wiring references |
| `premove-backup-2026-08-12` | pre-move backup with manifests and workspace snapshot material |
| `vacated-container-2026-08-12` | retained vacated-container snapshot by partition and trust root |

No archive ownership decision was made and no archive bytes were changed.

## 宿主接线事实表

逐目录 `lstat` 实测五个项目根的 `.claude`、`.mcp.json`、`.codex`：

| 项目根 | `.claude` | `.mcp.json` | `.codex` |
| --- | --- | --- | --- |
| `TCRN Platform/` | directory | file | directory |
| `TCRN Platform/TCRN-AOS/` | directory | absent (`ENOENT`) | absent (`ENOENT`) |
| `TCRN Platform/TCRN-Design-System/` | directory | absent (`ENOENT`) | absent (`ENOENT`) |
| `TCRN Platform/TCRN-TMS/` | directory | absent (`ENOENT`) | absent (`ENOENT`) |
| `joi-button/` | absent (`ENOENT`) | absent (`ENOENT`) | absent (`ENOENT`) |

这些是会话启动目录级/项目根级接线，不是平台容器级接线。`joi-button`
是否补建接线属于该项目自己的决定，本批只记录不行动。

## 待裁方向题

当前源仓生成器的默认 `outputDir` 仍由其源码仓父目录推导；本批按交接书使用显式 `--output-dir` 完成对照与替换，没有擅自改变生成器默认值。是否把默认值作为后续公共契约调整，连同正本与本机实景的差异处置，一并留给 Owner。
