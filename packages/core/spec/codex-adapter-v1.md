# Inert Codex Adapter V1

## Status and scope

This candidate implements an inert, deterministic bridge from an already validated
Context Router result to a four-file template bundle. It does not install or
activate `.codex`, hook, configuration, Skill, agent, store, network, database,
AOS, or runtime state. OG-04 remains unsatisfied and RC3 remains unaccepted.

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

Templates remain uninstalled and unactivated. There is no live hook behavior,
OS-level parent-component race defense, Codex activation, or owner-visible
capability claim. Installation, activation, OG-04, RC3, and P6 closeout require
separate governed routes.
