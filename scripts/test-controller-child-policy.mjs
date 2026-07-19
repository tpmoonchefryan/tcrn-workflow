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

// Anchor on the path segment boundary, not a literal leading slash. `endsWith` missed
// the bare relative form (`node scripts/task.mjs`), so the governed entrypoint was
// handed the controller preload; its bootstrap then spawns a recorded detached group,
// which this very policy refuses. Absolute, `./`-prefixed and bare relative must all
// match, while a lookalike such as `other-scripts/task.mjs` must not.
const taskEntrypointPattern = /(?:^|[\s/])scripts\/task\.mjs(?:\s|$)/u;

function taskEntrypointArguments(name, arguments_) {
  // exec receives a whole command line in the first position; the direct APIs receive
  // an argv array whose first entry is the script path.
  if (name === "exec" || name === "execSync") {
    return typeof arguments_[0] === "string" && taskEntrypointPattern.test(arguments_[0]);
  }
  const argumentsForCommand = Array.isArray(arguments_[1]) ? arguments_[1] : [];
  return typeof argumentsForCommand[0] === "string" && taskEntrypointPattern.test(argumentsForCommand[0]);
}

function environmentWithoutPolicy(environment) {
  const updated = { ...environment };
  const nodeOptions = nodeOptionsWithoutPolicy(updated.NODE_OPTIONS);
  if (nodeOptions === "") delete updated.NODE_OPTIONS;
  else updated.NODE_OPTIONS = nodeOptions;
  return updated;
}

function propagatePolicyToNodeChild(name, arguments_) {
  // fork always creates Node. The exec pair takes a shell command line rather than an
  // executable, and its leading token can be quoted, wrapped (`env node`, `FOO=1 node`)
  // or reached through `sh -c`, so no parse of it is trustworthy -- each of those three
  // forms was measured starting an unpreloaded child that then spawned a detached
  // grandchild. Propagate unconditionally for them. A child that is not Node ignores
  // NODE_OPTIONS, which makes the fail-closed choice the cheap one here.
  // For the remaining direct APIs, argv[0] is a real executable path, so only rewrite a
  // known Node executable; those ordinary child processes retain their exact
  // caller-supplied options and environment. That guarantee no longer holds for exec
  // and execSync, which now always receive a NODE_OPTIONS entry.
  const takesCommandLine = name === "exec" || name === "execSync";
  if (name !== "fork" && !takesCommandLine && !isNodeExecutable(arguments_[0])) return arguments_;
  const index = optionsIndex(name, arguments_);
  const options = index === undefined ? {} : object(arguments_[index]) ?? {};
  const environment = object(options.env) ?? process.env;
  const updatedOptions = {
    ...options,
    // `task.mjs` is the separately governed command entrypoint, whose own
    // bootstrap creates the recorded detached process group. It must start
    // without this test-controller preload; every Node child it later owns is
    // governed by that fresh controller boundary instead.
    env: taskEntrypointArguments(name, arguments_)
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
  if (inheritsStdioForCall(name, options)) {
    const error = new Error("TEST_CONTROLLER_INHERITED_STDIO_FORBIDDEN");
    error.code = "TEST_CONTROLLER_INHERITED_STDIO_FORBIDDEN";
    throw error;
  }
}

// An allowlist, not a denylist. Enumerating the inheriting spellings is unbounded:
// besides "inherit", [0,1,2] and the parent's own stream objects, any descriptor number
// above 2 can be a dup of the controller's output (measured: ["ignore", fd, "ignore"]
// with fd from openSync was admitted). Only these entries are known not to hand the
// child a descriptor of ours; everything else is refused.
const nonInheritingStdio = new Set(["pipe", "ignore", "overlapped", "ipc", null, undefined]);

function inheritsStdio(stdio) {
  if (stdio === undefined || stdio === null) return false;
  if (Array.isArray(stdio)) return stdio.some((entry) => !nonInheritingStdio.has(entry));
  return !nonInheritingStdio.has(stdio);
}

// fork resolves a missing stdio to ['inherit','inherit','inherit','ipc'] *inside* Node,
// after this policy has inspected the caller's options, so an absent stdio reads as
// non-inheriting while the child actually writes to the controller's stderr (measured:
// bare `fork(path)` was admitted and its output appeared on our stderr). `silent: true`
// is the documented way to ask for pipes, so only a falsy silent inherits.
function inheritsStdioForCall(name, options) {
  if (name === "fork" && options?.stdio === undefined && !options?.silent) return true;
  return inheritsStdio(options?.stdio);
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
