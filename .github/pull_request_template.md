## Change

Describe the bounded change and its public contract impact.

## Trust and privacy

- [ ] No telemetry or implicit network access was added.
- [ ] Dependency versions and executable actions are immutable pins.
- [ ] Dependency lifecycle scripts remain disabled or have an accepted exception.
- [ ] No private paths, credentials, runtime state, or control-plane material is included.
- [ ] Release mode still requires an external trust root.

## Verification

- [ ] `pnpm verify:p1`
- [ ] Any invalidation trigger in `verification-map.yaml` was addressed.
