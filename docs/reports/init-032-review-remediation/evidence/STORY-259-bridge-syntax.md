已脱敏，非逐字；原件见平台档案 init-032-review-remediation/S259-doctor-red.stdout.json。

# STORY-259 bridgeSyntax

## 交付

- `scripts/platform-doctor.mjs` 新增 `bridgeSyntax` 检查。
- 检查平台根和直属分类目录中的 `AGENTS.md` / `CLAUDE.md`，跳过隐藏目录和
  `.tcrn-workspace`。
- `@@` 与引用目标不存在分别返回
  `PLATFORM_BRIDGE_SYNTAX_INVALID` 和
  `PLATFORM_BRIDGE_TARGET_UNAVAILABLE`，结果携带相对文件名、行号和原行文本。
- `--platform-root` 仍为必填；测试只使用合成临时夹具。

## 证据弧线

1. 先写入 doctor leg 并通过定向测试。
2. 修复前真机输出命名了平台文件首行的 `@@`，原始红证已留在本批平台档案。
3. 仅修复该首行后，真机 `bridgeSyntax` 变绿；当时旧 paired launchd 的失败仍由独立
   `launchd` leg 命名，未被本单掩盖。
4. 合成夹具覆盖有效引用、`@@`、悬空目标以及跳过目录四态。

本单不迁移链、不写 `.tcrn-workspace`，状态停在 `pending-owner-acceptance`。
