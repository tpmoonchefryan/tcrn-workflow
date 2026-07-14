// SPDX-License-Identifier: Apache-2.0

// A governed test command owns its output session as one process group.  A
// detached child would escape that group while retaining inherited output
// descriptors or a write-capable checkout. Refuse the escape unconditionally
// before it is spawned; test code cannot mint an exception through its
// caller-supplied environment.

import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

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
    const child = original.apply(this, arguments_);
    return child;
  };
}

syncBuiltinESMExports();
