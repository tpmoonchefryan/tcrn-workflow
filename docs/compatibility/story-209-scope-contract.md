# STORY-209 compatibility plan

Status: planned for the next Workflow release candidate; no tag or publication is
created by this document.

## Surface change

`work-create` keeps all existing flags and adds optional `--scope` and
`--decided-by` catalog entries. For `kind=Story`, `--scope` is now required and
must contain the ordered ten-block contract plus the preserved legacy elements.
`work-annotate --scope` and transitions to `ready`, `active`, or `done` apply the
same validator. Non-Story records and existing terminal history remain readable;
existing non-terminal Stories require an append-only migration annotation before
they can advance.

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
additive flags. The positive and negative compatibility legs are covered by
`tests/story-scope-compliance.test.mjs`; the independent closeout copy is covered
by `scripts/story-scope-compliance.mjs` and live Story `work-show` readback. The
source-to-rule mapping and deletion red legs are in
`scripts/policy/story-rule-conservation.json`. This is an offline Workflow
surface change, not a mutual Workflow/AOS release pair, so the existing
compatibility engine remains in its `supportedAosReleases: []` posture; no AOS
compatibility pair is claimed.
