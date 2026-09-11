#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// The Stop-hook entry (TCRN-CROSS-STORY-123). This is the ONE impure orchestrator:
// it reads the pact, recovers the current model from the transcript, measures
// progress by tool activity, asks the pure decider for a verdict, applies the
// verdict's effects (bind session, set counter, deactivate on expiry, notify), and
// finally translates the neutral verdict into Claude Code's Stop-hook wire protocol.
//
// Wire protocol, verified against the Claude Code hook contract (2026-08-01):
//   - allow  → exit 0 with no decision (the stop proceeds)
//   - block  → print {"decision":"block","reason":"..."} then exit 0 (Claude continues,
//              the reason fed back). The JSON path is used, not exit 2, so the reason
//              reaches the model as structured feedback. The exit is deferred until the
//              stdout write has flushed (review finding: exit() before an async pipe
//              flush can truncate the decision).
//
// Safety posture: ANY failure here fails OPEN — a bug must never make a session
// un-stoppable. Every path is wrapped so an unexpected throw exits 0 with no block.
// The mechanism may fail to govern; it must never trap.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decide } from "./decide.mjs";
import { readPact, writePact, withRuntime } from "./pact.mjs";
import { resolveMode, resolveModelFromTranscript, toolUseCount, workedSinceLastBlock } from "./mode.mjs";
import { notify } from "./notify.mjs";
import { bindingFailure, recordVerificationObservation, recordVerificationTelemetry, runVerification, verifyPactBinding } from "./verify.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "cli.mjs");
const CLI_INVOCATION = `node ${CLI}`;

function readStdin() {
  try { return JSON.parse(readFileSync(0, "utf8")); } catch { return {}; }
}

async function main() {
  const hookInput = readStdin();
  const pact = readPact();

  // Fast path: no governing pact. The overwhelming common case (every ordinary
  // session); it must be cheap and total — no transcript read, nothing.
  if (!pact || pact.active !== true) { process.exit(0); }

  const sessionId = typeof hookInput.session_id === "string" ? hookInput.session_id : "";
  const transcriptPath = typeof hookInput.transcript_path === "string" ? hookInput.transcript_path : "";

  // A host continuation and an already terminal pact are explicit stop/cancel
  // priority. The verify branch is only for a live, owning running pact; legacy
  // pacts without the explicit binding continue through the old model path.
  if (hookInput.stop_hook_active === true || pact.status !== "running" ||
      (typeof pact.boundSession === "string" && pact.boundSession !== sessionId)) {
    return decideLegacyStop(hookInput, pact, sessionId, transcriptPath);
  }

  const binding = verifyPactBinding(pact, sessionId);
  if (binding.status === "available") {
    await recordVerificationObservation(pact, sessionId, "start");
    const verification = await runVerification(binding.command, pact.workspace);
    await recordVerificationTelemetry(pact, sessionId, verification);
    if (verification.ok) { process.exit(0); return; }
    // This is the only new hard-stop branch. Its reason is deliberately the
    // bounded UTF-8 stderr tail (or the explicit exit/timeout/start reason).
    process.exitCode = 0;
    process.stdout.write(`${JSON.stringify({ decision: "block", reason: `advisory:verify failed: ${verification.reason}` })}\n`, () => process.exit(0));
    return;
  }

  const bindingError = bindingFailure(pact, binding);
  if (bindingError !== null) {
    await recordVerificationTelemetry(pact, sessionId, bindingError);
    process.exitCode = 0;
    process.stdout.write(`${JSON.stringify({ decision: "block", reason: `advisory:verify failed: ${bindingError.reason}` })}\n`, () => process.exit(0));
    return;
  }

  return decideLegacyStop(hookInput, pact, sessionId, transcriptPath);
}

function decideLegacyStop(hookInput, pact, sessionId, transcriptPath) {

  // Enforcement strength from the CURRENT model (recovered from the transcript; the
  // model is not in stdin). Flagship families and unknown/new names => observe;
  // only explicitly reviewed non-flagship families enforce.
  const model = resolveModelFromTranscript(transcriptPath);
  const mode = resolveMode(model);

  // Progress for the escalation valve, measured by tool activity (immune to the block
  // reason, which carries no tool_use). Unknown => no progress => the valve releases.
  const currentToolUses = toolUseCount(transcriptPath);
  const lastBlockToolUses = pact.runtime?.lastBlockToolUses ?? null;
  const worked = workedSinceLastBlock(currentToolUses, lastBlockToolUses);

  const verdict = decide({
    pact,
    now: new Date().toISOString(),
    sessionId,
    stopHookActive: hookInput.stop_hook_active === true,
    mode,
    workedSinceLastBlock: worked,
    consecutiveBlocks: pact.runtime?.consecutiveBlocks ?? 0,
    cliInvocation: CLI_INVOCATION,
  });

  // Do not write for a firing that does not own the pact. A review finding showed the
  // default effects (setConsecutiveBlocks:0) let a PARALLEL session reset the bound
  // session's counter — defeating the escalation valve from a bystander session. Only
  // a firing that governs this pact may touch its runtime.
  if (verdict.code !== "OTHER_SESSION") applyEffects(pact, verdict, currentToolUses);

  if (verdict.notify) notify(verdict.notify.level, verdict.notify.message);

  if (verdict.action === "block") {
    // Defer exit until the write drains, or a large reason can be truncated on a pipe.
    process.exitCode = 0;
    process.stdout.write(`${JSON.stringify({ decision: "block", reason: verdict.message })}\n`, () => process.exit(0));
    return;
  }
  process.exit(0); // allow
}

// Persist the verdict's effects to the pact file. Best-effort and swallowed — a
// bookkeeping error must not throw out of the hook.
function applyEffects(pact, verdict, currentToolUses) {
  try {
    if (verdict.effects.deactivate) {
      const at = new Date().toISOString();
      const next = {
        ...pact,
        status: "expired",
        active: false,
        history: [...(pact.history ?? []), { at, event: "expired", detail: "TTL reached, enforcement lifted" }],
      };
      writePact(next);
      return;
    }
    const runtimePatch = { consecutiveBlocks: verdict.effects.setConsecutiveBlocks };
    if (verdict.effects.recordBlockOffset && typeof currentToolUses === "number") {
      runtimePatch.lastBlockToolUses = currentToolUses;
    }
    if (verdict.effects.bindSession) runtimePatch.boundSession = verdict.effects.bindSession;
    const next = withRuntime(pact, runtimePatch);
    if (JSON.stringify(next) !== JSON.stringify(pact)) writePact(next);
  } catch { /* never fail the stop on a bookkeeping error */ }
}

try { await main(); } catch { process.exit(0); }
