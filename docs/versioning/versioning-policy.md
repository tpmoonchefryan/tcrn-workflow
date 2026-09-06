# Versioning Policy

The current package version is stated in `package.json` and in the "current status"
section of `README.md`; it is deliberately not restated here, because a version
written into a policy document is a number that has to be dragged on every release
and that nothing measures -- this sentence carried `0.11.14` while the tree stood at
1.0.1. `docs/versioning/release-policy.md` says which events are allowed to move it.
Accepted releases use Semantic Versioning; in the 0.x range the public API may still
change between minor versions. There is still no supported AOS release. Schemas and trust contracts use explicit
versioned identifiers independent of package versions.

Compatibility or trust semantics may not change under an existing schema
identifier. A release sequence and trust-root version are monotonic integers;
rollback is rejected even when a signature is otherwise valid.
