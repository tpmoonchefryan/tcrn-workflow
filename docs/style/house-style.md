# README house style

> Descriptive of the current docs, extracted from `README.md` as it stands — not a set of new rules. The checkable subset of these conventions is enforced by `scripts/doc-sync.mjs`; everything else is a convention a human upholds.

## Structure

The English `README.md` runs top-to-bottom in a fixed order. Every section below is an ATX `##` heading unless noted, and the order does not vary:

1. **Centered header block** (`<div align="center">` … `</div>`), holding — in this order:
   - `#` title (`TCRN Workflow`)
   - `###` one-line tagline (`Your AI agents say "done." This framework makes them prove it.`)
   - a bold positioning line
   - the five-language link row
   - the two-line badge block
   - a section navigation row
   - the inline `Verified claims: …` count line
2. A `---` horizontal rule
3. A blockquote stating the whole idea in one sentence (`> **The whole idea in one sentence:** …`)
4. `## Why this project exists`
5. `## Is this for you?`
6. `## What you get` (closes with a `<details>` block, `Five terms, in plain words`)
7. `## Quick start`
8. `## Using it for real work`
9. `## Architecture in 60 seconds`
10. `## Plain answers to fair questions` (each question is a `###` subsection; some carry a `<details>` block)
11. `## Numbers that are checked, not promised` (closes with a `<details>` block, `Full verification-target reference`)
12. `## Repository layout`
13. `## What this does not govern`
14. `## Known limits`
15. `## Status, honestly`
16. `## Contributing, support, security`
17. `## License`

### The five-language link row

A single line, immediately below the tagline/positioning lines, listing the five maintained locales in a fixed order: English, 简体中文, 日本語, 한국어, Français. The **current** document's language appears as plain text; the other four are relative links to their sibling files (`./README.zh-CN.md`, `./README.ja.md`, `./README.ko.md`, `./README.fr.md`). Items are joined by a space–middot–space separator (` · `). Each translated README carries the identical row with its own language de-linked (e.g. `README.zh-CN.md` shows `简体中文` as plain text and `English` as a link back).

### The badge block

Two lines of `shields.io` badges, in this grouping and order:

- Line 1 — subject/version badges: `status` (the release version), `gates` (`verify:p1` gate count), `claims` (proven-claim count), `deps` (runtime dependency count).
- Line 2 — environment/policy badges: `license`, `node`, `pnpm`, `network`, `hosts`.

Numbers baked into these badges (version, gate count, claim count) are the same values that appear in prose and in the `Verified claims:` line, so they move together. The `Verified claims: 65 (hygiene 13 · inertness 13 · runtime 39)` line directly under the nav row restates the claim total and its three-way split as inline code, and is machine-parsed against `verification-map.yaml`.

## Wording

The voice is *no-overclaim*: the document never asserts a capability it cannot point at a runnable proof for. Concretely:

- **Every capability is a claim tied to a proof.** Features are described alongside the command that demonstrates them and, where relevant, the reason code that fails the build if the claim goes stale (`pnpm verify:p1`, `pnpm guard-check`, `WORKSPACE_GATE_PENDING`). The bar is stated outright: *"if your claim isn't in the verification map with a passing proof, it isn't claimed."*
- **Numbers are checked, not promised.** The numbers section is literally titled *"Numbers that are checked, not promised"*, and each figure names the gate that enforces it. The positioning line is *"every capability is a machine-verified claim, not a promise."*
- **Boundaries are stated as what it deliberately does NOT do.** Whole sections exist to mark the edges — `## What this does not govern` and `## Known limits` — and capabilities are qualified by their non-actions: the live adapter *"does not adjudicate the host's tool use, does not suppress or rewrite responses, never writes under `~/.claude`."*
- **Measured, not assumed.** Behaviour that was observed is labelled as observed, and the phrasing distinguishes proof from assumption: *"determinism is proven, not assumed"*, the summary was *"measured rather than assumed"*, and authority is *"proven to arrive; never claimed to be obeyed."*
- **Reason codes are the contract; prose is not.** Stable error names carry the meaning and tools branch on them; the prose is explicitly disclaimed as non-binding — *"prose error text is never the contract."* The single rule that anchors the voice is that drift is fatal, not cosmetic: *"overclaiming is a build failure, not a style issue."*

## Typography

**Heading levels.** Exactly one `#` (the title). `###` is used for the tagline and for the question subsections under *Plain answers to fair questions*. Every top-level section is `##`. Nothing goes deeper than `###`. Collapsible asides use `<details>`/`<summary>` with a bold `<b>…</b>` label, often with a `(click to expand)` cue, rather than a heading.

**Fenced code language tags.** Every fenced block carries a language tag: ` ```sh ` for shell/command samples, ` ```mermaid ` for the architecture diagram. No bare ` ``` ` opening fences. Inline reason codes, commands, filenames, and identifiers are wrapped in single backticks.

**Table discipline.** Tables use a header row, a `| --- | --- |` delimiter row, and pipe-bounded cells. Two-column layouts that need no visible header ship an empty header row (`| | |`) so the delimiter is still present. Cell text follows the same no-overclaim wording as the prose.

**One trailing LF.** Every canonical file — README included — ends with exactly one line-feed and no trailing blank lines, mirroring the engine's own canonical-JSON rule (*"sorted keys, one trailing LF"*).

### CJK translations

The translated READMEs (`README.zh-CN.md`, `README.ja.md`, `README.ko.md`) keep the same structure and wording discipline as the English source, and add three typesetting rules:

- **Full-width punctuation.** Sentence punctuation is full-width: `。`, `，`, `：`, `；`, `（）`, the em-dash pair `——`, and corner brackets `「」` for referenced section names (e.g. `「已知限制」`, `「状态，如实相告」`) where the English uses double quotes. Code, reason codes, commands, and identifiers stay ASCII inside backticks.
- **CJK/Latin spacing.** A space separates a CJK run from an adjacent Latin word, number, or inline-code span — `让 AI 智能体`, `20 道门`, `13 条 framework-hygiene`, `` 用 `cat` 和 `sha256sum` 审计它 ``.
- **No ASCII comma as a list-item separator.** Enumerations inside a sentence are joined with the ideographic comma `、`, never a half-width `,` — `格式、lint、类型检查、构建` and `` `Review`、`Release` 与 `Knowledge` ``. The full-width comma `，` separates clauses, not list items.

## Changing these documents

The checkable subset above is enforced by `scripts/push-gate.mjs`; the rest is a reviewer's responsibility. When you change one of the mirrored root documents:

- **Re-sync every translation in the same change.** Each translated root doc pins the SHA-256 of its English source (`tcrn-doc-synced-to`). If English moves ahead, the pin goes stale and `pnpm push-gate` blocks the push. Re-translate and re-pin — do not defer it.
- **Hold the version in prose,** not only in the status badge (push-gate check 2d).
- **Reviewer checklist for wording and typography** (not machine-checkable): the no-overclaim voice holds — no claim without a runnable proof, boundaries stated as non-actions, *"measured, not assumed"*; CJK translations keep full-width punctuation, CJK/Latin spacing, and the ideographic comma for in-sentence lists.

`LICENSE`, `NOTICE`, `CHANGELOG.md` and `SUPPORT.md` are English-only by policy and are not mirrored.
