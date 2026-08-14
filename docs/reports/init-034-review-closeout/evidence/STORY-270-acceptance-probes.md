已脱敏：本文件不含本机路径、用户名或主机标识；原始证据仅存平台档案。

# STORY-270：acceptanceProbe 与 machine 层

## 结果

install wiring 现在只解释 manifest 声明的安全 probe 表达式，不执行任意
shell。支持的表达式覆盖 regular file/directory/executable、JSON receipt、
helper skill digest、engine version 与 launchd duty；未知语法和错误文件种类
会分别红。所有 manifest layers 均被遍历，真机 itemCount 为 41，包含 Codex
config、三个 launcher、两个 helper digest 与两个 host adapter surface。

helper copy 用 manifest 声明的 SHA-256 与 `lstat` 后的 regular file 内容比较。
deployment freshness 不再把 helper 缺失让渡成 green；目录冒充文件、digest
不匹配、未知 probe 都有合成红腿。

## 验证

```text
node --test tests/platform-doctor.test.mjs
node scripts/coverage-conservation.mjs
node scripts/platform-doctor.mjs --platform-root <PLATFORM_ROOT>
```

新增四项 S270 测试加入 coverage-baseline；完整合成套件通过。真机 doctor
的 platform root、container、helpers、wiring、hooks 与 deployment freshness
为 green，唯一红腿是 S269 的 launchd 失败。

## Boundary

公开清单只含 `<HOME>` / `<PLATFORM_ROOT>` 占位符；本单不证明真实宿主批准、
真实业务触发、Owner acceptance、`done` 或发布。
