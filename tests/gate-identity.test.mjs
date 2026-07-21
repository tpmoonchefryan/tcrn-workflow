// SPDX-License-Identifier: Apache-2.0

// gate-v1 / E02 STORY-008: the gate identity authority is a pins-track document read
// through the shared TOCTOU-hardened reader. What these cases have to establish is
// that it is an authority and not a suggestion -- the digest binds, the roster's
// canonical form is required rather than merely produced, and a permission answer
// cannot be obtained from an object the caller assembled itself.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalJson } from "../dist/build/packages/protocol/src/index.js";
import {
  GATE_IDENTITY_AUTHORITY_VERSION,
  GateIdentityError,
  assertGateOutcomePermitted,
  canonicalGateIdentityAuthority,
  gateIdentityDecision,
  permitsGateOutcome,
  readGateIdentityAuthority,
  validateGateIdentityAuthorityDocument,
  validateGateIdentityDecision,
} from "../dist/build/packages/core/src/index.js";

const roster = {
  schemaVersion: GATE_IDENTITY_AUTHORITY_VERSION,
  permits: [
    { actorId: "agent:opus", outcomeClasses: ["recommendation", "role_decision"] },
    { actorId: "owner:governance", outcomeClasses: ["owner_intent_required", "role_decision"] },
  ],
};

function reason(code, operation) {
  assert.throws(operation, (error) => {
    assert.ok(error instanceof GateIdentityError, `${code}: got ${error?.name}`);
    assert.equal(error.reasonCode, code);
    return true;
  }, code);
}

async function reasonAsync(code, operation) {
  await assert.rejects(operation, (error) => {
    assert.equal(error?.reasonCode, code, `expected ${code}, got ${error?.reasonCode}`);
    return true;
  }, code);
}

async function fixture(context, { document = roster, transformBytes = (value) => value } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "workflow-gate-identity-")));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "gate-identity-authority.json");
  const bytes = transformBytes(canonicalJson(document));
  await writeFile(path, bytes, { encoding: "utf8", mode: 0o600 });
  return {
    directory,
    path,
    bytes,
    authority: { expectedCanonicalPath: path, expectedFileSha256: createHash("sha256").update(bytes).digest("hex") },
  };
}

test("the roster admits only a canonical closed shape", () => {
  assert.deepEqual(validateGateIdentityAuthorityDocument(roster), roster);

  reason("GATE_IDENTITY_AUTHORITY_MALFORMED", () => validateGateIdentityAuthorityDocument({ ...roster, schemaVersion: "tcrn.gate-identity-authority.v2" }));
  reason("GATE_IDENTITY_AUTHORITY_MALFORMED", () => validateGateIdentityAuthorityDocument({ ...roster, extra: 1 }));
  reason("GATE_IDENTITY_AUTHORITY_MALFORMED", () => validateGateIdentityAuthorityDocument({ schemaVersion: GATE_IDENTITY_AUTHORITY_VERSION }));
  reason("GATE_IDENTITY_AUTHORITY_MALFORMED", () => validateGateIdentityAuthorityDocument({ ...roster, permits: [] }));

  // An empty class list would be a permit that permits nothing while looking like one.
  reason("GATE_IDENTITY_AUTHORITY_MALFORMED", () => validateGateIdentityAuthorityDocument({
    ...roster, permits: [{ actorId: "owner:governance", outcomeClasses: [] }],
  }));

  // Membership, not coercion.
  for (const outcome of ["OWNER_INTENT_REQUIRED", "owner_intent_required ", 1, null]) {
    reason("GATE_IDENTITY_AUTHORITY_MALFORMED", () => validateGateIdentityAuthorityDocument({
      ...roster, permits: [{ actorId: "owner:governance", outcomeClasses: [outcome] }],
    }));
  }

  // An actor id has to be one, so a bare name cannot be granted anything.
  reason("GATE_IDENTITY_AUTHORITY_MALFORMED", () => validateGateIdentityAuthorityDocument({
    ...roster, permits: [{ actorId: "governance", outcomeClasses: ["role_decision"] }],
  }));
});

test("canonical order is required, so one roster is one document", () => {
  // Reshuffling must not produce a second document that means the same thing: the
  // digest is the identity, and two spellings would be two identities.
  reason("GATE_IDENTITY_AUTHORITY_MALFORMED", () => validateGateIdentityAuthorityDocument({
    ...roster, permits: [...roster.permits].reverse(),
  }));
  reason("GATE_IDENTITY_AUTHORITY_MALFORMED", () => validateGateIdentityAuthorityDocument({
    ...roster, permits: [{ actorId: "owner:governance", outcomeClasses: ["role_decision", "owner_intent_required"] }],
  }));
  reason("GATE_IDENTITY_AUTHORITY_MALFORMED", () => validateGateIdentityAuthorityDocument({
    ...roster,
    permits: [{ actorId: "agent:opus", outcomeClasses: ["role_decision"] }, { actorId: "agent:opus", outcomeClasses: ["recommendation"] }],
  }));
  reason("GATE_IDENTITY_AUTHORITY_MALFORMED", () => validateGateIdentityAuthorityDocument({
    ...roster, permits: [{ actorId: "owner:governance", outcomeClasses: ["role_decision", "role_decision"] }],
  }));

  assert.equal(canonicalGateIdentityAuthority(roster), canonicalJson(roster));
});

