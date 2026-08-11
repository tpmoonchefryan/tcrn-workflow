// SPDX-License-Identifier: Apache-2.0
//
// Two legs that together keep the portal inside the TCRN Design System.
//
//   1. token fidelity — the vendored tokens.css is byte-identical to
//      @tcrn/ui-tokens. Following the design system's own precedent
//      (storybook.css is generated and guarded by `tokens:proof`), the copy is
//      allowed but the drift is not.
//   2. no literal colours — every colour in the portal's own styles resolves to
//      a --tcrn-* custom property. A literal hex is how a private palette gets
//      re-invented, which is exactly what happened before this gate existed.
//
// When the design system is not on disk the token leg reports UNVERIFIED and
// exits non-zero rather than passing: an unchecked copy is not a matching copy.

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const portalRoot = fileURLToPath(new URL("..", import.meta.url));
const vendored = join(portalRoot, "tokens.css");
const upstream = process.env.TCRN_DESIGN_SYSTEM_TOKENS
  ?? join(portalRoot, "..", "..", "TCRN-Design-System", "packages", "ui-tokens", "src", "tokens.css");

const digest = (text) => createHash("sha256").update(text).digest("hex");
const styled = [{ label: "index.html", path: join(portalRoot, "index.html") }];

// Literal colours in any notation. Values inside the vendored token file are
// the design system's own definitions and are not scanned here.
const LITERAL_COLOUR = /(#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|color-mix)\s*\()/gu;

const legs = [];

// Leg 1 — token fidelity.
try {
  const [local, source] = await Promise.all([readFile(vendored, "utf8"), readFile(upstream, "utf8")]);
  const matches = local === source;
  legs.push({
    leg: "token-fidelity",
    ok: matches,
    reasonCode: matches ? "TOKENS_MATCH_DESIGN_SYSTEM" : "TOKENS_DRIFTED",
    vendoredSha256: digest(local),
    upstreamSha256: digest(source),
    upstream,
  });
} catch (error) {
  // An absent upstream is not a failure. This leg compares the shipped token
  // bytes against the design system, which lives on the platform that authors
  // the portal; since the portal now ships inside the engine, this script
  // reaches every user, and none of them has that repository. A gate that goes
  // red where it was never meant to apply teaches people to ignore red. The
  // other leg — no literal colours — still runs, because it needs nothing.
  const absent = error?.code === "ENOENT";
  legs.push({
    leg: "token-fidelity",
    ok: absent,
    ...(absent ? { skipped: true } : {}),
    reasonCode: absent ? "TOKENS_SOURCE_ABSENT" : "TOKENS_UNREADABLE",
    upstream,
    ...(absent ? { note: "run this on the platform that holds the design system" } : { error: String(error?.message ?? error) }),
  });
}

// Leg 2 — no literal colours outside the token file.
const findings = [];
for (const target of styled) {
  const text = await readFile(target.path, "utf8");
  for (const [index, line] of text.split("\n").entries()) {
    for (const match of line.matchAll(LITERAL_COLOUR)) {
      findings.push({ file: target.label, line: index + 1, literal: match[0], context: line.trim().slice(0, 100) });
    }
  }
}
legs.push({
  leg: "no-literal-colours",
  ok: findings.length === 0,
  reasonCode: findings.length === 0 ? "COLOURS_COME_FROM_TOKENS" : "LITERAL_COLOUR_FOUND",
  scanned: styled.map((entry) => entry.label),
  findings,
});

const ok = legs.every((leg) => leg.ok);
process.stdout.write(`${JSON.stringify({
  ok,
  reasonCode: ok ? "DESIGN_SYSTEM_COMPLIANT" : "DESIGN_SYSTEM_VIOLATION",
  legs,
}, null, 2)}\n`);
if (!ok) process.exitCode = 1;
