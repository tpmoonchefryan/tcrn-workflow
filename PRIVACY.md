# Privacy

TCRN Workflow is offline by default and contains no telemetry client. Project
commands do not transmit source, environment, evidence, or usage data.

The source and release archives must not contain credentials, personal data,
machine-specific paths, private control-plane records, runtime state, or
conversation identifiers. `pnpm verify:privacy` enforces the P1 source boundary
with deterministic local scanning. Generated output is excluded from source
control and is scanned before archival.

Any future networked feature requires an explicit opt-in contract, documented
data flow, retention policy, and separate acceptance.
