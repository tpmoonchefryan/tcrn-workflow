# INIT-031 平台容器布局验收包

本包对应 cross-project v3410 → 最终读回 v3419。执行顺序为 S256 → S257 →
S258；本地实现、证据与质量门已完成，Owner acceptance 仍未完成。

## 链读回

引擎版本：`0.11.15`。

```json
{
  "version": 3419,
  "headEventHash": "883b8038ba31dd73ed7b5f9c724591e702b48474103a711b8c74084db55412a5",
  "engineVersion": "0.11.15"
}
```

| work | external key | final revision | final status |
| --- | --- | ---: | --- |
| `work:5e17ac2175422d01d46a665d` | `TCRN-CROSS-INIT-031` | 2 | `planned` |
| `work:45879895e11b93a980f15d13` | `TCRN-CROSS-EPIC-084` | 2 | `planned` |
| `work:71f376e7d322c3364dabab0f` | `TCRN-CROSS-STORY-256` | 4 | `pending-owner-acceptance` |
| `work:20c0e2e902cc89504e8732b1` | `TCRN-CROSS-STORY-257` | 4 | `pending-owner-acceptance` |
| `work:aba6ea2826c3a8adcae7b645` | `TCRN-CROSS-STORY-258` | 4 | `pending-owner-acceptance` |

INIT 与 Epic 保持 `planned`；三张 Story 均未进入 `done`。本批链上写入使用
`agent:codex`、新鲜 CAS、attest-dir 与 readback；Owner acceptance 是独立的
后续转移。

## 证据包

- [S256 doctor 与先红留证](./evidence/STORY-256-platform-doctor.md)
- [S257 平台实例与转接链](./evidence/STORY-257-platform-agents.md)
- [S258 启动器、档案与接线事实](./evidence/STORY-258-launchers-and-wiring.md)

S256 保留了修复前真实容器的原始红 JSON；S257 保留 doctor 红转绿与五个项目
分区加信任根的逐条只读复查；S258 保留当前引擎启动器对照、实际启动后受控回收、
十项档案清单和接线事实表。`Joi-Button` ↔ `joi-button` 的大小写映射逐字保留。

## 最终质量门

- `pnpm test`：`TESTS_VERIFIED`，1093 tests，0 fail。
- `pnpm verify:portal`：`PORTAL_VERIFY_TRAIN_GREEN`，9 个命令顺序执行，
  `unverified=[]`。
- `node scripts/platform-doctor.mjs --platform-root <platform-root>`：真实实例
  证据为先红后绿；合成夹具覆盖绿、空/缺失 AGENTS、缺链容器、Git 祖先、缺桥接
  与缺必填参数。
- `node scripts/coverage-conservation.mjs`：`COVERAGE_CONSERVATION_VERIFIED`，
  baseline completeness `94/94`，无 missing/stale；新 doctor 测试已登记。
- `node scripts/task.mjs source`：`SOURCE_ALLOWLIST_VERIFIED`，最终
  `files=538`、`exactEntries=538`。
- `node scripts/generate-proof-artifacts.mjs --check`：
  `PROOF_ARTIFACTS_CURRENT`。
- `node scripts/verbatim-evidence-proof.mjs --check`：
  `EVIDENCE_VERBATIM_VERIFIED`，6 个既有逐字证据块通过。
- 布局正本的本机路径、用户名、邮箱和主机标识扫描无匹配；本机实例与真实先红
  输出留在仓外实例/evidence 边界内。

## 验收边界与待裁 notes

- 链、`.tcrn-workspace` 与其控制树未被文件工具改写；`.tcrn-artifacts` 只读盘点，
  未改变档案字节；未执行 push、tag、deploy、release 或外部发布。
- 本批仓外写入仅为平台根实例、三个转接文件和三个启动器；Joi-Button 的接线
  只记录事实，没有替它补建配置。
- 当前源仓启动器生成器的默认输出目录推导与交接书方向描述存在差异。本批按显式
  输出目录完成对照与替换，是否调整默认契约留给 Owner。
- 正本与本机实例的差异处置、分类夹桥接语义及档案归属均记为 Owner notes，
  本批不自行裁定。
- `done` 只属于 Owner；S256、S257、S258 当前全部停在
  `pending-owner-acceptance`。
