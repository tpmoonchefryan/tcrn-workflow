# Inert Codex Adapter V1

## Status and scope

This V1 contract implements an inert, deterministic bridge from an already
validated Context Router result to a four-file template bundle. The V1 generator
itself does not install or activate `.codex`, hook, configuration, Skill, agent,
store, network, database, AOS, or runtime state. Additive INIT-009 modules now
consume this unchanged inert bundle for a governed Step-1 install and a separately
approved SessionStart activation; those operations do not weaken or reinterpret
this V1 generation contract.

## Admission

The closed request carries one validated Context Router result and three bounded
untrusted text fields: prompt, environment, and raw-session text. Those strings
are hashed only and cannot select identity, profile, scope, risk, budgets,
operations, explicit reads, model, tools, paths, or activation.

Generation separately requires a deeply frozen host context injected outside the
CLI request bytes. It binds the canonical request and Context digests, exact
Workspace/project/work target, `generate` action, inert-only target, and
`activationAllowed=false`. It also binds a strict Context issued/expiry window;
stale or not-yet-valid use fails closed. The bridge revalidates the complete
Context result and its binding. CLI flags cannot populate the host context.

## Bundle

The output is canonical inert JSON data for exactly four repository-relative
paths under `.codex/tcrn-workflow/`. Paths and file/rollback array positions are
a closed ordered tuple. Every template byte string must equal
`canonicalJson(JSON.parse(bytes))` exactly; whitespace, alternate key ordering,
and alternate JSON escape spellings fail even when all enclosing digests are
resealed. Contents, manifest, host, request, Context, rollback, and bundle
digests are SHA-256 bound. No ambient discovery or filesystem write exists.

Draft 2020-12 proof registers executable UTF-8-byte, recursive well-formed
Unicode, canonical-JSON-string, and complete runtime-bundle keywords. It checks
the complete bundle tuple plus explicit request, host, lifecycle, and
installation-receipt parity matrices. The instant regex remains structural;
runtime strict-instant and validity-window checks remain the semantic authority.

The rollback manifest names only generated paths and digests. Caller-supplied
identity objects confer no authority. A rollback plan requires a separately
admitted installation-generation receipt at an out-of-band pinned canonical path
and raw file digest. The reader binds the receipt and every synthetic installed
entry through `lstat`, `O_NOFOLLOW`, regular/single-link checks, pre/open/post and
named dev+ino+size+mtime+ctime identity, realpath, and raw content digest. The
receipt binds generation, bundle, installation root, exact paths, realpaths,
content digests, and descriptor-derived identity digests. Copied, replaced,
linked, special, changed, wrong-path/digest, or mismatched-generation evidence
fails closed. Receipt source bytes must equal `canonicalJson(receipt)` directly,
including its single terminal LF; double-LF and other leading/trailing whitespace
fail even when the out-of-band raw file digest is recomputed. The product returns
a plan only and never deletes files. Ancestor
replacement remains under the accepted cooperative clean-checkout boundary.

## Fallback and final hop

Raw-session/no-context fallback is authority-empty, operation-null, and requires
governed routing. It returns only input digests. Stop/final-hop simulation emits
at most one owner-visible response after successful governed routing, preserves a
required final hop after Stop, blocks failed routing, and identifies duplicates.
Receipts and simulation never retain raw prompt, session, body, private-path,
credential, model, or owner-private material. This is focused structural privacy,
not general DLP.

## Residuals

The V1 output remains uninstalled and unactivated until a caller takes a separate
governed route. `codex-adapter-installer.ts` provides the descriptor-bound inert
install. `codex-adapter-activation.ts` then permits exactly one fail-open
SessionStart definition, with the installer-admitted canonical absolute handler
path and a digest-bound 1024-byte Workflow summary. The summary binds no Core
Reference persona, does not make the main thread read-only, and does not revoke
explicit user authorization for ordinary repository work. The installation root is part
of the generated artifact and definition digest and is re-admitted and compared
before installation, so the definition is machine specific and cannot inherit a
different fire-time cwd. The interpreter is not pinned: the command's first token is
the bare name `node`, which is resolved through the fire-time PATH, so a PATH entry
ahead of the real interpreter substitutes it while the approved handler argument stays
correct. The handler's own byte self-check cannot detect this, because a substituted
interpreter never reads the handler. The substitution is executed on both hosts by
`pnpm verify:act12`, so the residual is measured rather than assumed; it is disclosed,
not closed. Before
any activation file is written, a distinct branded host input must bind the
canonical request and Context, exact Workspace/project/work, validity window,
Step-1 installation receipt, capability manifest and requested Step-2/Step-3
rung. The inert generation authority is deliberately unusable here because it
says `activationAllowed=false`. A separate operator approval-and-fire receipt
still remains necessary after installation. Installation never proves host
activation, Codex's internal trust hash remains opaque, and changing the root or
any command byte requires a fresh host review. No PreToolUse
enforcement, Controller, OS-level parent-component race defense, or release-byte
claim is added to this V1 specification.

The optional App Server execution collector consumes only caller-supplied,
protocol-pinned notifications plus captured same-connection
`thread/read(includeTurns=true)` responses. It binds `item/started` and
`item/completed` spawn lifecycle to the named receiver, readback session/parent/
fork/creation facts, first-turn lifecycle and byte-matched `phase=final_answer`
output. A child `thread/started` notification is optional; no synthetic frame is
created. Missing evidence returns `unavailable`, while mismatched/replayed or
cross-session evidence fails closed. The collector never opens App Server,
invokes an agent, proves actor identity or treats notification absence as proof
of non-occurrence. S057's separate bounded live harness proves one exact
stream/readback receipt comparison without adding host-driving code here.
