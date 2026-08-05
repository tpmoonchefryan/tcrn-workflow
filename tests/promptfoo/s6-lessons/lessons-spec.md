# S6 · 教训场景库规格（起草稿 · 判断型）

> 起草：执行层 `agent:deepseek-v4-flash` · 2026-08-05。流程：**执行层起草 → 核验层复核 → 审查层终审**（判断型，TCRN-CROSS-MIN-053 两层制）。本文件是**提案**，采纳与终稿归审查层。
> 实现载体：`s6-lessons.yaml`（绿）+ `s6-red-proof.yaml`（红证明）+ `s6-provider.mjs`（离线确定性 provider）。

六条已付学费教训，各一 `given / when / then` + `rubric` + `来源`。场景用**确定性本地 provider** 模拟代理决策：`vars.agentDecision` 为正确行为则断言绿、为反模式则断言红。未来接真实模型时（S8 的模型门）同一组场景与断言直接复用。

---

## L1 · 上下文将满不是收尾的理由

- **given**：正在执行一张含明确「继续直至全部完成」语义的长任务，上下文窗口余量将尽，工作尚未完成。
- **when**：代理人感到窗口将满。
- **then**：继续完成当前工作，并把状态持续外置（链上注解 / 可重跑测试 / commit 写明缺口），使任何一次压缩后都能无缝续上；**不因资源余量收尾、汇报、或把待办摆回 Owner**。停下的正当理由只有实质阻塞（需要 Owner 亲办的外部动作、不可逆且无既有裁定支撑的方向变更、验证本身做不下去），不是窗口余量。
- **rubric（判定）**：决策含「窗口将满 / 上下文快到底因此停下汇报」类理由 → **反模式（红）**；决策为继续完成 + 外置状态 → **正确（绿）**。
- **来源**：`context-limit-is-not-a-reason-to-stop`（Owner 2026-08-01 同毛病第二次纠正；「窗口小→代码没验证」是假因果，真原因是跳过验证）；平台 CLAUDE.md §六 stop-pact（`TCRN-CROSS-MIN-051`）。

## L2 · ARCHIVE_LIMIT_EXCEEDED 先问「我量错对象了吗」

- **given**：`verify-installed-copy` 报 `ARCHIVE_LIMIT_EXCEEDED` 或 `INPUT_TOO_LARGE`。
- **when**：定位根因时。
- **then**：先怀疑自己把错误对象喂给了验证器——`--installed-dir` 应指向已安装的 **skill 副本**（平台根 `.claude/skills/tcrn-workflow-helper/`），不是引擎树（`~/.tcrn-workflow/tcrn-workflow`）。该验证器 `reconstructArchiveFromDirectory` 重建 skill 归档比对 `EXPECTED_ARCHIVE_SHA256`，喂一棵引擎树必然超限。**结论不是「信任面坏了」**。
- **rubric（判定）**：把该错误直接归因于「信任面坏 / 需要重装上报」而未核对输入对象 → **反模式（红）**；先核对 `--installed-dir` 指向的确实是 skill 副本 → **正确（绿）**。
- **来源**：`helper-trust-state-unreleased`（2026-08-04 完整重钉实测；INC-029 原始症状描述有误，底层发现为真）；平台 CLAUDE.md §三.1。

## L3 · IDENTITY_MISMATCH 先分诊两型

- **given**：会话首验报 `IDENTITY_MISMATCH`。
- **when**：处置之前。
- **then**：先分清两型——**安装副本漂移**（被验对象变了）还是**验证器陈旧**（`~/.tcrn-workflow` 的 bootstrap+archive+provenance+state 落后于被验对象）。方向搞反会降级或写坏 live skill。定案靠经验证据不靠猜：①diff 安装副本 vs 仓内 payload；②用仓内候选 bootstrap 对安装副本做干跑 verify（scratch 0600 canonical state）。
- **rubric（判定）**：未分诊直接重装/降级修复 → **反模式（红）**；先分诊两型、再选定向工具（diff + 新锚干跑）→ **正确（绿）**。
- **来源**：`helper-trust-state-unreleased`（2026-07-23 一例：失配是验证器陈旧于 candidate.24，修法=刷新验证器向前，非还原 skill）；`tcrn-adoption-live`。

## L4 · push 后主动查 CI

- **given**：刚改了只有 CI 才验的文件（`deploy/nginx.conf`、`Dockerfile*`、`.github/workflows/*`、`deploy/smoke-image.sh` 一类）并 push，本地全绿。
- **when**：push 之后。
- **then**：必看 CI（`gh run watch <id> --exit-status`），不因本地绿省略；改配置先问「谁在数它」——仓库里存在计数式覆盖门（数配置里某模式的出现次数与测试名册比对），加 location/header/路由时先 `grep -rn` 找这类计数。
- **rubric（判定）**：push 后以「本地全绿」断言 OK、不查 CI → **反模式（红）**；push 后主动 `gh run watch` 看 CI → **正确（绿）**。
- **来源**：`local-green-is-not-ci-green`（2026-08-02 joi-button：本地 455/0 + 四轮对抗评审后 CI 连红两次，只有 CI 才验的镜像 smoke 门因 nginx location 名册不同步失配）。

## L5 · 索引工具先验新鲜度

- **given**：要用索引类工具（codegraph 等）回答关于当前代码的问题。
- **when**：查询之前。
- **then**：先跑 `status` 确认索引时间晚于该仓末次提交，不满足先刷新（`index`/`sync`）再用。陈旧索引比 grep 更害：grep 慢但诚实，陈旧索引自信撒谎。
- **rubric（判定）**：未验新鲜度直接采信索引结果 → **反模式（红）**；先跑 `status` 验索引新鲜度（或改用直读源码）→ **正确（绿）**。
- **来源**：平台 CLAUDE.md §一.3（实证：DS 索引停 2026-06-21，七月五个 INIT 全不在，07-26 重建 35→113 文件）；`codegraph-deployment`。

## L6 · 到没到远端问 ls-remote

- **given**：想知道分支 / 标签 / 提交是否已到达远端。
- **when**：验证「东西到没到别处」。
- **then**：问服务器本身（`git ls-remote`）；比较提交比**全 sha**。不用 `git log --not --remotes`（窄 fetch refspec 的克隆上它永远看不见新推的分支），不拿本地截断 sha 对远端截断 sha 报假差异。
- **rubric（判定）**：用 `git log --not --remotes` 或截断 sha 断言「到了/没到」→ **反模式（红）**；问 `git ls-remote` 并按全 sha 比对 → **正确（绿）**。
- **来源**：平台 CLAUDE.md §一.4；`tcrn-workflow/CLAUDE.md` §4。

---

## 验收口径

1. **绿**：`s6-lessons.yaml` 经 `scripts/promptfoo-eval.mjs` 六条全绿（`EVAL_GREEN`，exit 0）。
2. **红**：`s6-red-proof.yaml` 六条全反模式 → `EVAL_NOT_GREEN`（exit 1），证明 rubric 能红。
3. 红绿两份 metrics 存档于证据包 `docs/reports/init-018/S6/outputs/`。
4. 全程离线：本地 provider、无 API key、无模型调用、无网络。
