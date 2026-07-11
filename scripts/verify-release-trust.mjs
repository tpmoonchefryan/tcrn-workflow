#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { TrustVerificationError, verifyReleaseBundle } from "./lib/release-trust.mjs";
import { repositoryRoot } from "./lib/files.mjs";

function parseArguments(values) {
  const output = {};
  const allowed = new Set(["trust-root", "bundle", "subject", "repository", "workflow", "now"]);
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new TrustVerificationError("TRUST_ARGUMENTS_INVALID", "Arguments must be --name value pairs");
    }
    const name = flag.slice(2);
    if (!allowed.has(name)) {
      throw new TrustVerificationError("TRUST_ARGUMENT_UNKNOWN", `Unknown argument: ${name}`);
    }
    if (output[name] !== undefined) {
      throw new TrustVerificationError("TRUST_ARGUMENTS_INVALID", `Duplicate argument: ${name}`);
    }
    output[name] = value;
  }
  return output;
}

try {
  if (process.version !== "v24.16.0") {
    throw new TrustVerificationError("TRUST_RUNTIME_VERSION", `Expected Node v24.16.0, received ${process.version}`);
  }
  const argumentsByName = parseArguments(process.argv.slice(2));
  const required = ["trust-root", "bundle", "subject", "repository", "workflow", "now"];
  const missing = required.filter((name) => !argumentsByName[name]);
  if (missing.length > 0) {
    throw new TrustVerificationError("TRUST_ARGUMENTS_REQUIRED", `Missing arguments: ${missing.join(",")}`);
  }
  const result = await verifyReleaseBundle({
    repositoryRoot,
    trustRootPath: argumentsByName["trust-root"],
    bundlePath: argumentsByName.bundle,
    expectedSubject: argumentsByName.subject,
    expectedRepository: argumentsByName.repository,
    expectedWorkflow: argumentsByName.workflow,
    now: argumentsByName.now,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const reasonCode = error instanceof TrustVerificationError ? error.reasonCode : "TRUST_INTERNAL_ERROR";
  process.stderr.write(`${JSON.stringify({ admitted: false, reasonCode, message: error.message })}\n`);
  process.exitCode = 1;
}
