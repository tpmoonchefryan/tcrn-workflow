# Context Router V1

## Scope

Context Router V1 is a standalone, deterministic, metadata-first projection over
explicitly supplied candidates. It creates no store, reads no legacy Workflow
source and performs no network or database access. The separately verified Codex
Adapter consumes only a validated result and remains inert; this Router does not
activate hooks, Skills, raw-session authority, or RC3 acceptance.

## Trusted admission

Routing requires two independently admitted inputs:

1. the accepted generic-profile admission context read through its pinned
   canonical path and out-of-band file SHA-256; and
2. a Context Router authority receipt read as a regular, single-link file with
   `O_NOFOLLOW`, pre/open/post identity binding, canonical bytes, a pinned path,
   and an out-of-band file SHA-256.

The Context Router authority binds the normalized request digest, generic-profile
admission receipt and effective digests, exact Workspace/project/work target,
task kind, minimum risk, maximum budgets, explicit-read allowlist, and validity
window. Caller-recomputed effective objects and caller-created receipt files do
not confer authority. Profile resolution and `profile.read` authorization are
re-run inside routing against the admitted profile context.
The admitted authority object and its nested budget and explicit-read allowlist
graphs are deeply frozen before exposure or routing use. The explicit-read
allowlist is capped at 32 entries in both schema and runtime.

Prompt and environment text are untrusted query data. They cannot select a
profile, trust level, binding, scope, risk tier, budget, explicit read, operation,
or authority. Configuration below owner authority is restrict-only through the
accepted generic-profile merge and admission contract.

## Progressive selection

Requests are closed objects. Metadata candidates and explicit body/procedure
candidates have closed fields, canonical digests, exact scope bindings, freshness,
and retention class. Candidate and request arrays normalize by the frozen UTF-8
byte comparator before request hashing and selection.

Selection is exact and metadata-first:

- cross-Workspace/project/work candidates fail closed;
- fresh metadata and references are selected in canonical ID order;
- stale and unknown metadata are excluded with stable reasons;
- body and procedure content appears only when its ID is separately requested,
  present, fresh, and allowlisted by the admitted authority;
- no implicit store walk or whole-corpus scan occurs.

Fixed injection, authority, summary, body/procedure, receipt, and reference limits
are independently bounded. Candidate counts are capped at 128 metadata and 32
explicit-read candidates. Query data is capped at 4,096 UTF-8 bytes. Cumulative
count and UTF-8 byte budgets are checked before inclusion.
Schema proof registers the annotation keyword `x-tcrn-maxUtf8Bytes` so the
runtime byte limits are executable rather than attributed to stock JSON Schema
`maxLength`, which counts Unicode code points.
The request, authority, and result roots additionally require the executable
`x-tcrn-deepWellFormedUnicode` keyword; runtime performs the same recursive
high/low-surrogate rejection before other semantic admission.

## Receipt and privacy

The canonical receipt binds the normalized request digest, admission and
authority digests, selected metadata/reference/explicit-read digests, exact budget
use, exclusions, retention class, and final context digest. Default retention is
`metadata_only_ephemeral`. The receipt never copies raw query text, body or
procedure content, credentials, authenticated URLs, local paths, thread/session
history, model settings, or owner-private prose. This is a focused structural
privacy boundary, not a general DLP scanner.
Authority-receipt source bytes must equal `canonicalJson(receipt)` directly,
including its single terminal LF; fully rehashed leading, trailing, or double-LF
variants fail closed.
Result validation recomputes every fixed-injection, authority, metadata summary,
reference, explicit body/procedure, and receipt byte/count usage field from the
included canonical result; resealed under- or over-reporting fails closed.

## Determinism and performance

The property proof executes at least 64 distinct candidate input orders and
requires identical normalized context bytes, context digest, and receipt. The
pinned Node proof observes fixed-injection, authority-evaluation,
metadata-selection, explicit-body, receipt, and full-corpus stage latency against
generous fixed ceilings. These measurements are local process observations, not
real-time or production service guarantees.

## Status

Context Router is implemented only after `pnpm verify:p6` returns
`P6_CONTEXT_ROUTER_VERIFIED`. The Codex Adapter is implemented only as separately
verified inert templates, RC3 remains unaccepted, and no owner-visible activation
is claimed.
