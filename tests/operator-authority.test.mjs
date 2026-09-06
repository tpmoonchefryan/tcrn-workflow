// SPDX-License-Identifier: Apache-2.0
// TCRN-CROSS-STORY-287: the MCP transport is retired; this file keeps the coverage of
// packages/core/src/operator-authority.ts, which the whole engine CLI runs through.
// The dispatcher-shaped cases went with the surface they described, and
// TCRN-CROSS-STORY-358 retired the Codex/Claude host-admission cases the same way when
// the adapters themselves left the tree.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  OPERATOR_AUTHORITY_BUNDLE_VERSION,
  OPERATOR_AUTHORITY_PINS_VERSION,
  readOperatorAuthority,
} from "../dist/build/packages/core/src/index.js";
import {
  canonicalJson,
  canonicalSha256,
} from "../dist/build/packages/protocol/src/index.js";

const cases = JSON.parse(await readFile(
  new URL(
    "../packages/core/fixtures/operator-authority-cases.json",
    import.meta.url,
  ),
  "utf8",
));
const NOW = "2026-07-24T12:00:00Z";
const SHA0 = "0".repeat(64);
const rawSha = (value) => createHash("sha256").update(value).digest("hex");

async function reasonAsync(code, operation) {
  await assert.rejects(
    operation,
    (error) => error?.reasonCode === code,
    code,
  );
}

