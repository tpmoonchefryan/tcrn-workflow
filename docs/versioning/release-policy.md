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

## Checks a release run makes

The version commit, `release:preflight`, the push gate, the tag, publication,
reinstallation and the host smoke each stay separate stops. Three of them needed
improvising during the 1.1.3 run (TCRN-CROSS-STORY-461), and each is now a step with
a named check.

### Before the tag: stale artifacts in `dist/release`

`verify:p8` is run by both `release:preflight` and the push gate. Before it writes the
six release artifacts and asserts the closed artifact set, it moves every
`tcrn-workflow-<version>-source.tar` whose version is not the `package.json` version
to `dist/stale-release/<version>/`. Its result lists each move under
`staleReleaseArtifacts`, and an empty list means nothing was stale. Any other
unexpected file in `dist/release` is not moved and still fails
`P8_PRIVACY_RELEASE_ARTIFACT_SET`.

The step never touches `dist/evidence`. Do not clear `dist/release` with `pnpm clean`:
it also deletes `dist/evidence/push-gate-children`, which earlier gate readings cite.

### After publication: read the assets by release id

For a few minutes after a release leaves draft, `GET /repos/{owner}/{repo}/releases/tags/{tag}`
can answer with an empty asset list. On 1.1.3 it flickered between 0 and 9 assets for
about three minutes under `Cache-Control: max-age=60`, and `gh release download {tag}`
reported that there were no assets. Read by tag only to learn the release id:

1. `gh api repos/{owner}/{repo}/releases/tags/{tag} --jq .id`. An empty asset list
   in this response is not a failure.
2. `gh api repos/{owner}/{repo}/releases/{id}`. The asset names must equal the release
   candidate's asset manifest exactly, count included. Every asset must be in state
   `uploaded`, with a `digest` of `sha256:<hex>` equal to its manifest entry.
3. Download every asset from its public link
   (`https://github.com/{owner}/{repo}/releases/download/{tag}/{name}`, the asset's
   `browser_download_url`). Compare each file's SHA-256 and size with the manifest and
   with the by-id listing.

The check passes only when all three agree.

### Host smoke and other local `claude` calls: the host's own CLI

The `claude` first on `PATH` can be a standalone install older than the host running
the session. On 1.1.3 it was 2.1.266 against the host's 2.1.280, and it did not
recognise the host's model. So a smoke run, and anything else that starts `claude` on
this machine, uses the executable named by `CLAUDE_CODE_EXECPATH` when that is an
executable file. This is the choice `resolveModelCli` in `scripts/injection-session.mjs`
makes for the knowledge judge (TCRN-CROSS-STORY-459).

When no host executable is named, compare `claude --version` with the host's version
before the call. If it is lower, stop and say the version is insufficient; never fall
back silently to the older CLI. Upgrading the standalone CLI is a local installation.
That is an Owner stop and not part of a release run.

The same investigation found a separate limit: `claude -p --bare` authenticates only
through `ANTHROPIC_API_KEY` or an `apiKeyHelper`, never through the host login. A smoke
that relies on the login must not add `--bare`.

### Smoke evidence: the full argv and the environment names

Smoke evidence records the complete launch argv exactly as it was passed to the
process: the executable path first, then every flag and value, prompt included, not
a summary. It also records the names of the environment variables the child started
with. Names only: values, tokens and keys never go into evidence.

## What this does not change

Push, tag, publication and third-party account claims remain separate stops that are
never inferred from a local gate result. A green `pnpm verify:p1` says the tree is
judged; it does not say a release is due. `scripts/push-gate.mjs` still refuses a push
whose declared version has no `CHANGELOG.md` heading, no note under `docs/releases`,
and no tag ancestry -- those checks judge a release that is happening, and this
document decides whether one is.

`docs/versioning/versioning-policy.md` states what the number means once it moves.
This document states when it is allowed to, and which checks a release run makes
when it does.
