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

function optionsIndex(name, arguments_) {
  // The sync exec pair takes the same positions as its async twin minus the callback,
  // so options are always in the optional slot and never a function.
  if (name === "execSync") return 1;
  if (name === "execFileSync") return Array.isArray(arguments_[1]) ? 2 : 1;
  if (name === "spawn" || name === "spawnSync" || name === "execFile" || name === "fork") {
    // Node accepts an explicitly undefined optional arguments array, with the
    // options object still supplied in the third position. Normalize that
    // signature before both policy enforcement and environment propagation.
    if (name !== "execFile") {
      return Array.isArray(arguments_[1]) || (arguments_.length >= 3 && arguments_[1] === undefined) ? 2 : 1;
    }
    // execFile has a trailing callback.  A callback in either optional slot is
    // not an options object and must never be overwritten while injecting the
    // controller policy.
    if (Array.isArray(arguments_[1]) || (arguments_.length >= 3 && arguments_[1] === undefined)) {
      return typeof arguments_[2] === "function" ? undefined : 2;
    }
    return typeof arguments_[1] === "function" ? undefined : 1;
  }
  if (name === "exec") return typeof arguments_[1] === "function" ? undefined : 1;
  return undefined;
}

function optionsFor(name, arguments_) {
  const index = optionsIndex(name, arguments_);
  return index === undefined ? undefined : object(arguments_[index]);
}

function isNodeExecutable(command) {
  if (typeof command !== "string") return false;
  if (command === process.execPath || command === "node" || command === "nodejs") return true;
  // exec and its sync twin take a whole command line rather than an argv[0], so an
  // exact match never fired for them and `exec("node child.js", { env })` started an
  // unpreloaded child whenever the caller supplied an env of their own. Match the
  // leading word, optionally quoted or path-qualified.
  const leading = command.trimStart().match(/^"([^"]+)"|^'([^']+)'|^(\S+)/u);
  const executable = leading?.[1] ?? leading?.[2] ?? leading?.[3];
  if (executable === undefined) return false;
  const base = executable.split(/[/\\]/u).pop();
  return executable === process.execPath || base === "node" || base === "nodejs" ||
    base === "node.exe" || base === "nodejs.exe";
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
  const options = index === undefined ? {} : object(arguments_[index]) ?? {};
  const environment = object(options.env) ?? process.env;
  const updatedOptions = {
    ...options,
    // `task.mjs` is the separately governed command entrypoint, whose own
    // bootstrap creates the recorded detached process group. It must start
    // without this test-controller preload; every Node child it later owns is
    // governed by that fresh controller boundary instead.
    env: taskEntrypointArguments(arguments_)
      ? environmentWithoutPolicy(environment)
      : { ...environment, NODE_OPTIONS: nodeOptionsWithPolicy(environment.NODE_OPTIONS) },
  };
  const updated = [...arguments_];
  if (index !== undefined) {
    updated[index] = updatedOptions;
    return updated;
  }
  // The two callback APIs admit omitted options. Insert options before their
  // callback rather than replacing that callback with an object.
  if (name === "exec") {
    if (typeof updated[1] === "function") updated.splice(1, 0, updatedOptions);
    else updated[1] = updatedOptions;
    return updated;
  }
  if (name === "execFile") {
    const argumentsWereSupplied = Array.isArray(updated[1]) || (updated.length >= 3 && updated[1] === undefined);
    const target = argumentsWereSupplied ? 2 : 1;
    if (typeof updated[target] === "function") updated.splice(target, 0, updatedOptions);
    else updated[target] = updatedOptions;
    return updated;
  }
  return updated;
}

function rejectDetached(name, arguments_) {
  const options = optionsFor(name, arguments_);
  if (options?.detached) {
    const error = new Error("TEST_CONTROLLER_DETACHED_DESCENDANT_FORBIDDEN");
    error.code = "TEST_CONTROLLER_DETACHED_DESCENDANT_FORBIDDEN";
    throw error;
  }
  if (inheritsStdio(options?.stdio)) {
    const error = new Error("TEST_CONTROLLER_INHERITED_STDIO_FORBIDDEN");
    error.code = "TEST_CONTROLLER_INHERITED_STDIO_FORBIDDEN";
    throw error;
  }
}

// The string form is only the shorthand. `stdio: ["inherit", "inherit", "inherit"]`,
// `[0, 1, 2]`, and an array carrying the parent's own streams all hand the child the
// same descriptors, so matching the shorthand alone left the guarantee open to a
// caller who simply spelled it the long way.
function inheritsStdio(stdio) {
  if (stdio === "inherit") return true;
  if (!Array.isArray(stdio)) return false;
  return stdio.some((entry) => entry === "inherit" ||
    (typeof entry === "number" && entry >= 0 && entry <= 2) ||
    entry === process.stdin || entry === process.stdout || entry === process.stderr);
}

// execSync and execFileSync were absent from this list, so they spawned children under
// no policy at all -- neither the detached/stdio refusals nor the preload propagation
// reached them. They take the same (command, options) shape as their async twins.
for (const name of ["spawn", "spawnSync", "exec", "execFile", "execSync", "execFileSync", "fork"]) {
  const original = childProcess[name];
  childProcess[name] = function guardedChildProcess(...arguments_) {
    rejectDetached(name, arguments_);
    const child = original.apply(this, propagatePolicyToNodeChild(name, arguments_));
    return child;
  };
}

syncBuiltinESMExports();
