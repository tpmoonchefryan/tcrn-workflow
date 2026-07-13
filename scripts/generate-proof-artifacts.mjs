#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { ProofArtifactError, generateProofArtifacts } from "./lib/proof-artifacts.mjs";

const arguments_ = process.argv.slice(2).filter((argument) => argument !== "--");
const mode = arguments_.length === 0 ? "write" : arguments_.length === 1 && arguments_[0] === "--check" ? "check" : "invalid";

try {
  const receipt = await generateProofArtifacts({ mode });
  process.stdout.write(`${JSON.stringify({ ok: receipt.reasonCode !== "PROOF_ARTIFACTS_STALE", mode, ...receipt })}\n`);
  if (receipt.reasonCode === "PROOF_ARTIFACTS_STALE") process.exitCode = 1;
} catch (error) {
  const reasonCode = error instanceof ProofArtifactError ? error.reasonCode : "PROOF_ARTIFACT_INTERNAL_ERROR";
  process.stderr.write(`${JSON.stringify({ ok: false, reasonCode, error: String(error?.message ?? error) })}\n`);
  process.exitCode = 1;
}
