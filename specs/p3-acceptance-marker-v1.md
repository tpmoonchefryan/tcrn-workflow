# P3 Acceptance Marker V1

The canonical marker path is
`.context/platform/workflow-v3-capabilities/p3-local-work-graph.accepted.json`.
The marker conforms to `p3-acceptance-marker-v1.schema.json` and may be created
only by a later accepted control-plane route after RC1 approval.

The marker binds the accepted commit/tree, RC1 candidate-manifest digest, strict
acceptance instant, capability name, and approved verdicts from the four required
roles. Absence means P3 local-work-graph capability is unavailable. P2 defines
this contract but MUST NOT create the marker or claim the capability.
