已脱敏，非逐字；原件见平台档案 init-032-review-remediation/original/ 与本批复核记录。

# STORY-260 evidence residence

## 交付

- `docs/platform-container-layout.md` 新增通用的 `Evidence residence` 节，说明公开
  证据是脱敏摘要、逐字原件在平台档案外置区，并禁止机器路径、用户名、主机名、凭据
  和 secret 进入公开布局正本。
- 六份已有公开证据均保留文首脱敏声明；逐字原件集中在平台档案的 `original/` 下，
  对应文件为 acceptance packet、STORY-252、STORY-255、STORY-256、STORY-257 和
  STORY-258。
- 脱敏摘要不称为 verbatim；只有仍可逐字复现的命令块参加 verbatim 校验。
- source allowlist 做双向校验：仓内每个公开源文件都有登记，登记项也都有对应文件。

## 复核摘要

- `verbatim-evidence-proof --check`：`EVIDENCE_VERBATIM_VERIFIED`。
- source allowlist：`SOURCE_ALLOWLIST_VERIFIED`，新增证据路径与本批实现路径均已登记。
- 隐私门：`PRIVACY_SOURCE_CLEAN`；扫描范围包含公开仓当前源与归档证据。
- 平台层重复的空 evidence 目录保持清理；带交接书的目录不作删除。

本单只调整证据居所和公开说明，不改变 INIT-029/INIT-031 的结论，不迁移链；状态停在
`pending-owner-acceptance`。
