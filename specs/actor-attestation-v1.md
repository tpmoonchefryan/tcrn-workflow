# Actor Attestation V1

`tcrn.actor-attestation.v1` is an additive attestation contract for binding each
workspace event to an accountable actor. It registers through
extension-registration-v1 with `appliesTo: ["event"]` and
`requiredByDefault: false`, carries its own `schemaDigest`, and changes no frozen
schema: event-integrity-v1's payload is already an unconstrained value, so the
actor travels inside the payload with no envelope version change.

## Payload shape

An event payload is `{operation, record}` before attestation is enabled and
`{operation, record, actor}` after. `actor` is a protocol stableId whose prefix is
one of the allowlist `owner:`, `profile:`, `agent:` (the `owner:` form reuses the
knowledge-core accountable-owner convention). Any other prefix, uppercase, or
non-stableId value fails closed with `ACTOR_ID_INVALID`. Every event-appending
operation constructs its payload through the one shared constructor so no
operation can carry an unvalidated or absent actor once enforcement is on.

## Enablement

Attestation is turned on by appending a chain event with operation
`attestation.actor.enabled` and record `{schemaVersion: "tcrn.actor-attestation.v1",
version: 1}`. Let `enabledAtSequence` be that event's sequence. From
`enabledAtSequence` onward — the enabling event itself included, since it carries
the enabling actor — a valid actor is mandatory and fail-closed on every event;
every event whose sequence is strictly below `enabledAtSequence`, and every event
in a workspace that never enables attestation, remains exactly `{operation,
record}`. The boundary is `sequence >= enabledAtSequence`, so the very event that
turns attestation on is the first that requires an actor. Enablement is one-way —
v1 defines no disable operation — so an attested workspace is a permanent
property, and a second `attestation.actor.enabled` event is a corrupt chain.

## Enforcement

Enforcement is live in the engine (WSE-2). The single event-append path requires
and validates the actor once attestation is enabled (or on the enabling event
itself), failing closed `WORKSPACE_ACTOR_REQUIRED` when it is absent and
`WORKSPACE_ACTOR_INVALID` when its format is rejected; supplying an actor before
enablement fails closed rather than being silently dropped. The replay reducer
re-derives `enabledAtSequence` from the chain in one pass and re-enforces the
identical rule with the identical reason codes, so a hand-tampered event log that
drops or forges an actor after enablement cannot bypass validation. The actor is
part of the hashed payload, so any on-disk tamper of the field is additionally
caught as `WORKSPACE_EVENT_CORRUPT` by the event-chain hash check. Default
behaviour — no enable event ever appended — leaves derived state and export bytes
byte-identical to a pre-attestation workspace.

## WS-D contract

The dependency, conference, gate, and other WS-D event operations append through
the same event log and the shared payload constructor, so they inherit actor
enforcement without defining their own mechanism.

## CLI surface (WSE-3)

The CLI exposes the attestation contract through two additions, both over the
WSE-2 engine exports; the CLI adds no actor vocabulary of its own.

- `attestation-enable --workspace <root> --expected-version <n|head> --at <instant>
  --actor <stableId>` appends the one-way `attestation.actor.enabled` chain event
  under a held lease. All four flags are required. The `--actor` supplied here is
  the enabling actor carried by the enabling event itself (the boundary event).
  Re-running it on an already-attested workspace fails closed
  `WORKSPACE_INPUT_INVALID`.
- `--actor <stableId>` is an optional flag on every workspace-event mutation verb
  — `project-create`/`-update`/`-delete`, `work-create`/`-transition`/`-delete`,
  and the conference/gate verbs `conference-open`/`-append-position`/`-close`/
  `-cancel`, `gate-create`/`-transition`/`-delete`. It is declared
  catalog-optional (`required: false`) because before enablement it is genuinely
  optional and after enablement the engine — not the CLI — makes it mandatory. The
  static command catalog cannot express "required only after the enable event", so
  the CLI never marks `--actor` required and never duplicates the enforcement:
  omitting it on an attested workspace surfaces the engine's
  `WORKSPACE_ACTOR_REQUIRED`, and an unlisted prefix surfaces the engine's
  `WORKSPACE_ACTOR_INVALID`. A supplied `--actor` on a non-enabled workspace is a
  no-op, so legacy no-actor invocations stay byte-identical.

`conference-append-position` additionally carries `--actor-id`, the conference
position's author recorded in the position document. That is a distinct field
from `--actor`, the acting identity attested on the event. The two reach the core
through one shared `actorId` slot, so on this verb the default path (no `--actor`)
keeps the position author as the acting identity unchanged, and a supplied
`--actor` takes precedence as the acting identity.

### Non-claim

`--actor` is an asserted identity that is format-checked against the prefix
allowlist only. It is **not** an authenticated identity in v1: the CLI does not
verify the caller against any admission receipt or profile authority, and the
attestation records who a caller *claims* to be, not a proven identity. Binding
`--actor` to the profile-admission authority is deliberately deferred to a future
version with its own threat model.
