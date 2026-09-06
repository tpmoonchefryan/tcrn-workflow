<div align="center">

# TCRN Workflow

### Agent 说「做完了」。这套框架让它交出你能自己复核的证据

**面向 AI Agent 交付的治理框架。它声称的每一项能力，都绑定一条能被机器证伪的判据——判据失效，构建就红。**

![license](https://img.shields.io/badge/license-Apache--2.0-lightgrey?style=flat-square) ![node](https://img.shields.io/badge/node-24.16.0-informational?style=flat-square) ![pnpm](https://img.shields.io/badge/pnpm-11.3.0-informational?style=flat-square) ![network](https://img.shields.io/badge/network-none-important?style=flat-square) ![hosts](https://img.shields.io/badge/hosts-Claude%20Code%20%C2%B7%20Codex-blueviolet?style=flat-square)

[你现在的处境](#你现在的处境) · [它凭什么值得信](#它凭什么值得信) · [给谁用](#给谁用) · [你能拿到什么](#你能拿到什么) · [三分钟上手](#三分钟上手) · [当前状态](#当前状态) · [完整文档](#完整文档)

`Verified claims: 7 (hygiene 7 · inertness 0 · runtime 0)`

</div>

<table>
<tr>
<td align="center" width="25%">

### 15
道 P1 门<br><sub>一条命令跑完，任何一处意外就停</sub>

</td>
<td align="center" width="25%">

### 7
条判据<br><sub>每条挂在一道仍在跑的门上</sub>

</td>
<td align="center" width="25%">

### 31
个守卫<br><sub>逐个改坏，要求测试变红</sub>

</td>
<td align="center" width="25%">

### 0
运行时依赖<br><sub>不联网，不装数据库</sub>

</td>
</tr>
</table>

> [!TIP]
> **不必相信这份 README**。装上之后跑一条命令，它会把自己的 7 条声称逐条证明给你看，全程离线。

---

## 你现在的处境

Agent 改了三十个文件，然后告诉你测试全绿。

你只有两个选择：逐个复核，那你用 Agent 是为了什么；或者相信它，那你在赌。等到有人问「这个能上线吗」，你当场拿得出的东西，决定了这是十分钟的事还是一整天的事。

TCRN Workflow 给你第三个选择。

| 你想确认的 | ✗ 你现在有的 | ✓ 装上之后你有的 |
| :--- | :--- | :--- |
| **测试真的跑过吗** | 聊天窗口里的一行字 | `pnpm verify:p1`——15 道门按序跑完，任何一处意外就停下 |
| **谁在什么时候改了什么** | 翻聊天记录 | 哈希相扣的事件链，只能追加。改掉历史里任何一条，后面全部对不上 |
| **保护措施还在起作用吗** | 假设还在 | `pnpm guard-check`——31 个守卫逐个从源码里改坏，要求各自的测试变红 |
| **拿到的字节是不是发布的字节** | 看标签 | 产物逐字节重建，与公开摘要比对 |

---

## 它凭什么值得信

同一套标准，这套框架先用在自己身上。

`pnpm guard-check` 把 **31 个已注册守卫逐个从源码里移除或改坏**，然后要求这个守卫对应的那个测试变红。31 个全部变红，这一轮才算通过。

它证明的不是「我们写过这些检查」，而是「这些检查此刻仍然在拦人」。一个坏掉了却没人发现的检查，和没有这个检查是同一件事。

这个标准覆盖全部 **7 条声称**。每一条都在 `verification-map.yaml` 里绑定一个稳定的原因码、一条能离线跑的证明、一条红腿——写明什么改动会让它变红——以及它挂在哪一类门上（`requirement`）或哪一次事故（`incident`）。7 条，无一例外。

这个数字在 TCRN-CROSS-STORY-359 之前是 102。判据本身没有被降级：退役的 95 条每一条都测量一个当时被撤掉的 `verify:*` 名字，而它们点名的测试文件一个没删，仍在 `pnpm test` 里逐个跑。撤掉的是同一件事的第二份账本。

<details>
<summary><b>7 条判据是怎么分布的</b></summary>

<br>

| 类别 | 条数 | 管什么 |
| :--- | ---: | :--- |
| `framework-hygiene` | 7 | 框架自身的卫生：干净历史、许可与漏洞策略、离线边界、隐私扫描、隔离检出、发行候选 |
| `inertness-proof` | 0 | 空：这一类的判据都挂在 STORY-359 撤掉的 `verify:*` 名字上；它们点名的测试仍在 `pnpm test` 里跑 |
| `runtime-capability` | 0 | 同上 |

完整清单在 `verification-map.yaml`，每条带 `id`、`command`、`fixturePaths`、红腿，以及 `requirement` 或 `incident` 之一。

</details>

> [!IMPORTANT]
> 判据的覆盖范围改了却没重新证明，构建会失败。这不是风格问题，是硬性的。

---

## 给谁用

| ✓ 适合你，如果 | ✗ 不适合你，如果 |
| :--- | :--- |
| 你让 Agent 做有后果的事：生产代码、需要留痕的交付、多个 Agent 接力而没人记得决定是谁下的。 | 你想要一个零配置的聊天助手，装完就能用。 |
| 你要交给复核人的是一份能重跑的产物，不是一段需要相信的对话记录。 | 你需要云同步、托管看板、团队协作视图。 |
| 你要求全部留在本机：不装数据库，不起守护进程，不联网，不发遥测。 | 你的工作还在探索阶段，只追加的审计轨迹此刻是负担而不是价值。 |

---

## 你能拿到什么

| 你拿到 | 具体是什么 |
| :--- | :--- |
| **一个只由文件组成的工作区** | Initiative → Epic → Story → Subtask 的整张工作图，是规范格式的 JSON 加一条哈希链。用 `cat` 和 `sha256sum` 就能审，导出逐字节可复现。 |
| **一条命令跑完 15 道门** | `pnpm verify:p1` 依次跑格式、lint、类型、构建、119 个测试文件（含覆盖注册表与存活模块覆盖检查）、门户校验、源码白名单、源码归档、兄弟仓依赖、离线边界、工具链治理（许可、生命周期、漏洞策略、干净历史）、隐私扫描、判据账本、证明预算、文档链接。 |
| **7 条机器可读的判据** | 全部框架卫生，全部带红腿，全部绑定可观测的原因码，并各自挂在十一类门中的一类上。 |
| **会自证有效的守卫** | 31 个守卫，`pnpm guard-check` 逐个改坏并要求对应测试变红。 |
| **86 个受治理的 CLI 动词** | 全部本地执行。每次写入都要声明它基于哪个版本，别人先写了就拒绝，不会静默覆盖。 |
| **零运行时依赖** | `package.json` 的 `dependencies` 与 `optionalDependencies` 都是空的。开发模式额外装一个进程级网络守卫，遥测为零。 |

---

## 三分钟上手

需要固定版本的工具链：**Node 24.16.0** 与 **pnpm 11.3.0**。依赖的生命周期脚本全程关闭，安装过程不执行任何第三方代码。

```sh
# 1. 装固定版本的开发依赖，冻结锁文件，不跑脚本
pnpm install --offline --frozen-lockfile --ignore-scripts

# 2. 让框架自己证明一遍：15 道门，全程离线
pnpm verify:p1

# 3. 构建，然后用受治理的 CLI
pnpm build
node scripts/tcrn-workflow.mjs commands
```

<details>
<summary><b>常用的受治理命令</b></summary>

<br>

全部本地执行，不联网，不需要数据库。

```sh
# 校验工作区并生成确定性视图
node scripts/tcrn-workflow.mjs validate --workspace <路径>

# 新建工作记录，写入带版本校验
node scripts/tcrn-workflow.mjs work-create --workspace <路径> --expected-version <版本> ...

# 按主题检索工作记录
node scripts/tcrn-workflow.mjs work-list --workspace <路径> --search "<关键词>"
```

</details>

> [!NOTE]
> 能力清单以 `commands` 的输出为准，不以任何文档为准。文档可能落后于代码，命令目录不会。

---

## 当前状态

当前受理版本是 **1.0.1**。每个受理版本都是一个不可变的标签加一套可复现的产物，`CHANGELOG.md` 是完整账本。

对外发布、推送、打标签是各自独立的关卡，不从本地测试推导。外部使用者通过配套的 `tcrn-workflow-helper` 校验发行字节，它自己的引导器摘要单独公开，可以独立核对。

已知的边界写在 Wiki 的「已知限制」页：单工作区单写者、事件规模上限、恢复只支持原路径。这些是设计决定，不是待办事项。

## 完整文档

架构总览、命令参考、判据与门、仓库布局、已知限制、常见问答，都在本仓库的 GitHub Wiki，从仓库页面顶部的 **Wiki** 标签进入。

[参与贡献](./CONTRIBUTING.md) · [安全策略](./SECURITY.md) · [隐私说明](./PRIVACY.md) · [行为准则](./CODE_OF_CONDUCT.md) · [支持](./SUPPORT.md)

## 许可

Apache-2.0。见 [LICENSE](./LICENSE) 与 [NOTICE](./NOTICE)。
