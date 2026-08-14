> 已脱敏，非逐字；原件见平台档案 `init-032-review-remediation/original/STORY-257-platform-agents.md`。

# STORY-257 平台 AGENTS.md 与转接证据

状态目标：`pending-owner-acceptance`；`done` 仍只属于 Owner。本单未 push、tag、deploy 或发版。

## 写入前门

在写入分类夹转接前重新确认：`<platform-root>/TCRN Platform/AGENTS.md` 仍为 `0` 字节；同一快照下 `<platform-root>/TCRN Platform/CLAUDE.md` 为 `11` 字节的旧 `@AGENTS.md` 转接。随后才重写两处转接，并在容器根创建本机实例。

## 交付物

- `<platform-root>/AGENTS.md`：平台身份、三层边界、`## 三、分区拓扑` 六行拓扑、跨仓公约指针、纪律摘要、`.tcrn-artifacts` 十项实测清单与待裁 notes。
- `<platform-root>/CLAUDE.md`：`@AGENTS.md`，把容器根规则桥接到所有后代会话。
- `<platform-root>/TCRN Platform/AGENTS.md`：非重复散文转接，指向 `../AGENTS.md`。
- `<platform-root>/TCRN Platform/CLAUDE.md`：`@../AGENTS.md`。
- `Joi-Button` 分区到目录的映射逐字为 `joi-button`，没有使用大小写折叠路径。

## doctor 红转绿

命令：`node scripts/platform-doctor.mjs --platform-root <platform-root>`

```text
{"ok":true,"reasonCode":"PLATFORM_LAYOUT_HEALTHY","checks":[{"name":"platformRoot","ok":true,"path":"<platform-root>"},{"name":"platformAgents","ok":true,"path":"AGENTS.md","marker":"## 三、分区拓扑"},{"name":"workspaceContainer","ok":true,"path":".tcrn-workspace","partitions":["Joi-Button","TCRN-AOS","TCRN-Design-System","TCRN-TMS","cross-project"]},{"name":"containerOutsideGit","ok":true,"ancestorsChecked":4},{"name":"claudeBridge","ok":true,"path":"CLAUDE.md"}]}
```

该绿腿与 STORY-256 的先红输出组成同一 doctor 弧线；它只证明本机文件布局门，不证明 Owner 接受、发布或第三方账户事实。

## 六分区逐条复查

以下均为写入后逐条运行的只读命令，六条均退出 `0`，引擎均为 `0.11.15`：

```text
cross-project: {"engineVersion":"0.11.15","headEventHash":"2a8054ee272e876bed59f45cb4844f9107bc097af5354ead8a035d7b3a108179","projects":1,"reasonCode":"WORKSPACE_COMMAND_COMPLETED","storageHome":null,"version":3413,"work":525,"workspaceId":"workspace:7732a51de4c38afb83bb77cf"}
TCRN-AOS: {"engineVersion":"0.11.15","headEventHash":"ddba691af58380b8660875e9dda4478b5a1d8a3014db5da99a0233076dfe31f0","projects":1,"reasonCode":"WORKSPACE_COMMAND_COMPLETED","storageHome":null,"version":1050,"work":156,"workspaceId":"workspace:fbc32e3ff874fbbd637a1b85"}
TCRN-Design-System: {"engineVersion":"0.11.15","headEventHash":"28b3ef6546a70a7f2684eff2aea10c4ad5b63ce15addff4a127ed74ac38b49be","projects":1,"reasonCode":"WORKSPACE_COMMAND_COMPLETED","storageHome":null,"version":985,"work":166,"workspaceId":"workspace:e7386bdcff8b3407e43ece51"}
TCRN-TMS: {"engineVersion":"0.11.15","headEventHash":"c55e05ca599d933def967b39028d9ce529e3792206f680f60e06507def651ecf","projects":1,"reasonCode":"WORKSPACE_COMMAND_COMPLETED","storageHome":null,"version":229,"work":39,"workspaceId":"workspace:f15c5abb6cd777c44453c2c9"}
Joi-Button: {"engineVersion":"0.11.15","headEventHash":"7963e80384012dfa5559543bdf70b06bf0ca9bbab8dda79f229e2c0de215d467","projects":1,"reasonCode":"WORKSPACE_COMMAND_COMPLETED","storageHome":null,"version":1169,"work":165,"workspaceId":"workspace:f4edc54804be7e499804e3f0"}
release-trust: test -d <platform-root>/.tcrn-workspace/release-trust -> exit 0
```

The `release-trust` row is recorded as a shared trust root and not counted as
a project partition. The engine references in `tcrn-workflow/AGENTS.md` remain
semantically accurate; no unrelated wording or chain data was changed.
