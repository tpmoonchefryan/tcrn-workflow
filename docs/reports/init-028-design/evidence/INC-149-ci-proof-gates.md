# INC-149 — CI 条件下三门不空转

状态：实现完成，待 Owner 验收。

## 交付指针

- `portal/scripts/i18n-proof.mjs` 不再读取同级 `../TCRN-Design-System` 才能判定，也不再有 `skip + exit 0`；默认使用签入的 `portal/locale-contract.mjs` 快照。`TCRN_PORTAL_LOCALES_SOURCE` 仅用于测试期注入变异 locale。
- `scripts/policy/coverage-baseline.json` 是签入式 `tcrn.coverage-baseline.v1`，保留 HEAD 的 87 个基线文件并加入本批新增的 6 个测试文件，共 93 个覆盖面文件；每项带 `testCount`、`assertionCount` 与可执行的 `testNames`。门不再拿 `git show HEAD:<当前路径>` 与自己比较。
- `scripts/coverage-conservation.mjs` 将 test 数损失、assertion 损失和 coverage-surface 完整性分开判定；新建测试文件不更新基线会以文件名红出。assertion-only loss 不再被 `[].every(...)` 短路；name-based waiver 分支由 `testNames` 真正供给。waiver 的 `path/testName/reason/replacement` 均要求非空。
- `scripts/verify-portal.mjs` 保持 portal:test → portal:proof → coverage gate → coverage self-test → verbatim evidence proof 串行；`portal/tests/portal.test.mjs` 的已有 enum 负例在无外部 DS 时仍能自洽。

## 元判据一：无 DS clean checkout 的真实失译必须红

下面的命令形态和 174/870 输出是整改开始时隔离副本的**历史 red-leg 摘录**，
不是当前最终树的逐字回读；因此已显式标为 `excerpt`，不再把临时 harness
变量写成当前交付仓的可执行命令。当前最终树的真实 `legs`、190/950 和
148 数字由后面的 `verbatim:` 块重跑确认。

复核在临时 clean worktree 副本完成：提交后 `CLEAN_GIT_STATUS=` 为空，`DESIGN_SYSTEM_PRESENT=no`；只在测试副本注入运行期 locale 变异：删除 ja 的 `receipt.title`，不改静态 grep 文本。

命令形态：

```excerpt
TCRN_PORTAL_LOCALES_SOURCE=/tmp/missing-locales.js \
TCRN_WORKFLOW_CLI=/tmp/<clean-checkout>/scripts/tcrn-workflow.mjs \
node /tmp/<clean-checkout>/portal/scripts/i18n-proof.mjs
```

原始关键输出：

```excerpt
CLEAN_GIT_STATUS=
DESIGN_SYSTEM_PRESENT=no
{
  "ok": false,
  "reasonCode": "I18N_CONTRACT_VIOLATION",
  "legs": [
    {
      "leg": "contract-snapshot",
      "ok": true,
      "reasonCode": "I18N_CONTRACT_SNAPSHOT_READY",
      "source": "portal/locale-contract.mjs"
    },
    {
      "leg": "key-coverage",
      "ok": false,
      "reasonCode": "TRANSLATION_MISSING",
      "keyCount": 174,
      "localeCount": 5,
      "expectedStrings": 870,
      "gaps": [
        {
          "locale": "ja",
          "key": "receipt.title",
          "reason": "missing"
        }
      ]
    },
    {
      "leg": "key-reachability",
      "ok": true,
      "reasonCode": "EVERY_LOCALE_KEY_REACHABLE"
    }
  ]
}
CLEAN_I18N_EXIT=1
```

该输出来自 clean checkout 的运行期 `window.PORTAL_LOCALES` 变异；没有 DS 源时仍是明确失败，不会出现 `skipped:true` 或 `I18N_CONTRACT_SOURCE_ABSENT`。

## 元判据二：保留 test 名、抽空 assertion 必须红

变异输入只保留 `tests/s213-settings.test.mjs` 的两个 test 名，令当前断言数为 0；基线仍是签入 manifest。

命令：

```excerpt
TCRN_COVERAGE_CURRENT_OVERRIDE=/tmp/init028-inc149-coverage-assertion-only.json \
node scripts/coverage-conservation.mjs
```

原始目标报告与进程输出：

