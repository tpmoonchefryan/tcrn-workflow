// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { scanPrivacyEntries } from "../scripts/lib/privacy.mjs";

const publicIdentity = {
  login: "public-contributor",
  email: ["12345+public-contributor", "@", "users.noreply.github.com"].join(""),
};

test("public Git hosting identity is allowed only in commit metadata", () => {
  const commit = `tree ${"a".repeat(40)}\nauthor ${publicIdentity.login} <${publicIdentity.email}> 1 +0000\ncommitter ${publicIdentity.login} <${publicIdentity.email}> 1 +0000\n\nmessage\n`;
  assert.deepEqual(
    scanPrivacyEntries([
      { label: "commit", kind: "commit", content: commit },
      {
        label: "origin",
        kind: "remote",
        content: `https://github.com/${publicIdentity.login}/tcrn-workflow.git`,
      },
    ], {
      owner: publicIdentity.login,
    }),
    [],
  );
  assert.match(
    scanPrivacyEntries([{ label: "source", kind: "source", content: publicIdentity.email }], {
      owner: publicIdentity.login,
    })[0],
    /EMAIL_IDENTIFIER/u,
  );
});

test("private/raw identifiers and common secret families fail closed", () => {
  const cases = [
    ["raw email", ["person", "@", "example.invalid"].join(""), "EMAIL_IDENTIFIER"],
    ["fine-grained GitHub", `github_pat_${"A".repeat(32)}`, "GITHUB_FINE_GRAINED_TOKEN"],
    ["AWS session", `ASIA${"A".repeat(16)}`, "AWS_ACCESS_KEY"],
    ["npm", `npm_${"A".repeat(36)}`, "NPM_TOKEN"],
    ["Slack", `xoxb-${"1".repeat(12)}-${"A".repeat(24)}`, "SLACK_TOKEN"],
    ["cloud", `AIza${"A".repeat(35)}`, "GOOGLE_API_KEY"],
    ["JWT", `${"eyJ"}${"A".repeat(24)}.${"B".repeat(24)}.${"C".repeat(24)}`, "JWT_TOKEN"],
    ["authenticated URL", ["https://user", ":", "password", "@", "example.invalid/path"].join(""), "AUTHENTICATED_URL"],
    ["private key", ["-----BEGIN OPENSSH", " PRIVATE KEY-----"].join(""), "PRIVATE_KEY"],
    ["customer marker", ["tenant", "-", "export.csv"].join(""), "CUSTOMER_SOURCE_MARKER"],
  ];
  for (const [label, content, reasonCode] of cases) {
    const findings = scanPrivacyEntries([{ label, kind: "source", content }], {
      owner: publicIdentity.login,
    });
    assert.ok(findings.some((finding) => finding.startsWith(`${reasonCode}:`)), label);
  }
});

test("filenames are scanned as privacy-bearing metadata", () => {
  const findings = scanPrivacyEntries(
    [{
      label: ["customer", "-", "export.csv"].join(""),
      kind: "filename",
      content: ["customer", "-", "export.csv"].join(""),
    }],
    { owner: publicIdentity.login },
  );
  assert.ok(findings.some((finding) => finding.startsWith("CUSTOMER_SOURCE_MARKER:")));
});
