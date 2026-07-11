# Isolated P1 proof fixture

`pnpm verify:isolated` creates a disposable local clone with copied objects, no
alternates or hardlinks, the exact current commit and tree, and the canonical
origin URL retained without contacting it. It removes clone-only tracking refs,
runs the full P1 command with the pinned Node/pnpm pair and Node process network
guard, verifies every declared P1 evidence path, writes one ignored receipt to
`dist/evidence/p1/isolated.json`, and deletes the disposable checkout.

The command never stages or edits the accepted source basis. It is not an
operating-system network sandbox and it does not run a fresh external advisory
service scan.
