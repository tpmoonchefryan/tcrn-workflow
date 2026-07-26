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
   `.tcrn-workflow/` is fine; saving them breaks the chain closed, for readers too.

For everything else — which copy you are actually driving, verifying against the authority
rather than a local view, background-load reclaim, the two-directional root-file
allowlist, and the platform-wide conventions — see `CLAUDE.md`.
