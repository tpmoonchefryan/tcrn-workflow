# CLI Command Catalog V1

`tcrn.cli-catalog.v1` is the additive, machine-readable register of every governed
CLI verb. The `commands` verb emits it as canonical JSON so an agent can discover
the surface without out-of-band documentation. The catalog is descriptive of the
existing dispatcher; it introduces no new authority.

## Envelope

`commands` writes `{reasonCode: "CLI_CATALOG_READY", schemaVersion:
"tcrn.cli-catalog.v1", commands}` where `commands` is a canonically ordered array
of entries. Output is byte-identical across invocations.

## Entry fields

Each entry is `{name, availability, mutates, flags}`:

- `name` — the dispatched verb.
- `availability` — `"cli"` for verbs invokable from the shipped binary, or
  `"programmatic-only"` for verbs whose handler requires an injected authority the
  shipped binary does not supply (they fail with their authority reason code when
  invoked from the binary).
- `mutates` — whether the verb appends a workspace event or writes store state.
- `flags` — each `{name, required, valueKind}`, where `valueKind` is one of
  `string`, `integer`, `boolean`, `json`, `list`, `instant`, `enum`. A flag that
  accepts an explicit null carries two optional descriptive fields:
  - `nullSentinel` — always `"-"`, the canonical spelling that means null (an
    omitted optional flag is also null). Present on `knowledge-create`
    `project-id`/`last-verified`, `work-create` `parent-id`, and
    `profile-authorize` `workspace-id`/`project-id`/`command`.
  - `deprecatedAliases` — additional spellings still accepted this release but
    slated for removal. Only `knowledge-create` `project-id`/`last-verified`
    carry it, each `["null"]`, preserving the pre-unification `"null"` spelling
    for external callers.

## Parity and stability

The catalog is the source of truth for the verb set: every dispatched verb has
exactly one entry and every entry dispatches. New verbs MUST add an entry in the
same change (enforced by the catalog↔dispatcher parity proof). Entries are
append-only; removing a flag or verb requires a new catalog version.
