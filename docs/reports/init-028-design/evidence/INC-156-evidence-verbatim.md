# INC-156 — 证据回读真实性与机械 verbatim 校验

状态：实现完成，待 Owner 验收。

## 订正

- INC-140 的 design-proof 腿名已按实际执行结果订正为：
  `token-fidelity`、`no-literal-colours`、`no-inline-style-attributes`、
  `interactive-tcrn-class-coverage`、`public-v4-baseline`、
  `portal-layout-invariants`；旧的 `token-coverage`、
  `no-literal-colors`、`interactive-elements` 不再作为事实写入。
- INC-153 的 host/role 扫描已承认真实结果是 exit 0、4 处匹配；匹配内容是
  `typeof` 守卫或对派生 host 的比较，不是硬编码 host/role 三元式。原先的
  “exit 1、无匹配”已删除。
- INC-149 的当前 i18n 读回改用真实顶层 `legs` 结构，当前值为
  190 keys / 5 locales / 950 expected strings / `addedKeyCount=148`；历史
  变异输出明确标为 `excerpt`，不冒充当前 HEAD 逐字输出。
- INC-150 的五个发明容器名改成真实 `legs` 摘录；当前 `verbatim:` 块覆盖
  该读回的可重跑摘要。
- `ACCEPTANCE-PACKET.md` 的上一轮结果标题补上 EPIC-080 historical 限定，
  不再让旧数字看起来像本轮数字。

## 机制与取舍

`scripts/verbatim-evidence-proof.mjs --check` 只收集标记为
`verbatim:<可执行 node 命令>` 的块，在仓库根执行命令，并将 stdout（含
最终换行）逐字比较；失败会指名 evidence 文件、块起始行、命令、差异 offset
以及 expected/actual 邻域。其他输出块必须显式标成 `excerpt`，不参与逐字门，
因此历史摘录不会被伪装成当前原始输出。

当前有 4 个 verbatim 块，分布在 INC-140、INC-149、INC-153、INC-155；机制
已进入 `verify:portal`，并另有常驻元判据自测。

## 元判据红腿与恢复

直接运行 `node scripts/verbatim-evidence-meta-proof.mjs`，把 INC-140
verbatim 块的 `legCount` 从 6 改为 7（只在临时副本改写），要求校验脚本红；
随后不改工作树地恢复原文并要求绿。

```excerpt
{
  "schemaVersion": "tcrn.inc156-verbatim-meta-proof.v1",
  "mutation": {
    "changed": "legCount 6 → 7",
    "exitCode": 1,
    "reasonCode": "EVIDENCE_VERBATIM_MISMATCH",
    "problem": {
      "path": "docs/reports/init-028-design/evidence/INC-140-ci-portal-train.md",
      "line": 62,
      "command": "node scripts/verbatim-evidence-proof.mjs inc140-design-proof",
      "ok": false,
      "reasonCode": "EVIDENCE_VERBATIM_MISMATCH",
      "difference": {
        "offset": 62,
        "expected": "\"oof.mjs\\\",\\n  \\\"legCount\\\": 7,\\n  \\\"legNames\\\": [\\n    \\\"",
        "actual": "\"oof.mjs\\\",\\n  \\\"legCount\\\": 6,\\n  \\\"legNames\\\": [\\n    \\\""
      }
    }
  },
  "restored": {
    "exitCode": 0,
    "reasonCode": "EVIDENCE_VERBATIM_VERIFIED",
    "ok": true,
    "blockCount": 4
  }
}
```

该红腿同时证明：改数字会红、红点指向具体块与 offset、恢复后 4 块全部逐字
一致。真实浏览器截图、0.11.15、helper c40、push/tag/deploy、INC-154
档案落点仍归 Owner，未自行移动文件。
