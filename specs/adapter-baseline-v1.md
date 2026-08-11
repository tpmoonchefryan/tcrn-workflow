# Adapter baseline v1

`tcrn.adapter-baseline.v1` is the reconciliation surface for the project-local
adapter zone. It has exactly three entries:

- `session-start-governance`: the installed SessionStart governance summary;
- `observe-collection`: the six-event fail-open observe handler, bound to the
  project manifest and handler digests;
- `stop-pact-stop-gate`: an explicit user-owned exemption with an independent
  read-only drift check.

The first two entries are TCRN-owned and must be `installed`. The stop-pact entry
must remain `exempted` until an Owner accepts an implementation-time placement
plan. This manifest records the boundary; it does not authorize writing a
user-level hook.

`adapter-validate` validates the bundle and this manifest. A supplied settings
document is an opaque user zone: arbitrary user hooks produce no TCRN findings and
do not change the validation result. Managed fragment merge/remove operations are
the only operations allowed to change a hook document, and they remove only the
exact TCRN fragment.
