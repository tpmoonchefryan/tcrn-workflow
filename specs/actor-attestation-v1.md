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
