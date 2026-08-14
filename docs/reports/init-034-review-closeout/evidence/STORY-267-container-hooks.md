已脱敏：本文件不含本机路径、用户名或主机标识；原始证据仅存平台档案。

# STORY-267：容器根 hook

## 结果

修复前的真机 doctor 以 `PLATFORM_HOOK_TARGET_UNAVAILABLE` 变红；四个事件
都把容器根直接展开成不存在的 `tcrn-workflow` 目录。红输出见
`S267-doctor-red.stdout.json`。

根 settings 通过规范 Claude adapter remove/merge 动词族读改，四条 hook
统一绑定到分类文件夹下的工作流脚本：PreToolUse、SessionStart、Stop、
UserPromptSubmit。等价触发 harness 四事件均 exit 0；SessionStart 与
UserPromptSubmit 返回合法 hook JSON，Stop 与 PreToolUse 无错误输出。原始
触发记录见 `S267-hooks-green.stdout.json`。

修复后 doctor 的 hook 腿为 green，真机总体只剩 launchd 失败腿；没有手写
adapter bundle、没有触碰链或 `.tcrn-workspace`。

## 验证

```text
node --test tests/platform-doctor.test.mjs
```

合成夹具覆盖四事件绿腿、缺目标红腿，以及 settings 缺失时仍归 install
wiring 的红腿。目标路径由传入的 `--platform-root` 展开，未硬编码本机根。

## Boundary

该单证明静态目标可用与等价 harness 触发；不把 harness 当作真实宿主会话、
宿主批准、Owner acceptance、`done`、push、tag 或发布。