```excerpt
{
  "ok": false,
  "reasonCode": "COVERAGE_CONSERVATION_VIOLATION",
  "baselinePath": "scripts/policy/coverage-baseline.json",
  "waiverProblems": [],
  "target": {
    "path": "tests/s213-settings.test.mjs",
    "baseline": {
      "testCount": 2,
      "assertionCount": 20
    },
    "current": {
      "testCount": 2,
      "assertionCount": 0
    },
    "removedTests": [],
    "unwaivedTests": [],
    "testCountLoss": 0,
    "testCountWaived": false,
    "assertionLoss": 20,
    "assertionWaived": false,
    "ok": false
  }
}
PROOF_EXIT=1
```

## 元判据三：无 DS 的健康树必须绿

同一类临时 clean checkout 副本（常规 `node_modules` 仅为测试运行时复制，分发产物没有 linkedom 运行时依赖）执行：

```excerpt
CI=true \
TCRN_DESIGN_SYSTEM_TOKENS=/tmp/no-design-system/tokens.css \
TCRN_COPY_STATE_SOURCE=/tmp/no-design-system/copy-state.ts \
pnpm --dir /tmp/<clean-checkout> verify:portal
```

原始尾部输出：

```excerpt
ℹ tests 3
ℹ pass 3
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
{"ok":true,"reasonCode":"PORTAL_VERIFY_TRAIN_GREEN","commands":[["pnpm","portal:test"],["pnpm","portal:proof"],["node","scripts/coverage-conservation.mjs"],["node","tests/coverage-conservation.test.mjs"],["node","scripts/coverage-conservation-proof.mjs"],["node","scripts/verbatim-evidence-proof.mjs","--check"],["node","scripts/verbatim-evidence-meta-proof.mjs"]]}
CLEAN_VERIFY_EXIT=0
```

上面的元判据一和健康树块是历史复现的摘录，明确标为 `excerpt`，不冒充
当前 HEAD 的逐字输出。当前实现的 i18n 读回统一走真实 `legs` 容器；下面的
`verbatim:` 块由 INC-156 机械脚本每次在当前树重跑并逐字比对：

```verbatim:node scripts/verbatim-evidence-proof.mjs inc149-i18n-current
{
  "sourceCommand": "node portal/scripts/i18n-proof.mjs",
  "ok": true,
  "reasonCode": "I18N_CONTRACT_SATISFIED",
  "legs": [
    {
      "leg": "contract-snapshot",
      "ok": true,
      "reasonCode": "I18N_CONTRACT_SNAPSHOT_READY",
      "source": "portal/locale-contract.mjs"
    },
    {
      "leg": "locale-set",
      "ok": true,
      "reasonCode": "LOCALE_SET_MATCHES_CONTRACT",
      "missingLocales": [],
      "extraLocales": []
    },
    {
      "leg": "key-coverage",
      "ok": true,
      "reasonCode": "EVERY_KEY_TRANSLATED",
      "keyCount": 190,
      "localeCount": 5,
      "expectedStrings": 950,
      "gaps": []
    },
    {
      "leg": "translation-reality",
      "ok": true,
      "reasonCode": "TRANSLATIONS_DIFFER_FROM_ENGLISH",
      "addedKeyCount": 0,
      "gaps": []
    },
    {
      "leg": "translation-full-table",
      "ok": true,
      "reasonCode": "FULL_LOCALE_TABLE_TRANSLATED",
      "baselineEqualCount": {
        "zh-CN": 33,
        "ja": 21,
        "ko": 21,
        "fr": 21
      },
      "problems": []
    },
    {
      "leg": "key-reachability",
      "ok": true,
      "reasonCode": "EVERY_LOCALE_KEY_REACHABLE",
      "unreachable": []
    },
    {
      "leg": "placeholders",
      "ok": true,
      "reasonCode": "PLACEHOLDERS_CONSISTENT",
      "gaps": []
    },
    {
      "leg": "setting-descriptions",
      "ok": true,
      "reasonCode": "EVERY_SETTING_DESCRIBED"
    }
  ]
}
```

注:`translation-reality` 腿以 `git show HEAD:` 为基线计算新增键,因此在
clean checkout(即 CI 的条件)下 `addedKeyCount` 恒为 0——该腿在 CI 里不检查
任何东西。实质检查由 `translation-full-table` 承担,它比较整表且能对既有键的
译文回退变红。此处记为 INC-149 的已知残留(P2):基线应改为签入式清单,
如 INC-155 对覆盖守恒门所做的那样。


## 方案与待裁

- i18n CI 供给方案：签入 `locale-contract.mjs` 快照，代价是上游 DS 变化需要单独同步；备选是源缺失显式失败，代价是没有 DS 的普通 clone 无法通过 portal proof。本实现采用前者，供 Owner 裁定，未自裁上游同步策略。
- 0.11.15、helper c40、push/tag/deploy 均停放；平台根 `AGENTS.md` 未写。
