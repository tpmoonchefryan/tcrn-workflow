# Versioning Policy

The current package version is `0.2.0`, the second accepted release (`0.1.0` was the first). Accepted
releases use Semantic Versioning; in the 0.x range the public API may still
change between minor versions. There is still no supported AOS release. Schemas and trust contracts use explicit
versioned identifiers independent of package versions.

Compatibility or trust semantics may not change under an existing schema
identifier. A release sequence and trust-root version are monotonic integers;
rollback is rejected even when a signature is otherwise valid.
