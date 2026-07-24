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
SessionStart definition, with a digest-bound 1024-byte advisory summary. Before
any activation file is written, a distinct branded host input must bind the
canonical request and Context, exact Workspace/project/work, validity window,
Step-1 installation receipt, capability manifest and requested Step-2/Step-3
rung. The inert generation authority is deliberately unusable here because it
says `activationAllowed=false`. A separate operator approval-and-fire receipt
still remains necessary after installation. Installation never proves host
activation, Codex's internal trust hash remains opaque, and no PreToolUse
enforcement, Controller, OS-level parent-component race defense, or release-byte
claim is added to this V1 specification.

The optional App Server execution collector consumes only a caller-supplied,
protocol-pinned notification stream. It derives `freshContext=true` only from a
non-forked subagent thread created after the matching spawn completes, and
accepts only a `phase=final_answer` item whose completion falls inside the
completed first turn. Missing evidence returns `unavailable`; the collector
never opens App Server, invokes an agent, proves actor identity or treats
notification absence as proof of non-occurrence.
