# Versioning Policy

The current package version is `0.1.0-rc.6`, an immutable unpublished local
candidate with no supported public API or supported AOS release. Accepted
releases will use Semantic Versioning. Schemas and trust contracts use explicit
versioned identifiers independent of package versions.

Compatibility or trust semantics may not change under an existing schema
identifier. A release sequence and trust-root version are monotonic integers;
rollback is rejected even when a signature is otherwise valid.
