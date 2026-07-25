# Operator authority supply and Workflow MCP V1

This contract supplies authority to the Workflow core, not to either adapter.
Codex and Claude Code consume the same operator mechanism. The outer trust anchor
is exactly an absolute canonical pins path plus the SHA-256 of that file's bytes.
The shipped CLI accepts those two values only as global arguments before the
command. The MCP process accepts the same pair at startup. Neither surface reads
an environment variable, prompt field, workspace default, home-directory file or
discovered configuration as authority.

## Two-file binding

The canonical `tcrn.operator-authority-pins.v1` document binds an authority ID,
one canonical authority-bundle path, the bundle's file SHA-256, a minimum
generation and a sorted set of revoked authority digests. Its own `pinsDigest`
binds those fields, while the separately supplied file SHA-256 binds the pins
bytes. The canonical `tcrn.operator-authority-bundle.v1` document carries a
validity window, active/revoked status, existing file-authority identities,
separate inert-generation and activation host inputs for Codex and Claude, the
optional pinned `codexHostActivationObservation` file identity, and two disjoint,
sorted MCP allowlists: `writeCommands` and `authorityOutputCommands`. Its
`authorityDigest` binds all those fields. A command may appear in neither list or
in exactly one list; overlap is invalid rather than a precedence rule. The catalog
enforces the mirror image of that rule on the FLAG side: a command declares
`mutates` or `authorityBearing`, never both. MCP resolves the write category first,
so a both-category entry would be satisfied by a `writeCommands` grant alone, and
the catalog therefore refuses to load one (`CLI_CATALOG_CATEGORY_AMBIGUOUS`); the
published catalog schema states the same exclusion.

Rotation writes a new bundle generation and advances the pinned document.
Revocation advances the pins document to name the revoked authority digest or
marks a newly pinned bundle revoked. A bundle below `minimumGeneration`, outside
its validity window, with a mismatched ID, revoked digest, changed bytes, link,
special file, noncanonical JSON or unadmitted host input fails closed. Retaining
the newest outer pins digest is the anti-rollback boundary; an old pins file plus
its old digest remains an old authority root and is not magically revoked by a
different file. This is explicit rather than overclaimed as global revocation.

The bundle does not replace the narrower authorities it carries. Profile,
context, compatibility and installation receipts still pass through their
TOCTOU-hardened readers. Adapter host inputs still pass through their branded
admission validators, remain bound to exact request/context/action digests, and
have their context validity window rechecked against the operator verification
time so a once-valid host input cannot be replayed from a longer-lived bundle.
Supplying both programmatic authority and operator pins is ambiguous and rejected.
The activation observation file is separately descriptor-bound and canonical. It
is not a self-attested JSON input: a host activation receipt can use either that
pinned file or a real, WeakSet-branded activation-host context admitted from the
independent activation authority. In both cases the observation binds the active
installation receipt, activation authority, activation-host digest, exact hook
definition, approved definition set, host/session/event/fire facts and evidence
digest. The derived v2 receipt additionally binds the observation digest, evidence
source, and (for the file route) the file SHA-256 and source identity digest.
Neither route accepts an unbounded observation instant. An observation admitted
through a branded activation-host context must have `observedAt` inside that
context's `[contextIssuedAt, contextExpiresAt)` window, which the bound
`hostDigest` covers and so cannot be widened after the fact. An observation
admitted through the pinned file must have `observedAt` inside the bundle's own
`[issuedAt, expiresAt)` window and at or before the operator verification time.
The bound is deliberately the operator's declared window rather than a fixed
maximum age: without it the same pinned bytes could be re-pinned under each new
bundle generation and mint a fresh `host_observed_active` receipt
indefinitely, which is the replay this contract already refuses for host
inputs. A stale, future-dated or unbounded observation refuses with
`CODEX_ACTIVATION_OBSERVATION_STALE` or
`CODEX_ACTIVATION_HOST_OBSERVATION_REQUIRED`.

## Retest of the historical twelve

The README's twelve-verb statement described the IO-blocked surface before the
digest-at-call-site work and before `claude-adapter-uninstall` existed. Five of
those twelve later gained direct digest flags. The new uninstall verb shipped
with the same direct pin. Immediately before this contract, seven command verbs
still depended solely on in-memory `CliIo`: `adapter-generate`,
`claude-adapter-activation-fragment`, `claude-adapter-generate`,
`claude-adapter-install`, `claude-adapter-settings-fragment`,
`compatibility-dry-run` and `compatibility-plan`. Operator pins supply all seven.
Per-command digest flags remain available and are rejected when mixed with a
bundle-supplied authority.

## Host-neutral MCP surface

`tcrn-workflow-mcp` is a newline-delimited JSON-RPC stdio server. It implements
MCP initialize, ping, tools/list and tools/call and derives every tool input schema
from the canonical command catalog. JSON values arrive as JSON, lists as arrays,
integers as integers and booleans as booleans; the facade performs no shell
construction. Fixture-only commands are absent.

Read-only tools can operate without an authority bundle when the underlying CLI
command needs none. A read that needs an existing authority still fails with that
command family's reason code unless pins supply it. Every mutating MCP tool
requires the current bundle to grant that exact command in `writeCommands`.
Authority-bearing output is a separate category: it is not a write, but it can
produce a receipt that carries authority. `adapter-activation-record` is the only
such command and requires an exact `authorityOutputCommands` grant before MCP
parses caller arguments. The category is enforced against emitted bytes, not the
declaration: every CLI write passes an output-category boundary that refuses
`CLI_AUTHORITY_OUTPUT_UNDECLARED` when a verb that declares neither `mutates` nor
`authorityBearing` emits a guarded host-state field or state token (INC-012).
A write grant never authorizes it. Its MCP descriptor is
therefore neither read-only nor destructive. The command accepts an activation
receipt, an optional direct receipt digest, and an observation-file path; old
inline `approved-definition-digests` and `observation` JSON flags are unknown.
The canonical CLI reads the installation receipt through its supplied authority
and reads the observation only through the bundle-pinned file identity, unless a
programmatic caller supplies the separately branded activation-host observation
context. No raw object, forged object, structured clone, or zero-grant call can
mint `host_observed_active`.

The MCP facade then calls the canonical CLI with the caller's exact
`expected-version`, `at`, `actor` and other fields. It never derives CAS from
head, invents time, substitutes an actor, retries a refusal or changes a reason
code. Core and CLI validation therefore remain the authority on workspace
mutation.

The server is offline and has no network transport. It is an operator surface,
not an adapter, orchestrator, controller, identity provider or source-code
transaction manager.

This mechanism also does not upgrade actor attestation or time. An MCP caller
must still supply the command's explicit actor and RFC 3339 instant; Workflow
records the declared actor and the injected local-clock evidence under their
existing contracts. Neither becomes authenticated identity or externally
attested wall-clock truth merely because the command arrived through pinned MCP.
