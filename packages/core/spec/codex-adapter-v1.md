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
paths under `.codex/tcrn-workflow/`. Paths and file order are a closed set and are
UTF-8-byte ordered. Contents, manifest, host, request, Context, rollback, and
bundle digests are SHA-256 bound. No ambient discovery or filesystem write exists.

The rollback manifest names only generated paths and digests. A rollback plan is
returned only when every separately observed entry is a non-symlink regular file
with `nlink=1` and exact path/content/identity digests. The product does not delete
files; a later governed installer would need no-follow descriptor binding and the
accepted cooperative clean-checkout ancestor boundary.

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
