# Release Policy

A release is an event this repository responds to, not a rhythm it keeps. Nothing
here schedules one, and no amount of merged work causes one.

## When a release happens

Exactly three events trigger a release. Each is something outside this repository's
own convenience, and each is observable by someone other than the person cutting it.

| Trigger | What counts | What does not |
| :--- | :--- | :--- |
| **Protocol change** | A schema identifier, trust contract, event-record shape, or CLI contract that a consumer compiles against changes | An internal refactor, a new verb that no consumer pins, a comment |
| **Host format break** | A supported host changes a format this repository must produce or parse -- a hook payload, a settings shape, a session-start contract | A host version bump this repository parses unchanged |
| **Security fix** | A defect with a security consequence in the shipped bytes | A hardening improvement with no defect behind it |

**No event, no release.** A merged fix, a green gate train, a passing suite, and a
quiet week are each a reason to keep working and none of them is a reason to cut a
version. The default state between two releases is "no release is pending".

## What the version number tracks

The version number advances **only on a protocol change**. It names what a consumer
compiles against, so it moves when that thing moves and stays still otherwise.

The other two triggers ship without advancing it in their own right: a host format
break and a security fix are released against the version the protocol is already
at, unless the fix itself changes the protocol, in which case the first rule applies.

## Consequences that used to be per-version work

| Practice before | Practice now |
| :--- | :--- |
| A file per version under `docs/releases` | `docs/releases` stops gaining a file per change. A note is written for a release that actually happened, and the directory's existing files stay as the record of releases that did |
| Badges restating the version and three derived counts, in five README files | The badge block retired in TCRN-CROSS-STORY-360. `scripts/push-gate.mjs` holds the version in prose in `README.md` and nowhere else |
| Four locale mirrors of each human-facing root document, re-pinned to their English source on every edit | Root documents are single-language. `README.md` is Simplified Chinese and authoritative; the other root documents are English |
| The helper repository re-pinned to each engine version as it was cut | Re-pinning follows a release, and releases follow the table above. The helper-side mechanism is TCRN-CROSS-STORY-382's to retire |

## What this does not change

Push, tag, publication and third-party account claims remain separate stops that are
never inferred from a local gate result. A green `pnpm verify:p1` says the tree is
judged; it does not say a release is due. `scripts/push-gate.mjs` still refuses a push
whose declared version has no `CHANGELOG.md` heading, no note under `docs/releases`,
and no tag ancestry -- those checks judge a release that is happening, and this
document decides whether one is.

`docs/versioning/versioning-policy.md` states what the number means once it moves.
This document states when it is allowed to.
