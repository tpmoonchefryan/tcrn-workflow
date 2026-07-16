# Inert Claude Code Adapter V1

## Status and scope

This candidate implements an inert, deterministic bridge from an already validated
Context Router result to a four-file template bundle for the Claude Code host. It
does not install or activate `.claude`, hook, configuration, Skill, agent, store,
network, or runtime state. It is the host-specific sibling of the inert Codex
Adapter; the two share host-neutral machinery byte-for-byte and diverge only at an
enumerated host surface (template path prefix, host identity, and the settings hook
fragment). OG-04 remains unsatisfied and RC3 remains unaccepted.

## Admission

The closed request carries one validated Context Router result and three bounded
untrusted text fields: prompt, environment, and raw-session text. Those strings
are hashed only and cannot select identity, profile, scope, risk, budgets,
operations, explicit reads, model, tools, paths, or activation. The request shape
mirrors the Codex adapter request exactly, differing only in its schema version.

Generation separately requires a deeply frozen host context injected outside the
CLI request bytes. It binds the canonical request and Context digests, exact
Workspace/project/work target, `generate` action, inert-only target,
`activationAllowed=false`, the host product literal `claude-code`, and a bounded
host version readback supplied as data. The host version is never obtained by
invoking a binary; a mismatched host product fails closed. It also binds a strict
Context issued/expiry window; stale or not-yet-valid use fails closed. The bridge
revalidates the complete Context result and its binding. CLI flags cannot populate
the host context.

## Bundle

The output is canonical inert JSON data for exactly four repository-relative
paths under `.claude/tcrn-workflow/`. Paths and file/rollback array positions are
a closed ordered tuple. Every generated path is a project-local writable path;
absolute, home-anchored (`~`), parent-escaping, and any user-level `.claude`
location fail closed with a stable forbidden-path reason. Every template byte
string must equal `canonicalJson(JSON.parse(bytes))` exactly; whitespace,
alternate key ordering, and alternate JSON escape spellings fail even when all
enclosing digests are resealed. Contents, manifest, host, request, Context,
rollback, and bundle digests are SHA-256 bound. No ambient discovery or filesystem
write exists.

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
a plan only and never deletes files.

## Settings hook fragment

A separate inert settings fragment names the four project-scoped hook events —
`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `Stop` — that a governed
activation would merge into user-owned `.claude/settings.json`. The fragment is
data only and is never written by this module. Merge inserts a single namespaced
key into canonical user settings and refuses to clobber pre-existing content or
a pre-existing fragment key; remove strips exactly that key. Merge and remove are
exact byte inverses over canonical settings text, so a governed apply is fully
reversible: removing a merged fragment restores the original settings bytes
byte-for-byte. Non-canonical settings input fails closed.

## Fallback and final hop

Raw-session/no-context fallback is authority-empty, operation-null, requires
governed routing, and selects the `claude_md_only` governed mode (no hook
activation). It returns only input digests. Stop/final-hop simulation emits at
most one owner-visible response after successful governed routing, preserves a
required final hop after Stop, blocks failed routing, and identifies duplicates.
Receipts and simulation never retain raw prompt, session, body, private-path,
credential, model, or owner-private material. This is focused structural privacy,
not general DLP.

## Cross-host parity

One canonical request feeds both the Codex and Claude generators. The host-neutral
projection — activation, reason code, Context digest, file count, per-entry
rollback policy fields, and manifest mode — is byte-identical across the two
bundles. The host-specific surface — bundle/request/host digests, template path
prefix `.codex/`→`.claude/`, host identity, and the hook fragment — differs only at
enumerated positions. The Codex adapter source is bound into the Claude proof so
any change to either adapter re-runs the parity check.

## Residuals

Templates remain uninstalled and unactivated. There is no live hook behavior,
OS-level parent-component race defense, host activation, or owner-visible
capability claim. Installation, activation, OG-04, RC3, and P6B closeout require
separate governed routes.