test("the digest binds the roster to the bytes on disk", async (context) => {
  const valid = await fixture(context);

  const admitted = await readGateIdentityAuthority(valid.path, valid.authority);
  assert.deepEqual(admitted.document, roster);
  assert.equal(admitted.authorityFileSha256, valid.authority.expectedFileSha256);

  // No authority at all is the state the shipped binary is in, and it refuses.
  await reasonAsync("GATE_IDENTITY_AUTHORITY_REQUIRED", () => readGateIdentityAuthority(valid.path));

  // A wrong digest must stop at the digest rather than accept the file in front of it.
  await reasonAsync("GATE_IDENTITY_AUTHORITY_DIGEST", () => readGateIdentityAuthority(valid.path, {
    ...valid.authority, expectedFileSha256: "b".repeat(64),
  }));

  // The authority names one path. A copy with identical bytes is a different file.
  const copy = join(valid.directory, "copy.json");
  await writeFile(copy, valid.bytes, { mode: 0o600 });
  await reasonAsync("GATE_IDENTITY_AUTHORITY_PATH", () => readGateIdentityAuthority(copy, valid.authority));

  // Rewriting the roster under a pinned digest is the substitution the digest exists
  // to catch -- this is the shape a privilege escalation would take.
  const escalated = canonicalJson({
    schemaVersion: GATE_IDENTITY_AUTHORITY_VERSION,
    permits: [{ actorId: "agent:opus", outcomeClasses: ["owner_intent_required"] }],
  });
  await writeFile(valid.path, escalated, { mode: 0o600 });
  await reasonAsync("GATE_IDENTITY_AUTHORITY_DIGEST", () => readGateIdentityAuthority(valid.path, valid.authority));
});

test("non-canonical bytes and unsafe files are refused before they are trusted", async (context) => {
  const pretty = await fixture(context, { transformBytes: (value) => `${JSON.stringify(JSON.parse(value), null, 2)}\n` });
  await reasonAsync("GATE_IDENTITY_AUTHORITY_CANONICAL_INVALID", () => readGateIdentityAuthority(pretty.path, pretty.authority));

  const linked = await fixture(context);
  const target = join(linked.directory, "target.json");
  await writeFile(target, linked.bytes, { mode: 0o600 });
  const symbolic = join(linked.directory, "symbolic.json");
  await symlink(target, symbolic);
  await reasonAsync("GATE_IDENTITY_AUTHORITY_LINK", () => readGateIdentityAuthority(symbolic, {
    ...linked.authority, expectedCanonicalPath: symbolic,
  }));

  const hard = join(linked.directory, "hard.json");
  await link(linked.path, hard);
  await reasonAsync("GATE_IDENTITY_AUTHORITY_LINK", () => readGateIdentityAuthority(linked.path, linked.authority));
});

test("permission answers come only from a roster the reader produced", async (context) => {
  const valid = await fixture(context);
  const admitted = await readGateIdentityAuthority(valid.path, valid.authority);

  assert.equal(permitsGateOutcome(admitted, "owner:governance", "owner_intent_required"), true);
  assert.equal(permitsGateOutcome(admitted, "agent:opus", "role_decision"), true);
  assert.equal(permitsGateOutcome(admitted, "agent:opus", "owner_intent_required"), false);
  assert.equal(permitsGateOutcome(admitted, "agent:sonnet", "role_decision"), false);

  assertGateOutcomePermitted(admitted, "owner:governance", "owner_intent_required");
  reason("GATE_IDENTITY_NOT_PERMITTED", () => assertGateOutcomePermitted(admitted, "agent:opus", "owner_intent_required"));
  reason("GATE_IDENTITY_NOT_PERMITTED", () => assertGateOutcomePermitted(admitted, "agent:sonnet", "role_decision"));

  // A hand-built object carrying the same document has been through none of the
  // filesystem or canonical-bytes checks, so it is not an authority.
  const forged = { document: roster, sourcePath: valid.path, authorityFileSha256: valid.authority.expectedFileSha256, sourceIdentityDigest: "x" };
  reason("GATE_IDENTITY_ADMISSION_REQUIRED", () => permitsGateOutcome(forged, "owner:governance", "owner_intent_required"));
  reason("GATE_IDENTITY_ADMISSION_REQUIRED", () => gateIdentityDecision(forged, "owner:governance"));
});

test("the decision record is self-contained and shape-checked", async (context) => {
  const valid = await fixture(context);
  const admitted = await readGateIdentityAuthority(valid.path, valid.authority);

  const decision = gateIdentityDecision(admitted, "owner:governance");
  assert.deepEqual(decision, { actorId: "owner:governance", authorityFileSha256: valid.authority.expectedFileSha256 });
  // Self-contained on purpose: replay validates this shape and never re-reads the
  // file, so a chain stays readable when the roster is legitimately gone.
  assert.deepEqual(validateGateIdentityDecision(JSON.parse(canonicalJson(decision))), decision);

  reason("GATE_IDENTITY_AUTHORITY_MALFORMED", () => validateGateIdentityDecision({ ...decision, extra: 1 }));
  reason("GATE_IDENTITY_AUTHORITY_MALFORMED", () => validateGateIdentityDecision({ actorId: "owner:governance" }));
  reason("GATE_IDENTITY_AUTHORITY_MALFORMED", () => validateGateIdentityDecision({ ...decision, actorId: "governance" }));
  reason("GATE_IDENTITY_AUTHORITY_MALFORMED", () => validateGateIdentityDecision({ ...decision, authorityFileSha256: "not-a-digest" }));
  reason("GATE_IDENTITY_AUTHORITY_MALFORMED", () => validateGateIdentityDecision({ ...decision, authorityFileSha256: "B".repeat(64) }));
});
