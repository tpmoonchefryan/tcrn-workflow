// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { scanPrivacyEntries } from "../scripts/lib/privacy.mjs";

[REDACTED_PUBLIC_HISTORY_LINE]
[REDACTED_PUBLIC_HISTORY_LINE]
[REDACTED_PUBLIC_HISTORY_LINE]
[REDACTED_PUBLIC_HISTORY_LINE]
[REDACTED_PUBLIC_HISTORY_LINE]
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

[REDACTED_PUBLIC_HISTORY_LINE]
[REDACTED_PUBLIC_HISTORY_LINE]
[REDACTED_PUBLIC_HISTORY_LINE]
[REDACTED_PUBLIC_HISTORY_LINE]
[REDACTED_PUBLIC_HISTORY_LINE]
    ["npm", `npm_${"A".repeat(36)}`, "NPM_TOKEN"],
    ["Slack", `xoxb-${"1".repeat(12)}-${"A".repeat(24)}`, "SLACK_TOKEN"],
[REDACTED_PUBLIC_HISTORY_LINE]
[REDACTED_PUBLIC_HISTORY_LINE]
[REDACTED_PUBLIC_HISTORY_LINE]
[REDACTED_PUBLIC_HISTORY_LINE]
[REDACTED_PUBLIC_HISTORY_LINE]
[REDACTED_PUBLIC_HISTORY_LINE]
[REDACTED_PUBLIC_HISTORY_LINE]
    const findings = scanPrivacyEntries([{ label, kind: "source", content }], {
      owner: publicIdentity.login,
    });
    assert.ok(findings.some((finding) => finding.startsWith(`${reasonCode}:`)), label);
  }
});

test("filenames are scanned as privacy-bearing metadata", () => {
[REDACTED_PUBLIC_HISTORY_LINE]
[REDACTED_PUBLIC_HISTORY_LINE]
[REDACTED_PUBLIC_HISTORY_LINE]
[REDACTED_PUBLIC_HISTORY_LINE]
[REDACTED_PUBLIC_HISTORY_LINE]
[REDACTED_PUBLIC_HISTORY_LINE]
[REDACTED_PUBLIC_HISTORY_LINE]
  );
  assert.ok(findings.some((finding) => finding.startsWith("CUSTOMER_SOURCE_MARKER:")));
});
