# TCRN Workflow Portal

A local, zero-dependency portal for the parts of TCRN Workflow a person
configures most: workspace settings, the canonical `AGENTS.md` prose, and a
reconciliation check between the two.

The portal is installed at `~/.tcrn-workflow/portal` for machine-level use.
There is no package dependency to install and nothing to build.

```bash
node ~/.tcrn-workflow/tcrn-workflow/portal/portal.mjs --container <platform>/.tcrn-workspace
# → http://127.0.0.1:4319/
```

The container contains one directory per partition, each with a governed
`workspace/` child and (for attested writes) an `attestations/` child. The page
lists every discovered partition and switches the live CLI read/write target
from its selector.

## What it is

Two files do the work: `index.html` (a self-contained page — inline CSS and JS,
no bundler, no framework, no external request) and `portal.mjs` (a Node server
using only the standard library). In container mode the portal discovers
partitions from the container layout; it does not import the engine or write a
control tree itself.

## The boundary it keeps

The portal owns no governance logic. Every settings read and write is a child
process call to the public CLI (`settings-catalog`, `settings-set`), so a value
on screen is the engine's answer and a write is answered with the engine's own
receipt — reason code, chain version, receipt digest, head event hash. The
portal never imports an engine package, never touches a control tree, and never
writes a chain file itself. `scripts/dependency-audit.mjs` proves the first of
those over the whole repository and fails if any source file imports an engine
internal.

`AGENTS.md` is ordinary repository prose, so the prose surface edits it with
plain file I/O. It is the one canonical home for custom rules; per the platform
convention it defines *how work is done*, never *who may decide*.

## Why a process rather than a bare page

Opening `index.html` from disk would drop the three things that make this more
than a mockup: a live catalog instead of a snapshot, a real receipt instead of a
rendered guess, and a reconciliation that actually runs. Governed writes require
compare-and-swap against the live head and an attested actor — a browser cannot
supply either.

## Safety

The server binds `127.0.0.1` only. Each run mints a token, injects it into the
page, and refuses any mutating request without it, so another page in the same
browser cannot post to it. The acting identity is declared at startup
(`TCRN_PORTAL_ACTOR`, default `agent:portal`); a browser payload can never
nominate who wrote to a chain.

## Languages

The portal ships copy for every locale the platform supports — `zh-CN`, `en`,
`ja`, `ko`, `fr`. The locale contract originates in `@tcrn/ui-copy-state` and is
frozen into `locale-contract.mjs`, the same arrangement `tokens.css` already uses
for the token bytes: the design system is the source of truth at development time
and is not present at runtime. A running portal reads nothing outside its own
directory, so nobody has to check out the design system to open a settings page. That contract marks all five `copyCoverage: "required"`, so
`scripts/i18n-proof.mjs` fails on a missing key rather than filing it as a gap.
The picker follows the browser's languages on first run and remembers the
choice; each locale also points `--tcrn-type-family-ui` at its script's family,
following the design system's own pattern.

Engine reason codes are never used as interface labels (the contract sets
`rawEnumLabelsAllowed: false`). They appear in the receipt panel, marked as
evidence, where reproducing them verbatim is the point.

## Surfaces

- **Config** — the registered settings catalog; commit one change and keep its receipt beside the CLI readback.
- **Prose** — read and write the canonical `AGENTS.md`.
- **Reconcile** — every setting key the prose claims, checked against the keys the engine registers; red when prose names one that does not exist.

## Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--workspace` | *(one target required)* | One governed workspace path |
| `--container` | *(one target required)* | Container whose `<partition>/workspace` children are selectable |
| `--partition` | first discovered partition | Initial partition in container mode |
| `--prose-root` | container parent | Directory holding `AGENTS.md` |
| `--port` | `4319` | Loopback port (`0` picks a free one) |
| `TCRN_PORTAL_ACTOR` | `agent:portal` | Actor recorded on governed writes |
| `--attest-dir` | *(unset)* | Attestation directory passed through to writes |
| `TCRN_WORKFLOW_CLI` | `~/.tcrn-workflow/tcrn-workflow/scripts/tcrn-workflow.mjs` | CLI entry point |

## Launchers

The initialization step writes ordinary, reviewable files to the platform
root. Paths are absolute and the files are never symlinks:

```bash
node ~/.tcrn-workflow/portal/scripts/generate-launchers.mjs \
  --container "/path/to/platform/.tcrn-workspace" \
  --output-dir "/path/to/platform" \
  --prose-root "/path/to/platform" \
  --port 4319
```

This generates `tcrn-workflow-portal.command` for macOS,
`tcrn-workflow-portal.sh` for Linux, and `tcrn-workflow-portal.cmd` for
Windows. The Windows launcher shape is generated here; full Windows-host
runtime validation remains a separate verification item.

The portal's remote creation is intentionally not part of this local
installation. It remains `未证——归门户仓建 remote/Owner` until the explicit
publication ceremony.

## Checks

```bash
npm run proof             # design + i18n + dependency audit + tests
npm test                  # portal against a real governed scratch workspace
npm run design:proof      # tokens byte-identical to @tcrn/ui-tokens; no literal colours
npm run i18n:proof        # locale set, key coverage, placeholder consistency
npm run audit:dependencies
npm run demo:e2e
```
