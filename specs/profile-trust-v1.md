# Profile Trust V1

Profile-trust documents conform to `profile-trust-v1.schema.json`. They bind a
stable profile and issuer to a strict validity interval, inclusive protocol
window, and capability digest. They do not replace the external Release Trust
Root V1 authority or admit release mode.

The interval is non-empty: `issuedAt` must be strictly earlier than `expiresAt`
after exact offset normalization to epoch nanoseconds. Equal instants,
including differently spelled offsets, and inverted windows fail with
`VERSION_WINDOW_INVALID`; no host date parser participates.

Candidate-controlled profiles cannot elevate maturity, invent compatibility,
or replace external release trust.
