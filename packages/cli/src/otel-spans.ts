// SPDX-License-Identifier: Apache-2.0
// S10 (TCRN-CROSS-STORY-150) — engine verb entry/exit spans (observability).
//
// Emits one JSONL span per dispatched verb (entry + exit) when TCRN_OTEL_SINK is
// set. Env-gated so the engine's behaviour is byte-identical by default — the
// 103-verb catalogue and every hermetic test are untouched unless a sink is
// configured. Privacy: labels are ONLY verb + outcome (+ reasonCode on failure);
// no flags, args, payloads, or chain content ever reach the sink.
//
// Wiring point (design — release-gated to the v0.11.0 train): in `runCli`
// (packages/cli/src/index.ts), emit entry after the command guard and exit in a
// finally around the `await dispatchCli(...)` call, passing `io.clock()` for `at`
// (WSE-4: the wall-clock reader is injected, never read inside library code).
import { appendFileSync } from "node:fs";

export function engineSinkPath(): string | null {
  const configured = process.env.TCRN_OTEL_SINK;
  return configured !== undefined && configured.trim() !== "" ? configured : null;
}

export const ALLOWED_VERB_SPAN_KEYS = Object.freeze(["span", "at", "verb", "outcome", "reasonCode"]);

export function emitVerbSpan(
  verb: string,
  outcome: "entry" | "exit" | "failed",
  at: string,
  reasonCode: string | null = null,
): void {
  const sink = engineSinkPath();
  if (sink === null) return;
  const record = { span: "verb", at, verb, outcome, reasonCode };
  for (const key of Object.keys(record)) {
    if (!ALLOWED_VERB_SPAN_KEYS.includes(key)) {
      // A programming error would put content in the sink; this is the S10
      // privacy contract, enforced at the emitter.
      throw new Error(`span field not allowed by S10 privacy contract: ${key}`);
    }
  }
  try {
    appendFileSync(sink, `${JSON.stringify(record)}\n`);
  } catch {
    // observability must never break the verb it watches
  }
}
