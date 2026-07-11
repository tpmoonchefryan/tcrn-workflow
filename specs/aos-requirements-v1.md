# Public AOS Requirements V1

`extensions/aos-requirements-v1.json` is the generic public requirements ledger.
Every AOS-facing P2 schema and fixture lists one or more stable requirement IDs
from that ledger. Maturity is restricted to `specified` or `fixture_verified`.

The ledger is intentionally implementation-neutral. It contains no endpoint,
credential, database assumption, current-runtime mutation, supported release
pair, or private deployment fact. Later adoption must produce separate evidence
without rewriting these V1 protocol meanings.
