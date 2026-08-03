# AGENTS.md

The canonical agent guidance for this repository lives in `CLAUDE.md`. Open it before
changing any source. This file is a deliberate pointer, not a copy — keeping one source
avoids two-file drift. `CONTRIBUTING.md` remains the manual.

Three rules you must not miss:

1. **Enumerate capability from `commands`, never from prose.** The catalog is what the
   engine enforces; documentation can be behind the code.
2. **Probe with reads, never with writes.** A mutating verb aimed at a live chain performs
   its mutation even when the intent was exploratory, and terminal transitions do not come
   back.
3. **Only the engine may write inside a control tree.** Reading files under
   `.tcrn-workflow/` is fine; saving them breaks the chain closed, for readers too. **A tree
   on another host is not an exception** — `sed -i` or `rsync` over SSH is the same act, and
   a write to a chain hosted elsewhere must be performed by the engine on that host.
4. **Know which copy — and since 2026-07-29, which HOST — you are driving.** This platform's
   governed chains no longer all live on one machine, so there is an installed engine copy
   per host and they can sit at different versions. Ask `commands` of the copy you actually
   invoked. Which partition lives where, with a recheck command each, is in the platform
   root's `CLAUDE.md` section 三.

For everything else — verifying against the authority rather than a local view, the
relocation verb family and the four ceilings it states about itself, background-load
reclaim, the two-directional root-file allowlist, and the platform-wide conventions — see
`CLAUDE.md`.
