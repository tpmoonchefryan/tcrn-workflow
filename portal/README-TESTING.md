# Running the portal's checks

The portal's suite starts real processes: a governed scratch workspace, the real
CLI, the real portal server. That is the point — the property under test is that
the portal's numbers come from the engine and not from a stub.

It is therefore **a sibling step, never a nested one**. `scripts/task.mjs` holds
an exclusive output session for the length of its run, so a CLI spawned from
inside `pnpm test` cannot acquire one and returns nothing. Run them in sequence:

```sh
pnpm test          # the engine suite
pnpm portal:test   # the portal suite, in its own session
pnpm portal:proof  # design + i18n + dependency audit
```

`portal:proof` compares the shipped `tokens.css` and `locale-contract.mjs`
against the design system. That repository exists on the platform that authors
the portal and on no user's machine, so both checks **skip** when it is absent
rather than going red — a gate that fails where it was never meant to apply
teaches people to ignore red. On the platform, they compare for real.
