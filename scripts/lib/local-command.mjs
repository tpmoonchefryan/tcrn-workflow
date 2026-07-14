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
  const stdout = diagnosticText(result.stdout);
  const stderr = diagnosticText(result.stderr);
  if (result.status !== 0) {
    fail(
      "COMMAND_FAILED",
      `${executable} ${arguments_.join(" ")}\n${stdout}${stderr}${result.error?.message ?? ""}`,
    );
  }
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
