# Conference execution provenance (v1)

INIT-010 EPIC-019. Additive to the frozen `tcrn.conference.v1` records. Nothing here
changes an accepted schema: `executionMode` rides the conference request's
`extensions` slot, and the host-execution receipt is a new standalone record type.

## What it distinguishes

A conference position is a block of text attributed to a role. Nothing in
`tcrn.conference.v1` says whether the eight positions in a conference came from eight
genuinely independent reasoning contexts or from one context writing all eight. Both
are legitimate — synthesis by a single context is often the right, cheaper choice —
but they must not be confused, because "eight independent roles agreed" is a far
stronger claim than "one context wrote eight roles' worth of argument."

`executionMode` makes the distinction explicit and, for the strong claim,
substantiated:

- **`synthesis-only`** — the positions were composed by a single context. On an
  `architecture` or `strategy` conference this is the exception and must carry a
  stated `synthesisReason`.
- **`multi-agent-deliberative`** — the positions came from independent fresh-context
  invocations, and each such position is bound to a host-execution receipt.

## The host-execution receipt (`tcrn.host-execution-receipt.v1`)

A receipt binds one position to one real host invocation:

- host product and version, session, optional thread and turn, and a distinct
  `agentInvocationId`;
- `freshContext` — whether the invocation ran in a genuinely fresh context;
- `invokedAt`, a `promptDigest`, and an `outputDigest`;
- an `availability` grade (`enforce` / `observe` / `invoke-only` / `unavailable`),
  shared with the EPIC-021 capability manifest vocabulary.

**Opaque, but not empty.** `sessionId`, `threadId` and `turnId` are host-owned and are
deliberately *not* held to TCRN's protocol-id grammar — Codex 0.139.0 emits bare UUIDs
with no namespace, and forcing the grammar here would make real collector output
unprojectable. "Opaque" is not "anything": a host id is well-formed Unicode, at least
four characters (the shortest string the protocol-id grammar itself admits), at most 512
UTF-8 bytes, and carries no whitespace, control character or invisible format character
anywhere — leading, trailing or interior. A single space is not an identifier.

**Attribution, not identity.** `outputDigest` is an unkeyed SHA-256 of the
invocation's final assistant message. It proves the position text was not edited after
the fact and did come from the bound invocation's output; it does **not** prove who
authored the invocation. The receipt carries a fixed `attributionNote` saying so, and
no code path upgrades a content digest into an identity claim.

## Classification and fail-closed validation

`classifyConferenceExecution` takes a conference, its positions, and any receipts, and:

- returns **`legacy-unverified`** when there is no `execution:mode` extension — a
  legacy conference is never retroactively presented as multi-agent;
- requires a `synthesisReason` for a `synthesis-only` `architecture`/`strategy`
  conference (`EXECUTION_SYNTHESIS_UNMARKED`);
- for `multi-agent-deliberative`, requires at least two positions each bound via an
  `execution:receipt` extension to a **distinct** receipt whose `freshContext` is true
  and whose `outputDigest` equals the SHA-256 of the position text
  (`EXECUTION_INDEPENDENCE_REQUIRED`, `EXECUTION_RECEIPT_STALE_CONTEXT`,
  `EXECUTION_BINDING_MISMATCH`).

A declared mode that is not substantiated fails closed. The default read — absence of
a claim — is `legacy-unverified`, never a claim.

**Consistency, not authenticity.** The classifier verifies that every bound position's
text matches its receipt's output digest and that the bound receipts name distinct
fresh-context invocations. It does **not** verify that the receipts came from genuinely
independent hosts. Because the binding is an unkeyed content digest, a single context
that fabricates its own receipt set will pass this check — it proves the positions were
not edited to disagree with the receipts, not that two independent agents ran.
Authenticity is the trusted collector's responsibility (EPIC-020, which records
receipts from a real host as work happens); this classifier is the consistency gate that
a real collector's output must also clear. A caller supplying its own receipts gets a
consistency check, not a trust guarantee. Receipts are re-validated inside the
classifier, so it never relies on a caller's type assertion alone.

## Scope

This is the protocol and validation only. Collecting receipts from a live host
(binding a real subagent invocation's transcript into a receipt) is EPIC-020, and is
excluded here. There is no orchestration, no store, and no network. Records persist,
when used, through the existing governed workspace event log.

Proof: `pnpm verify:ext-execution`
(`tests/conference-execution.test.mjs`,
`packages/core/fixtures/conference-execution-cases.json`).
