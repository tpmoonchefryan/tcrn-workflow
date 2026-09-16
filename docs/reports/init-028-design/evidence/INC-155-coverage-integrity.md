# INC-155 — 覆盖基线完整性与断言守恒

状态：实现完成，待 Owner 验收。

## 修复指针

- 覆盖面限定为实际 `pnpm test` / portal train 使用的 `tests/` 与
  `portal/tests/` 两个 test root；同级 `packages/pg-backend/test/` 不在这条
  train 中，故不被误报为缺失。
- `coverage-baseline.json` 保留既有计数，补入本批新增的
  46 个覆盖面文件，共 135 项；每项带 `testNames`，name-based waiver 不再是
  结构性死分支。
- `coverage-conservation.mjs` 新增 coverage-surface 完整性腿：当前覆盖面与
  基线键集合必须相等。新增 test 文件不更新基线、删除基线文件或移出覆盖面
  都会具名红；test loss 与 assertion-only loss 仍分别判定。
- `verify:portal` 串行接入生产门、单元自测、本批命令边界元判据和 INC-156
  verbatim evidence proof。

## 元判据红腿与恢复

以下是直接运行 `node scripts/coverage-conservation-proof.mjs` 的原始输出。
2026-08-17 四次重录:随 MCP 门面退役由 97 变 98(TCRN-CROSS-STORY-287)、随 tests/p1-roster.test.mjs 入册由 98 变 99、随 tests/adapter-identity-rebind.test.mjs 由 99 变 100、随 tests/host-harness.test.mjs 由 100 变 101(TCRN-CROSS-INC-218/219/220)。随 tests/s300-catalog-behaviour.test.mjs 入册由 102 变 103(TCRN-CROSS-STORY-300)、随 tests/s301-proof-budget.test.mjs 入册由 103 变 104(TCRN-CROSS-STORY-301)、随 tests/s300-append-events.test.mjs 入册由 104 变 105(TCRN-CROSS-STORY-300 切片二)、随 tests/s300-story-refusal.test.mjs 入册由 105 变 106(同单 Wave 1.4)。随 tests/inc226-trailing-read.test.mjs 入册由 106 变 107(TCRN-CROSS-INC-226)。随 tests/s303-dispatch-citations.test.mjs 入册由 108 变 109(TCRN-CROSS-STORY-303)。随 tests/inc230-snippet-search.test.mjs 入册由 109 变 110(TCRN-CROSS-INC-230)。随 tests/inc232-trailing-cli-surface.test.mjs 入册由 110 变 111(TCRN-CROSS-INC-232)。随 tests/inc224-chain-event-bound.test.mjs 入册由 111 变 112(TCRN-CROSS-INC-224)。随 tests/s300-work-batch.test.mjs 入册由 112 变 113(TCRN-CROSS-STORY-300 切片三)。随 tests/knowledge-batch.test.mjs 入册由 113 变 114(knowledge-batch)。随 tests/inc269-annotation-advisory-guard.test.mjs 入册由 135 变 136(TCRN-CROSS-INC-269)。十六次都是重录而非放宽判据。这一次它多叫了一声:测试改名后基线仍存着旧测试名,门把五条判据报成「被删除」——名字也是判据的一部分,不只是文件数。这个块因此是一条对「新增测试文件必须同时入册覆盖基线」的独立复核:每次都先于改动者叫出来——这一次也是,它在 P1 上把这个新文件的入册叫了出来。第十七次重录(2026-09-06,TCRN-CROSS-INC-280):TCRN-CROSS-STORY-358 退役无活消费者模块时把 scripts/policy/coverage-baseline.json 的条目数由 139 降到 122,块随之由 138/139、139/139 重录为 121/122、122/122。基线下降是 STORY-358 的正确结果,不是缺陷;这一次是块没跟上来源,不是来源错了。第十八次重录(2026-09-06,TCRN-CROSS-STORY-365):tests/knowledge-capture.test.mjs 入册,块由 121/122、122/122 重录为 122/123、123/123。第十九次重录(2026-09-07,TCRN-CROSS-STORY-363):tests/story-363-work-summary.test.mjs 入册,块由 122/123、123/123 重录为 123/124、124/124。同一改动里 tests/inc269-annotation-advisory-guard.test.mjs 的两条测试改名——work.annotated 的「至少动了一个字段」判据把 title、labels、summary 也算进去了,名字跟着判据走——两条都按机制走 coverage-waivers.json 的 replacement 路径,不是靠改基线里的名字抹掉。第二十次重录(2026-09-08,TCRN-CROSS-STORY-380):tests/story-380-artifact-blob-store.test.mjs 入册,块由 123/124、124/124 重录为 124/125、125/125。该文件是 workspace.generatedArtifactsPath 的第一个消费者的证明面,新增而非改名,因此走的是入册路径而不是 coverage-waivers.json 的 replacement 路径。第二十一次重录(2026-09-08,TCRN-CROSS-STORY-362):tests/story-362-recall.test.mjs 入册,块由 124/125、125/125 重录为 125/126、126/126。该文件是 packages/core/src/recall.ts 的证明面,新增而非改名,因此走的是入册路径而不是 coverage-waivers.json 的 replacement 路径。第二十二次重录(2026-09-08,TCRN-CROSS-STORY-364):tests/story-364-knowledge-language.test.mjs 入册,块由 125/126、126/126 重录为 126/127、127/127。该文件是 packages/core/src/knowledge-language.ts 的证明面,新增而非改名,因此走的是入册路径而不是 coverage-waivers.json 的 replacement 路径。第二十三次重录(2026-09-09,TCRN-CROSS-STORY-366):这次不是新文件入册,是已入册文件的计数落后于文件本身——tests/s213-settings.test.mjs 新增第三条测试(STORY-366:article 目录设置的默认值与控制树逃逸拒绝),coverage-baseline.json 里该文件的记录仍是两条测试时的 testCount 2、assertionCount 20,而"empty assertions while keeping test names"用例读到的 current 如实报告了 3;块因此重录。coverage-baseline.json 同批把该文件改为 testCount 3、assertionCount 27,补入第三条测试名。第二十四次重录(2026-09-09,TCRN-CROSS-STORY-367):tests/injection-session.test.mjs 入册,块由 126/127、127/127 重录为 127/128、128/128。该文件是 scripts/injection-session.mjs 的证明面,新增而非改名,因此走的是入册路径而不是 coverage-waivers.json 的 replacement 路径。二十四次都是重录而非放宽判据。
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
          "assertionCount": 22
        },
        "current": {
          "testCount": 5,
          "assertionCount": 20
        },
        "removedTests": [
          "INC-145 M6: an active-plan reference refuses removal"
        ],
        "unwaivedTests": [
          "INC-145 M6: an active-plan reference refuses removal"
        ],
        "testCountLoss": 1,
        "testCountWaived": false,
        "assertionLoss": 2,
        "assertionWaived": true,
        "ok": false
      }
    },
    {
      "name": "new test file without baseline entry",
      "exitCode": 1,
      "reasonCode": "COVERAGE_BASELINE_INCOMPLETE",
      "baselineCompleteness": {
        "ok": false,
        "expectedFiles": 135,
        "currentFiles": 136,
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
          "testCount": 3,
          "assertionCount": 27
        },
        "current": {
          "testCount": 3,
          "assertionCount": 0
        },
        "removedTests": [],
        "unwaivedTests": [],
        "testCountLoss": 0,
        "testCountWaived": true,
        "assertionLoss": 27,
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
        "expectedFiles": 136,
        "currentFiles": 136,
        "missingFiles": [],
        "staleFiles": []
      }
    }
  ]
}
```

关键红点分别是：删除 s244 test 块红并指名文件（即使当前计数因新增测试未下降）；不更新基线红并列出新文件；
保留 test 名但抽空断言仍红且 `removedTests=[]`、`assertionLoss=27`；恢复后
137/137 完整性与守恒同时转绿。

2026-09-11（TCRN-CROSS-INC-296）按脚本完整输出重录以上块：遗漏一项时
136/137 为红，恢复后 137/137 为绿。原文后续的历史 128 条目说明保留为当时事实；
本次未减少基线成员，也未改动 waiver 或断言判据。

第二十五次重录（2026-09-09，TCRN-CROSS-STORY-369）：本单保留覆盖基线的 128 个文件，改写九个既有测试文件的 AST 计数；被 Requirement 推翻的旧测试名通过带 `replacement` 的 coverage waiver 逐条承接，未删除测试文件或基线成员。

第二十六次重录（2026-09-12，TCRN-CROSS-STORY-402/403）：本次保留覆盖基线的 137 个文件与所有测试名称；s244 当前测试实现有 5 条测试、20 条断言，s213 的空断言负腿仍保持断言守恒判据。

## 边界

本单的 coverage waiver 只记录 TCRN-CROSS-MIN-198 D2 / TCRN-CROSS-STORY-369
要求的替代路径，没有用来掩盖未承接的缺口。每条改名记录都具名并带 replacement，
证明 name-based 分支真实可用。0.11.15、
helper c41、push/tag/deploy 和发布仍停放。
