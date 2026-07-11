# Versioning Policy

The P1 bootstrap version is `0.0.0-development` and has no supported public API.
Accepted releases will use Semantic Versioning. Schemas and trust contracts use
explicit versioned identifiers independent of package versions.

Compatibility or trust semantics may not change under an existing schema
identifier. A release sequence and trust-root version are monotonic integers;
rollback is rejected even when a signature is otherwise valid.
