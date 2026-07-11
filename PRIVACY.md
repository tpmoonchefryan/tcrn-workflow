# Privacy

TCRN Workflow contains no telemetry client. P1 project commands run with a Node
process network guard, an exact child-process allowlist, offline package-manager
defaults, and static checks for network-capable imports and tools. This is not a
kernel or operating-system network sandbox. CI action startup and the explicitly
marked frozen dependency-acquisition step remain external network boundaries.

The source and release archives must not contain credentials, personal data,
machine-specific paths, private control-plane records, runtime state, raw email
addresses, customer/source exports, or conversation identifiers. The public Git
repository URL, public Git hosting usernames, and matching GitHub-generated
noreply addresses are allowed only where Git commit or annotated-tag metadata
requires them. They are not allowed in source, filenames, archives, or commit
messages merely because they are public.

`pnpm verify:privacy` scans current filenames and contents, the source archive,
all stored Git commit/tree/blob/tag objects, and ref metadata. Reads fail closed;
single-link regular source inputs are required. Generated output is ignored by
Git but is written only through a validated real `dist` root.

Any future networked feature requires an explicit opt-in contract, documented
data flow, retention policy, and separate acceptance.
