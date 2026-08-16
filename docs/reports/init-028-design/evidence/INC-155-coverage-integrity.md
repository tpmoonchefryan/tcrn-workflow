# INC-155 — 覆盖基线完整性与断言守恒

状态：实现完成，待 Owner 验收。

## 修复指针

- 覆盖面限定为实际 `pnpm test` / portal train 使用的 `tests/` 与
  `portal/tests/` 两个 test root；同级 `packages/pg-backend/test/` 不在这条
  train 中，故不被误报为缺失。
- `coverage-baseline.json` 保留 INC-149 起点的 87 项计数，补入本批新增的
  9 个覆盖面文件，共 96 项；每项带 `testNames`，name-based waiver 不再是
  结构性死分支。
- `coverage-conservation.mjs` 新增 coverage-surface 完整性腿：当前覆盖面与
  基线键集合必须相等。新增 test 文件不更新基线、删除基线文件或移出覆盖面
  都会具名红；test loss 与 assertion-only loss 仍分别判定。
- `verify:portal` 串行接入生产门、单元自测、本批命令边界元判据和 INC-156
  verbatim evidence proof。

## 元判据红腿与恢复

以下是直接运行 `node scripts/coverage-conservation-proof.mjs` 的原始输出。
2026-08-17 两次重录:先随 MCP 门面退役由 97 变 98(TCRN-CROSS-STORY-287)，再随 tests/p1-roster.test.mjs 入册由 98 变 99(TCRN-CROSS-INC-218)。两次都是重录而非放宽判据——逐字块的价值正在于它会因此变红，而这一次红是在 preflight 的隔离世界里出现的，工作树上跑不出来。
脚本通过真实 `coverage-conservation.mjs` 命令边界制造四种情形，不改写工作树
中的测试文件或基线文件；临时 override 在退出时清理。

```verbatim:node scripts/coverage-conservation-proof.mjs
{
  "schemaVersion": "tcrn.inc155-coverage-meta-proof.v1",
  "cases": [
    {
      "name": "delete one s244 test block",
      "exitCode": 1,
      "reasonCode": "COVERAGE_CONSERVATION_VIOLATION",
      "target": {
        "path": "tests/s244-model-plan.test.mjs",
        "baseline": {
          "testCount": 6,
          "assertionCount": 23
        },
        "current": {
          "testCount": 5,
          "assertionCount": 23
        },
        "removedTests": [
          "INC-145 M1/M3/M4: model-plan host and bounded text guards refuse"
        ],
        "unwaivedTests": [
          "INC-145 M1/M3/M4: model-plan host and bounded text guards refuse"
        ],
        "testCountLoss": 1,
        "testCountWaived": false,
        "assertionLoss": 0,
        "assertionWaived": false,
        "ok": false
      }
    },
    {
      "name": "new test file without baseline entry",
      "exitCode": 1,
      "reasonCode": "COVERAGE_BASELINE_INCOMPLETE",
      "baselineCompleteness": {
        "ok": false,
        "expectedFiles": 99,
        "currentFiles": 100,
        "missingFiles": [
          "tests/s244-model-plan.test.mjs"
        ],
        "staleFiles": []
      }
    },
    {
      "name": "empty assertions while keeping test names",
      "exitCode": 1,
      "reasonCode": "COVERAGE_CONSERVATION_VIOLATION",
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
        "testCountWaived": true,
        "assertionLoss": 20,
        "assertionWaived": false,
        "ok": false
      }
    },
    {
      "name": "restore all mutations",
      "exitCode": 0,
      "reasonCode": "COVERAGE_CONSERVATION_VERIFIED",
      "ok": true,
      "baselineCompleteness": {
        "ok": true,
        "expectedFiles": 100,
        "currentFiles": 100,
        "missingFiles": [],
        "staleFiles": []
      }
    }
  ]
}
```

关键红点分别是：删除 s244 test 块红并指名文件（即使当前计数因新增测试未下降）；不更新基线红并列出新文件；
保留 test 名但抽空断言仍红且 `removedTests=[]`、`assertionLoss=20`；恢复后
97/97 完整性与守恒同时转绿。

## 边界

没有添加 coverage waiver 来掩盖本批缺口。既有依赖测试的改名由一条具名、
带 replacement 的 waiver 记录，证明 name-based 分支真实可用。0.11.15、
helper c41、push/tag/deploy 和发布仍停放。
