# RC1 Candidate Proof Manifest V1

The RC1 candidate manifest lists the public AOS ledger, every normative P1/P2
schema, specification, fixture, and the verification map as sorted
path/size/SHA-256 records. Its basis digest is the SHA-256 of canonical JSON for
that sorted input array. The candidate manifest digest is the SHA-256 of the
complete canonical manifest bytes.

Paths, record sets, object keys, and role slots use the normative
`utf8-byte-order-v1` total order; host locale collation is forbidden. Composed
and decomposed Unicode path spellings remain distinct inputs.

RC1 proof canonicalization validates every scalar string and object key before
hashing. A lone surrogate anywhere in the candidate manifest or input-record
basis fails closed with `RC1_CANONICAL_VALUE_INVALID`; a generic runtime error
is not an admissible result.

Required role slots are platform-workflow-architect,
workflow-verification-engineer, security-risk-reviewer, and reality-checker.
P2 freezes all slots as unresolved with null verdict and basis digest. The
`RC1_CANDIDATE_READY` reason proves deterministic candidate construction only;
it does not mean RC1 was reviewed or accepted.
