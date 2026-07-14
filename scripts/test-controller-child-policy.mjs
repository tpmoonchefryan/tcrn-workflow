// SPDX-License-Identifier: Apache-2.0

// A governed test command owns its output session as one process group.  A
// detached child would escape that group while retaining inherited output
// descriptors or a write-capable checkout. Refuse the escape unconditionally
// before it is spawned; test code cannot mint an exception through its
// caller-supplied environment.

import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

// Node does not inherit command-line --import arguments when a test spawns a
// new Node process.  Preserve the controller policy across that boundary with
// NODE_OPTIONS, then also seal an explicit env override in the direct Node
// spawning APIs below.  This keeps a permitted relay from becoming an
// unpreloaded escape hatch for a detached grandchild.
const policyNodeOption = `--import=${import.meta.url}`;

function nodeOptionsWithPolicy(nodeOptions) {
  const current = typeof nodeOptions === "string" ? nodeOptions.trim() : "";
  if (current.includes(policyNodeOption)) return current;
  return current === "" ? policyNodeOption : `${current} ${policyNodeOption}`;
}

function nodeOptionsWithoutPolicy(nodeOptions) {
  return typeof nodeOptions === "string"
    ? nodeOptions.split(/\s+/u).filter((option) => option !== policyNodeOption).join(" ").trim()
    : "";
}

process.env.NODE_OPTIONS = nodeOptionsWithPolicy(process.env.NODE_OPTIONS);

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function optionsFor(name, arguments_) {
  if (name === "spawn" || name === "spawnSync" || name === "execFile") {
    return Array.isArray(arguments_[1]) ? object(arguments_[2]) : object(arguments_[1]);
  }
  if (name === "fork") return Array.isArray(arguments_[1]) ? object(arguments_[2]) : object(arguments_[1]);
  if (name === "exec") return object(arguments_[1]);
  return undefined;
}

function optionsIndex(name, arguments_) {
  if (name === "spawn" || name === "spawnSync" || name === "execFile" || name === "fork") {
    return Array.isArray(arguments_[1]) ? 2 : 1;
  }
  if (name === "exec") return 1;
  return undefined;
}

function isNodeExecutable(command) {
  return command === process.execPath || command === "node" || command === "nodejs";
}

function taskEntrypointArguments(arguments_) {
  const argumentsForCommand = Array.isArray(arguments_[1]) ? arguments_[1] : [];
  return typeof argumentsForCommand[0] === "string" && argumentsForCommand[0].endsWith("/scripts/task.mjs");
}

function environmentWithoutPolicy(environment) {
  const updated = { ...environment };
  const nodeOptions = nodeOptionsWithoutPolicy(updated.NODE_OPTIONS);
  if (nodeOptions === "") delete updated.NODE_OPTIONS;
  else updated.NODE_OPTIONS = nodeOptions;
  return updated;
}

function propagatePolicyToNodeChild(name, arguments_) {
  // fork always creates Node. For the other direct APIs, only rewrite a known
  // Node executable; ordinary supported child processes retain their exact
  // caller-supplied options and environment.
  if (name !== "fork" && !isNodeExecutable(arguments_[0])) return arguments_;
  const index = optionsIndex(name, arguments_);
  if (index === undefined) return arguments_;
  const options = object(arguments_[index]) ?? {};
  const environment = object(options.env) ?? process.env;
  const updated = [...arguments_];
  updated[index] = {
    ...options,
    // `task.mjs` is the separately governed command entrypoint, whose own
    // bootstrap creates the recorded detached process group. It must start
    // without this test-controller preload; every Node child it later owns is
    // governed by that fresh controller boundary instead.
    env: taskEntrypointArguments(arguments_)
      ? environmentWithoutPolicy(environment)
      : { ...environment, NODE_OPTIONS: nodeOptionsWithPolicy(environment.NODE_OPTIONS) },
  };
  return updated;
}

function rejectDetached(name, arguments_) {
  const options = optionsFor(name, arguments_);
  if (options?.detached) {
    const error = new Error("TEST_CONTROLLER_DETACHED_DESCENDANT_FORBIDDEN");
    error.code = "TEST_CONTROLLER_DETACHED_DESCENDANT_FORBIDDEN";
    throw error;
  }
  if (options?.stdio === "inherit") {
    const error = new Error("TEST_CONTROLLER_INHERITED_STDIO_FORBIDDEN");
    error.code = "TEST_CONTROLLER_INHERITED_STDIO_FORBIDDEN";
    throw error;
  }
}

for (const name of ["spawn", "spawnSync", "exec", "execFile", "fork"]) {
  const original = childProcess[name];
  childProcess[name] = function guardedChildProcess(...arguments_) {
    rejectDetached(name, arguments_);
    const child = original.apply(this, propagatePolicyToNodeChild(name, arguments_));
    return child;
  };
}

syncBuiltinESMExports();
