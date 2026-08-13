# INC-140 — portal remediation train is wired and has a red leg

## Pre-repair red

Before the remediation wiring, the two authoritative train files had no
`portal` reference:

```excerpt
$ grep -n portal .github/workflows/ci.yml scripts/task.mjs
(no output)
```

The positive control in the same probe found the existing `verify`/`pnpm`
references (19 hits), so this was a real absence rather than a failed probe.
The strengthening gate was therefore red before the repair.

## Red proof of the gate itself

The design proof was deliberately mutated by adding an inline `style` to the
receipt chip. The unchanged proof rejected it:

```excerpt
{"ok":false,"reasonCode":"DESIGN_SYSTEM_VIOLATION","legs":[
  {"leg":"token-fidelity","ok":true},
  {"leg":"no-literal-colours","ok":true},
  {"leg":"no-inline-style-attributes","ok":false,
   "reasonCode":"INLINE_STYLE_ATTRIBUTE_FOUND","findings":1},
  {"leg":"interactive-tcrn-class-coverage","ok":true}
]}
```

The mutation was reverted before the green run. This demonstrates that the
gate rejects a known portal violation; the repair did not weaken its
criterion.

## Repair and green readback

The portal train is now a single serial command in `package.json` and is
wired into both `scripts/task.mjs` and `.github/workflows/ci.yml` after the
engine test step. It runs `portal:test`, `portal:proof`, coverage
conservation, the coverage-gate mutation self-test, the INC-155 command-boundary
meta-proof, the verbatim evidence proof, and the INC-156 meta-proof in order.

```excerpt
{"ok":true,"reasonCode":"PORTAL_VERIFY_TRAIN_GREEN",
 "commands":[["pnpm","portal:test"],["pnpm","portal:proof"],
 ["node","scripts/coverage-conservation.mjs"],
 ["node","tests/coverage-conservation.test.mjs"],
 ["node","scripts/verbatim-evidence-proof.mjs","--check"]]}
```

The CI wiring assertion also passed:

```excerpt
{"ok":true,"command":"ci","reasonCode":"CI_HARDENING_VERIFIED",
 "linted":{"reasonCode":"LINT_VERIFIED","modules":180}}
```

`design-proof` 的腿名和 `INC-153` 的回读都不再靠手抄；当前真正执行的
design-proof 腿名由下面的 verbatim 块逐字校验：

```verbatim:node scripts/verbatim-evidence-proof.mjs inc140-design-proof
{
  "proof": "portal/scripts/design-proof.mjs",
  "legCount": 4,
  "legNames": [
    "token-fidelity",
    "no-literal-colours",
    "no-inline-style-attributes",
    "interactive-tcrn-class-coverage"
  ]
}
```

The engine `pnpm test` and this portal train remain separate serial stages;
no release, helper re-pin, push, tag, or deployment was performed.
