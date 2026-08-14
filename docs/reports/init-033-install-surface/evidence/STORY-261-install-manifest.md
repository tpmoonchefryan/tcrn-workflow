# STORY-261 install-manifest

已脱敏，非逐字，原件见平台档案 `.tcrn-artifacts/init-033-install-surface/S261-install-manifest.stdout.json`。

## Result

- `INSTALL_MANIFEST_READY` / `tcrn.install-manifest.v1`
- Read-only CLI output and `platform-doctor` consume the same exported manifest.
- Every item declares `machine` / `container` / `project`, a `<HOME>` or `<PLATFORM_ROOT>` path template, `engine-adapter` / `host-self` / `user-guided` writer, host, and acceptance probe.
- The governed project set is `TCRN-AOS`, `TCRN-Design-System`, `TCRN-TMS`, `tcrn-workflow`, and the exact lowercase directory `joi-button`.
- The independent required-item catalog mutation test removes one item and receives `INSTALL_MANIFEST_ITEM_MISSING`.
- The generated manifest contains placeholders only; it contains no machine path or username.

## Verification

```text
pnpm build
node --test tests/init033-install-surface.test.mjs tests/p3-cli-catalog.test.mjs
```

Observed: 11 tests passed.
