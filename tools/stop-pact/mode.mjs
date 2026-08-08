// SPDX-License-Identifier: Apache-2.0
// Enforcement-strength resolution and progress measurement
// (TCRN-CROSS-STORY-117 / decision D2). Both jobs share one governing principle,
// which the adversarial review (2026-08-01) forced to the surface: ON MISSING OR
// AMBIGUOUS INFORMATION, FAIL TOWARD NOT BLOCKING. An unknown model is treated as
// the flagship (observe, never block); unknown progress is treated as no progress
// (so the escalation valve climbs and RELEASES rather than being starved into
// blocking forever). The two hard invariants — never trap a session, never harm a
// flagship — both live on that side of every ambiguity.
//
// D2: flagship families (Opus/Fable) => observe. Explicitly identified ordinary
// families may enforce. Unknown or newly introduced model names => observe, NOT a
// configurable fallback: a review finding proved that an enforce fallback blocks a
// flagship session whenever its model cannot be recovered from the transcript.
// Model-recovery failure therefore lands on observe unconditionally.
//
// The model is NOT in the Stop-hook stdin (verified against the Claude Code hook
// contract, 2026-08-01); it is recovered from the transcript's last assistant entry.

import { openSync, fstatSync, readSync, closeSync } from "node:fs";

export const OBSERVE_MODEL_PATTERNS = Object.freeze([
  /(?:^|[-_.])(?:opus|fable)(?:[-_.\d]|$)/iu, // flagship families, never constrained (D2)
]);

export const ENFORCE_MODEL_PATTERNS = Object.freeze([
  /^(?:gpt-(?:4|4o|5-codex)|claude-(?:haiku|sonnet))(?:[-_.\d]|$)/iu,
]);

// Unknown/new model => observe (fail toward flagship-safe). Only a named, reviewed
// non-flagship family takes the enforce branch.
export function resolveMode(model) {
  if (typeof model !== "string" || model.length === 0) return "observe";
  if (OBSERVE_MODEL_PATTERNS.some((pattern) => pattern.test(model))) return "observe";
  if (ENFORCE_MODEL_PATTERNS.some((pattern) => pattern.test(model))) return "enforce";
  return "observe";
}

// Recover the current model from the transcript's last assistant entry. Reads a
// bounded tail so this is cheap on a large transcript. A review finding showed the
// old code unconditionally dropped the tail's first (possibly partial) line, which
// could discard the ONLY assistant-model line and misresolve the model; now the
// leading line is dropped ONLY if it fails to parse, and any parseable assistant
// model in the tail is honoured. Returns null on any trouble — and null => observe.
export function resolveModelFromTranscript(transcriptPath, { tailBytes = 262144 } = {}) {
  if (typeof transcriptPath !== "string" || transcriptPath.length === 0) return null;
  let fd;
  try {
    fd = openSync(transcriptPath, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - tailBytes);
    const length = size - start;
    if (length <= 0) return null;
    const buffer = Buffer.allocUnsafe(length);
    readSync(fd, buffer, 0, length, start);
    const lines = buffer.toString("utf8").split("\n").filter((line) => line.trim().length > 0);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      // A mid-file tail can make lines[0] a fragment. It is only skipped when it
      // actually fails to parse — a valid record there is still used.
      if (i === 0 && start > 0) {
        try { JSON.parse(lines[0]); } catch { continue; }
      }
      const model = modelOfLine(lines[i]);
      if (model) return model;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

function modelOfLine(line) {
  let entry;
  try { entry = JSON.parse(line); } catch { return null; }
  if (entry?.type !== "assistant") return null;
  const model = entry?.message?.model;
  return typeof model === "string" && model.length > 0 ? model : null;
}

// The progress measure the escalation valve turns on. A review finding showed that
// counting raw transcript LINES is defeated by blocking itself: the injected block
// reason plus the model's forced continuation add lines every cycle, so a stuck run
// reads as "worked", the streak resets, and the release valve never fires. Progress
// is therefore measured by TOOL activity — a run that actually did something emits
// tool_use blocks; a run that merely re-says "done" emits none. The count is a raw
// substring scan of the transcript for tool_use markers: cheap, robust, and immune
// to the block reason (which carries no tool_use). Returns null on unreadable.
export function toolUseCount(transcriptPath, { chunkBytes = 1024 * 1024 } = {}) {
  if (typeof transcriptPath !== "string" || transcriptPath.length === 0) return null;
  let fd;
  try {
    fd = openSync(transcriptPath, "r");
    const size = fstatSync(fd).size;
    if (size === 0) return 0;
    const needle = Buffer.from('"type":"tool_use"', "utf8");
    const overlap = needle.length - 1;
    const buffer = Buffer.allocUnsafe(Math.min(chunkBytes, size) + overlap);
    let offset = 0;
    let carry = 0; // bytes retained from the previous chunk to catch a needle on the boundary
    let count = 0;
    while (offset < size) {
      const want = Math.min(chunkBytes, size - offset);
      const read = readSync(fd, buffer, carry, want, offset);
      if (read <= 0) break;
      const view = buffer.subarray(0, carry + read);
      let from = 0;
      for (;;) {
        const at = view.indexOf(needle, from);
        if (at === -1) break;
        count += 1;
        from = at + needle.length;
      }
      // retain the last `overlap` bytes so a needle split across the seam is counted once
      carry = Math.min(overlap, carry + read);
      view.copy(buffer, 0, view.length - carry, view.length);
      offset += read;
    }
    return count;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

// Did genuine work happen since the last block? Fails toward NO PROGRESS on missing
// information — the opposite of the old code — so an unreadable/unknown transcript
// lets the streak climb to the cap and RELEASE rather than pinning it and blocking
// forever. The one "worked" default is the very first block (no prior marker
// recorded), where there is nothing yet to compare and blocking-then-counting is
// correct.
export function workedSinceLastBlock(currentMarkers, lastBlockMarkers) {
  if (typeof currentMarkers !== "number") return false; // unknown now => no progress => release direction
  if (typeof lastBlockMarkers !== "number") return true; // no prior block => fresh
  return currentMarkers > lastBlockMarkers;
}
