已脱敏：本文件不含本机路径、用户名或主机标识；原始证据仅存平台档案。

# STORY-266：回执归档与跨仓隐私门

## 结果

首轮隐私门按交接要求先运行并诚实变红，`S266-privacy-red.stdout.json`
记录了四个公开项目仓的绝对路径与私有身份发现，以及平台工作流仓的本机
settings 发现。该红证发生在清理之前，没有被覆盖或移入公开仓。

随后将平台容器与五个项目的 Claude/Codex 回执集中到平台档案根的
`install-receipts/<project>/{claude,codex}.json`，逐字节复核通过
`S266_RECEIPTS_ARCHIVED_BYTE_EXACT`，并清理项目根的
`.tcrn-install-receipts`。跨仓门现在覆盖 manifest 的全部五个项目，含精确
小写目录 `joi-button`；清理后的真机读回为 `CROSS_REPO_PRIVACY_GREEN`。

## 验证

```text
pnpm build
node --test tests/cross-repo-privacy.test.mjs
pnpm verify:cross-repo-privacy
node scripts/cross-repo-privacy.mjs --platform-root <PLATFORM_ROOT>
```

合成测试为 3 tests / 11 assertions；红腿同时覆盖绝对路径与身份标记，随后
验证清理后的绿态。doctor 与 manifest 继续使用占位符，公开证据没有本机值。

## Boundary

本单证明回执不再落入项目公开仓、隐私门会扫描跨仓 governance surfaces；不
证明 Owner acceptance、`done`、push、tag、部署或发布。
