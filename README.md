<div align="center">

# TCRN Workflow

### 让代理的「我做完了」变成一份你能自己复核的证据

**面向 AI 代理交付的治理框架。它声称的每一项能力，都是一条能被机器证伪的判据。**

简体中文 · [English](./README.en.md) · [日本語](./README.ja.md) · [한국어](./README.ko.md) · [Français](./README.fr.md)

![status](https://img.shields.io/badge/status-1.0.1-blue) ![gates](https://img.shields.io/badge/verify%3Ap1-24%20gates-brightgreen) ![claims](https://img.shields.io/badge/proven%20claims-122-brightgreen) ![deps](https://img.shields.io/badge/runtime%20deps-0-success)

![license](https://img.shields.io/badge/license-Apache--2.0-lightgrey) ![node](https://img.shields.io/badge/node-24.16.0-informational) ![pnpm](https://img.shields.io/badge/pnpm-11.3.0-informational) ![network](https://img.shields.io/badge/network-none-important) ![hosts](https://img.shields.io/badge/hosts-Claude%20Code%20%C2%B7%20Codex-blueviolet)

[它解决什么](#它解决什么) · [给谁用](#给谁用) · [你能拿到什么](#你能拿到什么) · [三分钟上手](#三分钟上手) · [一个真实例子](#一个真实例子) · [当前状态](#当前状态) · [完整文档](#完整文档)

`Verified claims: 122 (hygiene 20 · inertness 13 · runtime 89)`

</div>

---

## 它解决什么

代理告诉你测试通过了。你手上只有聊天窗口里的一行字。

TCRN Workflow 把这行字换成三样能复核的东西。

- **一本判据账本。** 框架声称的每一项能力，都在 `verification-map.yaml` 里对应一条判据，绑定一个稳定的原因码，由一个能离线跑的测试证明。
- **一条防篡改的事件链。** 工作区的每一次改动都是链上一条记录，逐条哈希相扣，只能追加，历史改不了。
- **一套可复现的发布。** 每个版本都能逐字节重建，并与公开的摘要比对。

判据的覆盖范围改了却没重新证明，构建会失败。这不是风格问题，是硬性的。

## 给谁用

| | |
| --- | --- |
| **适合** | 你让代理做有后果的事：生产代码、需要留痕的交付、多个代理接力而没人记得是谁做的决定。你要的是一份复核人能核对的产物，不是一段需要相信的对话记录。你要求全部留在本机，不装数据库，不起守护进程，不联网，不发遥测。 |
| **不适合** | 你想要零配置的聊天助手，或者需要云同步与托管看板，或者你的工作还在探索阶段，只追加的审计轨迹对你是负担而不是价值。 |

## 你能拿到什么

| 你拿到 | 具体是什么 |
| --- | --- |
| **一个只由文件组成的工作区** | Initiative → Epic → Story → Subtask 的整张工作图，是规范格式的 JSON 加一条哈希链。用 `cat` 和 `sha256sum` 就能审，导出逐字节可复现。 |
| **一条命令跑完 24 道门** | `pnpm verify:p1` 依次跑格式、lint、类型、构建、134 个测试文件、信任矩阵、归档与 SBOM 与许可与漏洞策略、源码白名单、离线边界、隐私扫描、CI 加固、判据账本、干净历史。任何一处意外都会停下。 |
| **122 条机器可读的判据** | `verification-map.yaml` 把 122 条判据绑到可观测的原因码上：20 条框架卫生、13 条惰性证明、89 条运行时能力。122 条全部带红腿，即每条都写明了什么改动会让它变红，而且那次变红是实测过的。 |
| **会自证有效的守卫** | `pnpm guard-check` 把 61 个守卫逐个从源码里改坏，要求对应的测试变红。 |
| **137 个受治理的 CLI 动词** | 全部本地执行。每次写入都要声明它基于哪个版本，别人先写了就拒绝，不会静默覆盖。 |
| **零运行时依赖** | `package.json` 的 `dependencies` 与 `optionalDependencies` 都是空的。开发模式还会装一个进程级网络守卫，遥测为零。 |

## 三分钟上手

需要固定版本的工具链：Node 24.16.0 与 pnpm 11.3.0。依赖的生命周期脚本全程关闭，安装过程不执行任何第三方代码。

```sh
# 1. 装固定版本的开发依赖，冻结锁文件，不跑脚本
pnpm install --offline --frozen-lockfile --ignore-scripts

# 2. 让框架自己证明一遍：24 道门，全程离线
pnpm verify:p1

# 3. 构建，然后用受治理的 CLI
pnpm build
node scripts/tcrn-workflow.mjs commands
```

常用的受治理命令，全部本地，不联网，不需要数据库：

```sh
# 校验工作区并生成确定性视图
node scripts/tcrn-workflow.mjs validate --workspace <路径>

# 新建工作记录，写入带版本校验
node scripts/tcrn-workflow.mjs work-create --workspace <路径> --expected-version <版本> ...

# 按主题检索工作记录
node scripts/tcrn-workflow.mjs work-list --workspace <路径> --search "<关键词>"
```

## 一个真实例子

`pnpm guard-check` 会把 61 个已注册守卫逐个从源码里移除或改坏，然后要求这个守卫对应的那个测试变红。61 个全部变红，这一轮才算通过。

这证明的是：这些保护措施现在仍然在起作用，而不是曾经写过。一个坏掉了也没人发现的检查，和没有这个检查是一回事。

## 当前状态

当前受理版本是 1.0.1。每个受理版本都是一个不可变的标签加一套可复现的产物，`CHANGELOG.md` 是完整账本。

对外发布、推送、打标签是各自独立的关卡，不从本地测试推导。外部使用者通过配套的 `tcrn-workflow-helper` 校验发行字节，它自己的引导器摘要单独公开，可以独立核对。

已知的边界写在 Wiki 的「已知限制」页里，包括单工作区单写者、事件规模上限、以及恢复只支持原路径。这些是设计决定，不是待办事项。

## 完整文档

架构总览、命令参考、判据与门、仓库布局、已知限制、常见问答，都在本仓库的 GitHub Wiki，从仓库页面顶部的 Wiki 标签进入。

[参与贡献](./CONTRIBUTING.md) · [安全策略](./SECURITY.md) · [隐私说明](./PRIVACY.md) · [行为准则](./CODE_OF_CONDUCT.md) · [支持](./SUPPORT.md)

## 许可

Apache-2.0。见 [LICENSE](./LICENSE) 与 [NOTICE](./NOTICE)。
