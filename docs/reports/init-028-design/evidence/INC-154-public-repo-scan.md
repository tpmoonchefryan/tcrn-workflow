# INC-154 — 公开仓敏感内容扫描与档案落点

状态：扫描完成，档案移动未执行，待 Owner 裁定。

## 纪律与扫描范围

先对候选平台根 packet/design/preview/story evidence 扫描，再对
`tcrn-workflow` 当前 incident evidence 扫描；扫描完成前没有移动、删除或
重写任何档案。平台根 `AGENTS.md` 保持 0 字节且未触碰。

复核命令：

```sh
rg -n -I -i -e '/users/' -e '/home/' -e '127\\.0\\.0\\.1' -e 'localhost' \\
  -e '\\b(?:10|192\\.168|172\\.(?:1[6-9]|2[0-9]|3[0-1]))\\.' \\
  -e 'password' -e 'passwd' -e 'secret' -e 'api[_-]?key' \\
  -e 'access[_-]?token' -e 'private[_-]?key' -e 'authorization:' \\
  -e 'bearer ' docs/reports/init-028-design/ACCEPTANCE-PACKET.md \\
  docs/reports/init-028-design/DESIGN.md docs/reports/init-028-design/preview.html \\
  docs/reports/init-028-design/evidence/*.md
```

候选平台根输出共 8 行：4 个测试绝对路径、工作树路径、`file://` 浏览器
说明，以及 preview 中一个工作树路径。没有命中 password、secret、key、
token、authorization 或 bearer 内容。

对公开仓 incident evidence 的文件级扫描命中 3 个文件：

```text
tcrn-workflow/docs/reports/init-028-design/evidence/INC-136-ui-presence.md
tcrn-workflow/docs/reports/init-028-design/evidence/INC-141-live-state-fixes.md
tcrn-workflow/docs/reports/init-028-design/evidence/INC-149-ci-proof-gates.md
MATCHED_FILES=       3
```

命中类型为本地 loopback、工作树/绝对路径和环境路径；未发现凭证值。它们
仍然是公开仓内容风险，不能仅因“不是 secret”就当成已清理。

## 方案（未裁）

- A：Owner 选定后只移动已脱敏的 public-safe packet/design/story evidence，
  私有原始取证留在仓外归档。
- B：先把绝对路径、内网风格标识和浏览器 file URL 脱敏为占位符，再保留
  public evidence，并把 private raw evidence 放到 Owner 指定归档处。
- C：维持平台根与公开仓分置，但修复 clone 后的 evidence 链接和落点说明。

档案最终落点、是否脱敏、是否修复链接均未裁；本单不自行移动文件。
