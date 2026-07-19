// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

const localGitCommands = new Set([
  "cat-file",
  "for-each-ref",
  "fsck",
  "ls-tree",
  "reflog",
  "remote",
  "rev-list",
  "status",
]);

export class LocalCommandError extends Error {
  constructor(reasonCode, detail) {
    super(detail);
    this.name = "LocalCommandError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode, detail) {
  throw new LocalCommandError(reasonCode, detail);
}

function assertion(condition, reasonCode, detail) {
  if (!condition) fail(reasonCode, detail);
}

function diagnosticText(value) {
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return value ?? "";
}

export function runLocalCommand(executable, arguments_, options = {}) {
  const allowed = executable === process.execPath || executable === "git";
  assertion(allowed, "PROCESS_EXECUTABLE_NOT_ALLOWED", executable);
  if (executable === "git") {
    assertion(localGitCommands.has(arguments_[0]), "GIT_PROCESS_BOUNDARY", arguments_.join(" "));
    if (arguments_[0] === "remote") {
      assertion(
        arguments_.length === 1 || arguments_[1] === "get-url",
        "GIT_PROCESS_BOUNDARY",
        arguments_.join(" "),
      );
    }
  }
  const {
    cwd,
    encoding,
    env: extraEnvironment = {},
    raw = false,
    ...spawnOptions
  } = options;
  assertion(typeof cwd === "string" && cwd.length > 0, "PROCESS_CWD_REQUIRED", String(cwd));
  assertion(encoding === undefined, "PROCESS_ENCODING_FORBIDDEN", String(encoding));
  const executionOptions = {
    cwd,
    env: {
      ...process.env,
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
      NO_COLOR: "1",
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_offline: "true",
      ...extraEnvironment,
    },
    ...spawnOptions,
  };
  if (!raw) executionOptions.encoding = "utf8";
  const result = spawnSync(executable, arguments_, executionOptions);
  // A maxBuffer overflow is reported through `error` while `status` stays at 0 or null
  // depending on child exit timing, so a status-only guard admits silently truncated
  // stdout as success. Capture-bound faults fail closed here instead.
  //
  // Gate on ENOBUFS only. A blanket `if (result.error)` would reclassify ENOENT /
  // EAGAIN / ETIMEDOUT away from COMMAND_FAILED, a behaviour change with no motivation.
  if (result.error?.code === "ENOBUFS") {
    fail("COMMAND_OUTPUT_OVERFLOW", `${executable} ${arguments_.join(" ")}\nENOBUFS`);
  }
  if (result.status !== 0) {
    // stdout is decoded only on the failure path. Decoding it eagerly turns every
    // large raw capture into a discarded multi-megabyte decode, and above
    // MAX_STRING_LENGTH the RangeError escapes the typed failure contract entirely.
    fail(
      "COMMAND_FAILED",
      `${executable} ${arguments_.join(" ")}\n${diagnosticText(result.stdout)}${diagnosticText(result.stderr)}${result.error?.message ?? ""}`,
    );
  }
  const stderr = diagnosticText(result.stderr);
  if (stderr.trim() !== "") {
    fail("COMMAND_UNEXPECTED_STDERR", `${executable} ${arguments_.join(" ")}\n${stderr}`);
  }
  if (raw) {
    assertion(Buffer.isBuffer(result.stdout), "COMMAND_RAW_STDOUT_INVALID", executable);
    return result.stdout;
  }
  assertion(typeof result.stdout === "string", "COMMAND_TEXT_STDOUT_INVALID", executable);
  return result.stdout.trim();
}
