# INC-244 automatic knowledge high-water rebind

Every CLI workspace mutation already holds the workspace lease and commits one
event. The CLI now snapshots the pre-write head, executes the mutation, and—only
when the head changes—reads an existing knowledge marker with the explicit
`allowTrailing` diagnostic option. If the marker trails, the engine invokes the
ordinary governed `rebaseKnowledgeStore` CAS path under the same held lease.

The mechanism is deliberately narrow:

- no knowledge store means no extra work and does not block a normal workspace write;
- a current marker is not version-bumped;
- a rebase refusal (`KNOWLEDGE_REBASE_BLOCKED`, malformed store, lock, or CAS issue)
  is returned to the caller rather than hidden behind a green workspace receipt;
- normal `validateKnowledgeStore` remains strict, while the explicit diagnostic
  read discloses the stored and chain heads before the rebase CAS;
- no full-corpus scan occurs after every event beyond the bounded rebase path, and
  knowledge writes do not recursively trigger a workspace rebase.

The proof is `tests/inc244-auto-rebase.test.mjs`, which appends a real CLI project
event after initializing a fixture knowledge store and verifies that the next
strict validation is green at the new event head.
