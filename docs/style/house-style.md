# README house style

> Descriptive of the current docs, extracted from `README.md` as it stands — not a set of new rules. The checkable subset is enforced by `scripts/push-gate.mjs`; everything else is a convention a human upholds. Rewritten for INIT-050, which made Simplified Chinese the authoring source, cut the front page to what a first-time reader needs, and moved the deep material to the wiki.

## Voice

The reader arrives not knowing whether this is worth their afternoon. The document's job is to make that decision fast and honestly, in that order.

- **Lead with the reader's situation, not the framework's architecture.** The opening states the problem the reader already has — an Agent reported green and there is nothing to check it against — before naming a single component.
- **Sell on the proof, not on the promise.** The strongest thing this project has is that it applies its own standard to itself. `guard-check` breaking 61 guards and requiring 61 red tests is the argument; put it near the top, state what it proves, and state what it does not.
- **No-overclaim still governs.** Never assert a capability without pointing at the command that demonstrates it. The bar is stated outright: overclaiming is a build failure, not a style issue.
- **Numbers are measured, never remembered.** Every figure in these documents is re-measured against the tree before it ships. The measurements and their sources are listed under [Numbers](#numbers).
- **No metaphor, analogy, or aphorism.** Say the thing itself. Not "the door did not lie" but "the check compared attribute values and never compared whether the element existed."
- **Examples are real instances, and each says what it proves.** Real paths, real values, real identifiers. No hypotheticals, no personification. An example longer than three lines becomes a table.
- **Comparisons are tables.** Two-sided, before/after, or multi-item — never prose.

## Structure

`README.md` runs top-to-bottom in a fixed order:

1. **Centered header block** (`<div align="center">` … `</div>`), holding, in this order:
   - `#` title
   - `###` one-line tagline naming the reader's situation
   - a bold positioning line
   - the five-language link row
   - the two-line badge block
   - a section navigation row
   - the inline `Verified claims: …` count line
2. **The statistics strip** — an HTML `<table>` of four centered cells, each an `###` figure over a one-line label and a `<sub>` gloss. The four are the P1 gate count, the criterion count, the guard count, and the runtime dependency count.
3. **A `> [!TIP]` alert** stating that the reader does not have to trust the document, because the framework proves itself offline.
4. `##` the reader's situation — prose, then the four-row comparison table (`what you want to confirm` / `what you have now` / `what you have after`).
5. `##` why trust it — the `guard-check` proof, the 122-criterion standard, a `<details>` block breaking the criteria into their three categories, and a `> [!IMPORTANT]` alert on re-proof being enforced.
6. `##` who it is for — a two-column table with real headers.
7. `##` what you get — a two-column table.
8. `##` the three-minute start — the pinned toolchain, a `sh` block of three steps, a `<details>` block of the governed commands most used, and a `> [!NOTE]` alert that `commands` is the authority over any document.
9. `##` current status
10. `##` full documentation — points at the GitHub wiki, then the root-document row
11. `##` license

Major sections are separated by `---` rules. Every mirror carries the identical structure.

### The five-language link row

A single line below the positioning line, listing the five maintained locales in a fixed order: 简体中文, English, 日本語, 한국어, Français. **Simplified Chinese is the authoring source** and lives in `README.md`, which is what GitHub renders on the repository page; English is a mirror in `README.en.md`. The current document's language appears as plain text; the other four are relative links. Items are joined by a space–middot–space separator (` · `).

### The badge block

Two lines of `shields.io` badges, all carrying `?style=flat-square` so the row reads as one object:

- Line 1 — subject: `status` (release version), `gates` (`verify:p1` gate count), `claims` (proven-criterion count), `deps` (runtime dependency count).
- Line 2 — environment: `license`, `node`, `pnpm`, `network`, `hosts`.

Numbers baked into these badges are the same values that appear in prose and in the `Verified claims:` line, so they move together. That line restates the criterion total and its three-way split as inline code and is machine-parsed against `verification-map.yaml` by `scripts/task.mjs`; its exact text is part of the contract.

## Terminology

**Industry terms stay in the industry's language.** A reader who works in this field reads `Agent` faster than any translation of it, and a forced native coinage reads as a document written by someone outside the field. This applies to every locale, not only the CJK ones.

| Term | 简体中文 | 日本語 | 한국어 | Français |
| :--- | :--- | :--- | :--- | :--- |
| Agent | `Agent` | `エージェント` | `에이전트` | `Agent` |
| Token | `Token` | `トークン` | `토큰` | `Token` |
| guard | 守卫 | `ガード` | `가드` | `guard` |
| gate | 门 | `ゲート` | `게이트` | `gate` |
| hash | 哈希 | `ハッシュ` | `해시` | `hash` |
| workspace | 工作区 | `ワークスペース` | `워크스페이스` | `workspace` |
| reason code | 原因码 | `リーズンコード` | `리즌 코드` | code de raison |

The rules behind that table:

- **Simplified Chinese** keeps widely-used English nouns as English (`Agent`, `Token`, `CI`, `SBOM`, `lint`), and translates terms that have a settled Chinese form (哈希、工作区、遥测).
- **Japanese** uses katakana loanwords for imported technical terms (`エージェント`, `ガード`, `ワークスペース`) rather than coining kanji compounds for them. Native Japanese words stay where the concept is native (判定基準、主張).
- **Korean** uses 외래어 for the same set (`에이전트`, `가드`, `워크스페이스`).
- **French** keeps the English noun where French practice keeps it (`Agent`, `build`, `hash`, `workspace`, `guard`, `gate`) and translates where French has its own settled term (télémétrie, code de raison).
- Reason codes, command names, flags, filenames and identifiers are **never** translated in any locale. They stay ASCII inside backticks.

## Typography

**Heading levels.** Exactly one `#` (the title). `###` is used for the tagline and for the figures in the statistics strip. Every top-level section is `##`. Nothing goes deeper than `###`. Collapsible asides use `<details>`/`<summary>` with a bold `<b>…</b>` label rather than a heading, and open with a `<br>` so the first block inside breathes.

**Alerts.** GitHub alert syntax (`> [!TIP]`, `> [!IMPORTANT]`, `> [!NOTE]`) carries the three statements that must not be missed. Alerts are for statements, not for sections: one short paragraph each, at most three in the document.

**Table discipline.** Every table ships a real header row naming what its columns hold. Two-column comparisons name both sides in the header (`✓ 适合你，如果` / `✗ 不适合你，如果`) rather than shipping the empty header row (`| | |`) the previous revision used — an empty header renders as a blank strip above the table on GitHub. Alignment is declared: `:---` for text columns, `---:` for counts. A ✓/✗ prefix in a comparison header gives the reader a scanning anchor.

**Fenced code language tags.** Every fenced block carries a language tag: ` ```sh ` for shell, ` ```mermaid ` for diagrams. No bare ` ``` ` opening fences. Inline reason codes, commands, filenames and identifiers are wrapped in single backticks.

**Emphasis and CJK.** `scripts/push-gate.mjs` fails closed on a `**bold**` span that ends in punctuation and is immediately followed by a non-punctuation character, because that renders as literal asterisks. Keep sentence punctuation outside the bold span. Where a locale attaches a particle directly to a term — Korean `…에`, for instance — wrap the emphasis around the link *text* rather than around the whole link, so the span closes on a letter instead of on the closing parenthesis.

One consequence for this file and any like it: the link gate scans raw markdown with a regular expression and does not skip code spans or fenced blocks, so literal link syntax written as an example is checked as a real link and fails. Describe the shape in words instead.

**CJK typesetting.** Full-width sentence punctuation (`。`, `，`, `：`, `；`, `（）`, `——`, and `「」` for referenced section names). A space separates a CJK run from an adjacent Latin word, number, or inline-code span (`AI Agent 交付`, `24 道门`, `` 用 `cat` 审 ``). Enumerations inside a sentence use the ideographic comma `、`, never a half-width `,`; the full-width `，` separates clauses, not list items.

**One trailing LF.** Every canonical file ends with exactly one line-feed and no trailing blank lines.

## Numbers

Every figure is re-measured before it ships. The commands that produce them:

| Figure | Source of truth |
| :--- | :--- |
| P1 gate count | `P1_TASKS.length` in `scripts/p1-sequence.mjs` |
| criterion count and split | `claims` in `verification-map.yaml`, grouped by `category` |
| guard count | `scripts/policy/guard-registry.json` |
| test file count | `git ls-files 'tests/*.test.mjs'` |
| CLI verb count | `node scripts/tcrn-workflow.mjs commands` |
| runtime dependency count | `dependencies` and `optionalDependencies` in `package.json` |

A figure that cannot be produced by one of these does not go in the document.

## The wiki

The wiki carries what the front page deliberately does not: architecture, command reference, criteria and gates, repository layout, known limits, FAQ, trust chain and release. It follows the same voice, terminology and typography rules as the READMEs, in the same five locales, and its pages carry the same language link row. Wiki pages are not gated — nothing in this repository fails when they change — so their accuracy is a reviewer's responsibility, and any figure on them is measured from the table above.

Internal operating notes never ship to the wiki. It is a public documentation surface, not a work log.

## Changing these documents

- **Re-sync every mirror in the same change.** The five READMEs are held current by the badge and version-in-prose checks; the smaller root docs each pin the SHA-256 of their English source (`tcrn-doc-synced-to`), and a stale pin blocks the push. Coverage is declared in `scripts/policy/doc-coverage.json`.
- **Hold the version in prose,** not only in the status badge (push-gate check 2d).
- **Re-measure every number,** using the table above, rather than carrying a figure forward.
- **Reviewer checklist, not machine-checkable:** the voice holds — reader's situation first, no claim without a runnable proof, no metaphor, comparisons as tables; the terminology table is respected in every locale; CJK mirrors keep full-width punctuation, CJK/Latin spacing, and the ideographic comma.

`LICENSE`, `NOTICE`, `CHANGELOG.md` and `SUPPORT.md` are English-only by policy and are not mirrored.
