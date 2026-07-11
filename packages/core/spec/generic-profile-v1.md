# Generic Profile V1

Generic Profile V1 is an offline, inert-data policy layer for an empty standalone
Workspace. It does not define a persona, agent, Skill, hook, model setting,
thread identity, project fact, or external authority. The generated starter
bundle is unbound and read-only until a caller supplies an explicit governed
owner-rebind document.

## Trust and precedence

Every layer has one frozen trust level:

| Layer kind | Trust level | Precedence |
| --- | --- | ---: |
| `framework_defaults` | `framework_profile` | 0 |
| `release_verified_framework_profile` | `framework_profile` | 1 |
| `imported_untrusted` | `imported_untrusted` | 2 |
| `workspace_configuration` | `user_owned_overlay` | 3 |
| `project_configuration` | `user_owned_overlay` | 4 |
| `command_override` | `user_owned_overlay` | 5 |

Input order never grants precedence. Resolution sorts by this table and then by
the frozen UTF-8 comparator. Duplicate layer IDs or kinds fail closed. A release
profile is admitted only when its exact canonical layer digest is supplied by an
external release-verification boundary; this module neither fabricates nor
performs that verification. Imported material has no identity, display, or
rebinding authority and must contain exactly one restrict-only group that
preserves or narrows the current restrictions.

Environment variables and prompt text are not resolution inputs and cannot
grant identity, binding, operation, path, tool, or escalation authority.

## Exact merge matrix

| Class | Fields | Rule |
| --- | --- | --- |
| immutable | identity, base mission, mandatory safety/refusal tokens, protocol version, profile-schema version | must be byte-canonical equal to framework defaults |
| restrict only | write paths, tools, budgets, data classifications, allowed operations | each layer may preserve or narrow; additions or larger budgets fail |
| owner rebind only | active binding, role replacement, project authority, escalation owner | changes require an exact matching, approved owner-rebind document targeting a user-owned layer |
| display only | label, description, examples, presentation metadata | the highest-precedence admitted layer wins; these fields grant no authority |

Removing or changing a mandatory refusal returns
`PROFILE_REFUSAL_WEAKENING`. Other immutable changes return
`PROFILE_FIELD_IMMUTABLE`. Restriction expansion returns
`PROFILE_RESTRICTION_EXPANSION`. Missing or mismatched owner admission returns
`PROFILE_OWNER_REBIND_REQUIRED` or `PROFILE_OWNER_REBIND_INVALID`.

## Binding

Bindings are closed records with `mode`, `workspaceId`, `projectId`, and
`command`:

- `unbound_read_only` permits only profile/workspace read, validation, and
  generated-view operations. Mutation returns `PROFILE_BINDING_REQUIRED`.
- `cold_standby` denies every operation with `PROFILE_COLD_STANDBY`.
- `workspace` requires the exact Workspace ID.
- `project` requires exact Workspace and project IDs.
- `command` additionally requires the exact command token.

Workspace, project, and command binding cannot be inferred. Active bindings
require a non-null escalation-owner reference. This reference is an inert stable
identifier and does not resolve an identity or imply profile/persona admission.

## Canonical proof

Objects use the frozen P2 canonical JSON and SHA-256 primitives. Canonical
arrays are duplicate-free and UTF-8-byte ordered. Resolution records the base,
each layer, overlays, effective policy, and complete effective-profile digests.
At least 64 actual insertion permutations of the same logical layer set must
produce identical effective bytes and digests.

## Inert starter material

The generated bundle contains framework defaults and the four-step
Initiative → Epic → Story → Subtask shape. It contains no executable tag,
module/code reference, interpolation, URL, absolute machine path, hook,
network/database/API authority, model setting, thread UUID, owner-private data,
active state, product fact, or external project naming. The starter remains
unbound until the caller supplies an owner-controlled Workspace layer and exact
owner rebind.

The cold-start proof uses only disposable empty roots. It initializes a
standalone Workspace, creates a generic project and the four planned-delivery
records, exercises expected-version transitions, validates the event chain, and
removes the fixture. No live profile store exists: generation, validation,
resolution, and authorization are read-only computations.

## Boundaries

The runtime imports the accepted protocol canonical and stable-ID primitives;
it does not redefine P2. It performs no network, database, API, AOS, hook,
credential, environment-authority, or external-content access. There is no
generic DLP claim. Existing cooperative clean-checkout and filesystem threat
boundaries remain unchanged.
