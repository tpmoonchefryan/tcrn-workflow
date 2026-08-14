> 已脱敏，非逐字；原件见平台档案 `init-032-review-remediation/original/STORY-256-platform-doctor.md`。

# STORY-256 平台 doctor 证据

状态目标：`pending-owner-acceptance`；`done` 仍只属于 Owner。本单未 push、tag、deploy 或发版。

## 先红留证（修复前真实容器）

以下代码块保留 doctor 在任何平台布局修复之前、针对真实平台根运行的原始单行 JSON 输出。命令退出码为 `1`；输出指名分类夹中的 0 字节 `AGENTS.md`，同时记录当时的链容器与其它门状态。

命令：`node scripts/platform-doctor.mjs --platform-root <platform-root>`

```text
{"ok":false,"reasonCode":"PLATFORM_AGENTS_EMPTY","checks":[{"name":"platformRoot","ok":true,"path":"<platform-root>"},{"name":"platformAgents","ok":false,"reasonCode":"PLATFORM_AGENTS_EMPTY","path":"TCRN Platform/AGENTS.md","expectedPath":"AGENTS.md"},{"name":"workspaceContainer","ok":true,"path":".tcrn-workspace","partitions":["Joi-Button","TCRN-AOS","TCRN-Design-System","TCRN-TMS","cross-project"]},{"name":"containerOutsideGit","ok":true,"ancestorsChecked":4},{"name":"claudeBridge","ok":false,"reasonCode":"PLATFORM_CLAUDE_BRIDGE_MISSING","path":"CLAUDE.md"}]}
```

该输出发生在 S257 的任何仓外文件修复之前；红腿不代表 Owner 接受或发布授权。

## 实现与合成夹具

- `scripts/platform-doctor.mjs` 只从必填 `--platform-root` 读取容器根；公开源码不含任何本机根、用户名或主机标识。
- 检查顺序固定为平台根、平台 `AGENTS.md`、链容器、Git 祖先、`CLAUDE.md` 转接；首次失败给出稳定 `reasonCode`，同时保留逐项 `checks`。
- `tests/platform-doctor.test.mjs` 使用合成临时目录，覆盖 1 个绿夹具与 7 个红/边界夹具：空/缺失 `AGENTS.md`、缺链容器、容器落在 Git 祖先内、缺 `CLAUDE.md`、错层空 `AGENTS.md`、缺必填参数。空文件测试是非空判定的 load-bearing red leg。

复核命令：`node --test tests/platform-doctor.test.mjs`

```text
✔ a complete synthetic platform container is green (6.583417ms)
✔ an empty platform AGENTS.md is a load-bearing red leg (2.60725ms)
✔ a missing platform AGENTS.md is named separately (3.691917ms)
✔ a missing chain container is a distinct red leg (8.752875ms)
✔ a container inside Git ancestry is refused (8.52875ms)
✔ a missing Claude bridge is named separately (9.345792ms)
✔ an empty misplaced AGENTS.md remains visible before the root is repaired (5.198209ms)
✔ a missing --platform-root argument fails closed (0.088084ms)
ℹ tests 8
ℹ pass 8
ℹ fail 0
```

`node scripts/coverage-conservation.mjs` 当前回执：`COVERAGE_CONSERVATION_VERIFIED`，baseline completeness `expectedFiles=94`, `currentFiles=94`, `missingFiles=[]`, `staleFiles=[]`。新测试文件已登记在 `scripts/policy/coverage-baseline.json`；`node scripts/task.mjs source` 当前回执为 `SOURCE_ALLOWLIST_VERIFIED`（`files=538`, `exactEntries=538`）。

公开布局正本 `docs/platform-container-layout.md` 的本机路径/用户名/邮箱扫描无匹配；该扫描只针对正本，不把脱敏前的红证从平台档案中抹掉。
