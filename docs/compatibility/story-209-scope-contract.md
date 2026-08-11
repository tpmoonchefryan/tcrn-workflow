# STORY-209 compatibility plan

Status: planned for the next Workflow release candidate; no tag or publication is
created by this document.

## Surface change

`work-create` keeps all existing flags and adds optional `--scope` and
`--decided-by` catalog entries. An unbound new `kind=Story` still requires the
ordered ten-block contract plus the preserved legacy elements. An admitted
template may instead bind a `template@version` extension; its ordered heading
set owns the template shape while the engine keeps the kind-independent purpose,
acceptance, evidence, and reference floor. `work-annotate --scope` and
transitions to `ready`, `active`, or `done` apply the matching bound or legacy
validator. Existing non-template history remains readable; a missing binding is
the explicit pre-template exemption, not a migration failure.

## Compatibility impact and migration

- A pre-change writer that creates a Story without `--scope` receives the stable
  `WORKSPACE_STORY_SCOPE_REQUIRED` refusal. It must be upgraded before it can
  create new Stories.
- A reader that does not understand `work.annotated` cannot replay a chain that
  uses advisory scope, so all readers/writers of a migrated chain must be pinned
  to the same compatible Workflow build.
- `--decided-by` is additive and carries protocol `minutes:` ids; omitting it is
  allowed when no minutes backlink exists.
- Migration order is: read live status and work-list, read each non-terminal
  Story, replace its complete scope with `work-annotate` under numeric CAS, read
  back and validate, then permit a status transition.
- No compatibility bypass, manifest self-approval, or terminal-history rewrite is
  introduced. The dispatch brief remains transport-only, carries a readback
  `storyScope` for the gate, and is checked by `dispatch:validate` immediately
  before dispatch.

## Verification record

The command catalog is generated from the CLI source and now exposes the two
additive flags plus the template admission family. The positive and negative
legacy legs are covered by `tests/story-scope-compliance.test.mjs`; admitted
template binding and its red legs are covered by
`tests/s212-template-admission.test.mjs`. The independent closeout copy remains
covered by `scripts/story-scope-compliance.mjs` for pre-template Stories, while
the engine validates bound templates from the admitted registry. The
source-to-rule mapping and deletion red legs are in
`scripts/policy/story-rule-conservation.json`. This is an offline Workflow
surface change, not a mutual Workflow/AOS release pair, so the existing
compatibility engine remains in its `supportedAosReleases: []` posture; no AOS
compatibility pair is claimed.