async function authorityFixture(options = {}) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "workflow-operator-authority-")),
  );
  const authorityPath = join(directory, "authority.json");
  const pinsPath = join(directory, "pins.json");
  const bundleBasis = {
    schemaVersion: OPERATOR_AUTHORITY_BUNDLE_VERSION,
    authorityId: "authority:operator-fixture",
    generation: options.generation ?? 1,
    issuedAt: options.issuedAt ?? "2026-07-24T00:00:00Z",
    expiresAt: options.expiresAt ?? "2026-07-25T00:00:00Z",
    status: options.status ?? "active",
    fileAuthorities: {
      profileAdmission: null,
      contextRoute: null,
      ...options.fileAuthorities,
    },
    mcp: {
      writeCommands: options.writeCommands ?? [],
      authorityOutputCommands: options.authorityOutputCommands ?? [],
    },
  };
  const bundle = {
    ...bundleBasis,
    authorityDigest: canonicalSha256(bundleBasis),
    ...options.bundleExtra,
  };
  const authorityBytes = canonicalJson(bundle);
  await writeFile(authorityPath, authorityBytes, { mode: 0o600 });
  const pinsBasis = {
    schemaVersion: OPERATOR_AUTHORITY_PINS_VERSION,
    authorityId: options.pinsAuthorityId ?? bundle.authorityId,
    authorityPath,
    authorityFileSha256: rawSha(authorityBytes),
    minimumGeneration: options.minimumGeneration ?? 1,
    revokedAuthorityDigests: options.revokeCurrent
      ? [bundle.authorityDigest]
      : [],
  };
  const pins = { ...pinsBasis, pinsDigest: canonicalSha256(pinsBasis) };
  const pinsBytes = canonicalJson(pins);
  await writeFile(pinsPath, pinsBytes, { mode: 0o600 });
  return {
    directory,
    authorityPath,
    authorityBytes,
    bundle,
    pinsPath,
    pins,
    pinsDigest: rawSha(pinsBytes),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

test("pinned authority admits, rotates and reports source identity", async () => {
  const first = await authorityFixture();
  const second = await authorityFixture({ generation: 2, minimumGeneration: 2 });
  try {
    const admittedFirst = await readOperatorAuthority(
      first.pinsPath,
      {
        expectedCanonicalPath: first.pinsPath,
        expectedFileSha256: first.pinsDigest,
      },
      NOW,
    );
    const admittedSecond = await readOperatorAuthority(
      second.pinsPath,
      {
        expectedCanonicalPath: second.pinsPath,
        expectedFileSha256: second.pinsDigest,
      },
      NOW,
    );
    assert.equal(admittedFirst.bundle.generation, 1);
    assert.equal(admittedSecond.bundle.generation, 2);
    assert.match(admittedSecond.authoritySourceIdentityDigest, /^[a-f0-9]{64}$/);
  } finally {
    await first.close();
    await second.close();
  }
});

test("operator authority rejects missing pins, changed digest, rollback, revocation, expiry, binding and unknown fields", async () => {
  const valid = await authorityFixture();
  const rollback = await authorityFixture({ minimumGeneration: 2 });
  const revoked = await authorityFixture({ revokeCurrent: true });
  const revokedStatus = await authorityFixture({ status: "revoked" });
  const expired = await authorityFixture({
    issuedAt: "2026-07-22T00:00:00Z",
    expiresAt: "2026-07-23T00:00:00Z",
  });
  const mismatch = await authorityFixture({
    pinsAuthorityId: "authority:different",
  });
  const unknown = await authorityFixture({
    bundleExtra: { promptAuthority: true },
  });
  try {
    await reasonAsync(
      "OPERATOR_AUTHORITY_REQUIRED",
      () => readOperatorAuthority(valid.pinsPath, undefined, NOW),
    );
    await reasonAsync(
      "OPERATOR_AUTHORITY_DIGEST",
      () => readOperatorAuthority(
        valid.pinsPath,
        {
          expectedCanonicalPath: valid.pinsPath,
          expectedFileSha256: SHA0,
        },
        NOW,
      ),
    );
    await reasonAsync(
      "OPERATOR_AUTHORITY_ROLLBACK",
      () => readOperatorAuthority(
        rollback.pinsPath,
        {
          expectedCanonicalPath: rollback.pinsPath,
          expectedFileSha256: rollback.pinsDigest,
        },
        NOW,
      ),
    );
    await reasonAsync(
      "OPERATOR_AUTHORITY_REVOKED",
      () => readOperatorAuthority(
        revoked.pinsPath,
        {
          expectedCanonicalPath: revoked.pinsPath,
          expectedFileSha256: revoked.pinsDigest,
        },
        NOW,
      ),
    );
    await reasonAsync(
      "OPERATOR_AUTHORITY_REVOKED",
      () => readOperatorAuthority(
        revokedStatus.pinsPath,
        {
          expectedCanonicalPath: revokedStatus.pinsPath,
          expectedFileSha256: revokedStatus.pinsDigest,
        },
        NOW,
      ),
    );
    await reasonAsync(
      "OPERATOR_AUTHORITY_EXPIRED",
      () => readOperatorAuthority(
        expired.pinsPath,
        {
          expectedCanonicalPath: expired.pinsPath,
          expectedFileSha256: expired.pinsDigest,
        },
        NOW,
      ),
    );
    await reasonAsync(
      "OPERATOR_AUTHORITY_BINDING_MISMATCH",
      () => readOperatorAuthority(
        mismatch.pinsPath,
        {
          expectedCanonicalPath: mismatch.pinsPath,
          expectedFileSha256: mismatch.pinsDigest,
        },
        NOW,
      ),
    );
    await reasonAsync(
      "OPERATOR_AUTHORITY_SCHEMA_INVALID",
      () => readOperatorAuthority(
        unknown.pinsPath,
        {
          expectedCanonicalPath: unknown.pinsPath,
          expectedFileSha256: unknown.pinsDigest,
        },
        NOW,
      ),
    );
  } finally {
    await Promise.all([
      valid.close(),
      rollback.close(),
      revoked.close(),
      revokedStatus.close(),
      expired.close(),
      mismatch.close(),
      unknown.close(),
    ]);
  }
});

test("fixture counts and boundaries remain exact", async () => {
  assert.equal(cases.authorityPositiveCases, 2);
  assert.equal(cases.authorityHostileCases, 8);
  // STORY-287: the mcp case counts and its transport policies described the retired
  // surface. The fixture records that removal rather than dropping it silently, and the
  // assertion moves to the record so a future reader sees the surface went on purpose.
  assert.equal(cases.mcpPositiveCases, undefined, "the retired surface leaves no case count behind");
  assert.equal(cases.retiredSurface.surface, "mcp; codex/claude adapter host admission");
  assert.match(cases.retiredSurface.reason, /no longer exists/u);
  assert.deepEqual(cases.authorityOutputCommands, []);
  assert.deepEqual(cases.ambientAuthoritySources, []);
  assert.equal(cases.network, false);
  await reasonAsync(
    "OPERATOR_AUTHORITY_SCHEMA_INVALID",
    () => readOperatorAuthority("", undefined, "not-an-instant"),
  );
});
