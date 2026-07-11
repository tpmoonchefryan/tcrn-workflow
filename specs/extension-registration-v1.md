# Extension Registration V1

Registrations conform to `extension-registration-v1.schema.json` and bind a
stable extension ID/version to applicable model surfaces and a schema digest.
Registration IDs are unique. Required extensions must be registered before use;
unknown required values fail closed. Unknown optional values are preserved and
participate in canonical hashes.

Extensions MUST NOT redefine core field meaning, planned-delivery parent rules,
canonical serialization, limits, or reason codes.
