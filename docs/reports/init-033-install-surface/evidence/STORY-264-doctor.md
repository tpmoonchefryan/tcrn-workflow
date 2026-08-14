> 已脱敏，非逐字；原件见平台档案 `init-033-install-surface/S264-doctor-red.stdout.json` 与 `S264-doctor.stdout.json`。

# STORY-264：平台安装完备性 doctor

## 结论

doctor 现在要求调用方显式传入 `--platform-root`，不包含个人平台路径。
它从 `install-manifest` 读取安装接线，不维护第二份路径表；清单中的
`joi-button` 使用精确小写目录名。

对合成临时夹具分别制造并验证了四个红腿：

- `PLATFORM_INSTALL_WIRING_INCOMPLETE`
- `PLATFORM_DEPLOYMENT_STALE`
- `PLATFORM_HELPER_COPIES_INCOMPLETE`
- `PLATFORM_LAUNCHD_NOT_ON_DUTY`

临时夹具的红输出不依赖本机目录，测试完成后由夹具清理。新鲜度腿只作为
可满足的健康判据，不挂入发布列车。

## 真机读回

在平台根占位符上重新运行：

```
PLATFORM_LAYOUT_HEALTHY
platformRoot, platformAgents, workspaceContainer, containerOutsideGit,
claudeBridge, installWiring, deploymentFreshness, helperCopies, launchd = green
installWiring itemCount = 19, source = install-manifest
deployment versions = engine 0.11.15 / Claude helper 0.11.15 / Codex helper 0.11.15
launchd requiredLabel = com.tcrn.aos.paired-backup
```

首次真机运行曾诚实地红在 `project.joi-button.claude-settings` 缺失；随后
用规范引擎 `claude-adapter-settings-merge` 生成该项目设置，再独立重跑
doctor 得到上述绿态。这一修复没有手写适配器包，也没有触碰链或
`.tcrn-workspace`。

## Boundary

该 doctor 证明布局与安装面的静态存在性、版本新鲜度和 LaunchAgent 在岗；
它不证明宿主批准、真实业务触发成功、Owner acceptance、done、推送、tag
或发布。
