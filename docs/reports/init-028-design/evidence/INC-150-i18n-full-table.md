# INC-150 — i18n 整表、语义词典与 zh-CN 可见文案

状态：实现完成，待 Owner 验收。

## 现象与证据

`VERIFICATION-2026-08-13-remediation-fable.md` 点名本单的失译：13 个新增
键在四个非英语 locale 各有缺口，词典 term 只有英文语义，zh-CN 页面仍有
英文可见文案。这个单的判据不是 API 返回或静态字符串包含，而是整张运行期
locale 表与实际执行 DOM 的双重读回。

## 修复

- `portal/locales.js` 为 `zh-CN`、`ja`、`ko`、`fr` 补齐 13 个键，并为
  roles、conferenceTypes、executionForms 的 term 补语义 description。
- `portal/index.html` 的 vocabulary renderer 和搜索索引都从
  `vocabulary.term.<category>.<value>.description` 取本地化语义；词典事实
  仍来自 `/api/vocabulary`。
- `portal/i18n-policy.json` 记录整表相等上限与仅保留品牌/CLI 动词的显式
  waiver；`i18n-proof.mjs` 新增 `translation-full-table`，不允许旧译文
  回退成英文。

## 绿腿原始关键输出

复核命令=`node portal/scripts/i18n-proof.mjs`。

```excerpt
{
  "ok": true,
  "reasonCode": "I18N_CONTRACT_SATISFIED",
  "legs": [
    {"leg": "key-coverage", "ok": true, "reasonCode": "EVERY_KEY_TRANSLATED", "keyCount": 190, "localeCount": 5, "expectedStrings": 950, "gaps": []},
    {"leg": "translation-reality", "ok": true, "reasonCode": "TRANSLATIONS_DIFFER_FROM_ENGLISH", "addedKeyCount": 148, "gaps": []},
    {"leg": "translation-full-table", "ok": true, "reasonCode": "FULL_LOCALE_TABLE_TRANSLATED", "problems": []},
    {"leg": "key-reachability", "ok": true, "reasonCode": "EVERY_LOCALE_KEY_REACHABLE", "unreachable": []},
    {"leg": "setting-descriptions", "ok": true, "reasonCode": "EVERY_SETTING_DESCRIBED", "undescribed": [], "orphaned": []}
  ]
}
```

这是当前命令顶层 `legs` 的显式摘录；没有再发明 `keyCoverage`、
`translationReality`、`translationFullTable`、`keyReachability` 或
`settingDescriptions` 这些不存在的 JSON 容器名。完整可重跑的当前读回由
INC-156 的 `verbatim:` 机械块负责。

## UI 级语义证据

复核命令=`node --test portal/tests/ui-presence.test.mjs`。执行真实
`portal/index.html` DOM 后切换 `zh-CN`，断言 `.tcrn-term__definition` 含
中文 role 语义且不含英文 role description；该文件本轮结果为 5 tests、5
pass、0 fail。API 层和 `innerHTML` 包含判定不作为本条 UI 判据。

为处理 linkedom 0.18.12 对 `data-i18n="..."` 返回 `dataset.i18n=null` 的
测试仪器盲区，`portal/tests/ui-presence.test.mjs` 安装了规范属性回退 Proxy；
执行后 DOM 现在逐项断言静态 `[data-i18n]` 绑定均有非空文本，并确认
`dashboard.chain` 在 zh-CN 中读回“链版本”。这只改测试 harness，不给门户
运行时增加依赖。

## 待裁与边界

- 词典语义本地化的真源有两套方案：当前采用门户 locale map；备选是引擎
  多语言 vocabulary。最终落点未裁，归 Owner。
- i18n 契约在 CI 的供给方式当前采用签入 `portal/locale-contract.mjs`
  快照；“签入快照”与“源缺失显式失败”的最终策略未裁，归 Owner。
- 浏览器截图、真实账号派发、0.11.15、helper c40、push/tag/deploy 均
  未声称完成。
