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
separate inert-generation and activation host inputs for Codex and Claude, and an
exact MCP write-command allowlist. Its `authorityDigest` binds all those fields.

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
requires the current bundle to grant that exact command. The MCP facade then calls
the canonical CLI with the caller's exact `expected-version`, `at`, `actor` and
other fields. It never derives CAS from head, invents time, substitutes an actor,
retries a refusal or changes a reason code. Core and CLI validation therefore
remain the authority on workspace mutation.

The server is offline and has no network transport. It is an operator surface,
not an adapter, orchestrator, controller, identity provider or source-code
transaction manager.

This mechanism also does not upgrade actor attestation or time. An MCP caller
must still supply the command's explicit actor and RFC 3339 instant; Workflow
records the declared actor and the injected local-clock evidence under their
existing contracts. Neither becomes authenticated identity or externally
attested wall-clock truth merely because the command arrived through pinned MCP.
