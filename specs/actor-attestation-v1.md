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
version: 1}`. From the event immediately after the enable event onward, an actor is
mandatory and fail-closed on every event; events at or before the enable event
remain exactly `{operation, record}`. Enablement is one-way — v1 defines no
disable operation — so an attested workspace is a permanent property.

## WS-D contract

The dependency, conference, gate, and other WS-D event operations append through
the same event log and the shared payload constructor, so they inherit actor
enforcement without defining their own mechanism. This spec defines the contract
only; the enforcement sweep is a separate governed change.
