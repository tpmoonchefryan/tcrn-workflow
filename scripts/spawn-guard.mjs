// SPDX-License-Identifier: Apache-2.0
//
// INIT-007 / S041 (registration face) + S042 (host edge). This is the thin,
// host-specific adapter around the pure background-resource core — the only part
// that touches `ps`, the clock, and the filesystem. It is NOT a verification gate
// (it reads a live process table, which no hermetic gate can), so like
// host-evidence.mjs it lives outside the `verify:*` namespace and nothing in the
// build depends on it.
//
// A governed session that spawns a background load (a CPU-stress loop, a dev
// server, a headless browser) calls `register` at spawn time with the load's
// process GROUP id; at teardown a `detect` run reports any owned group that still
// has live members, or any init-reparented orphan matching a registered command
// pattern. The registry is a transient JSONL file OUTSIDE the engine control tree
// — replay and the snapshot witness never see it, so it can never be mistaken for
// canonical control bytes (docs/architecture/root-model.md: transient is
// disposable and non-authoritative).
//
// Exit codes: 0 = clean (detect) or done (register/deregister/list); 3 = residue
// present (detect); 1 = usage or I/O error. The distinct code 3 lets a host hook
// tell "a leak was found" apart from "the detector itself failed".

import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const {
  buildRegistrationLine,
  buildResidueReport,
  detectResidue,
  parseProcessTable,
  parseRegistrationLine,
  parseRegistry,
} = await import(`${repositoryRoot}/dist/build/packages/core/src/index.js`);

const REGISTRY_SUBPATH = "spawn-registry/registrations.jsonl";

function fail(message) {
  process.stderr.write(`SPAWN_GUARD_USAGE: ${message}\n`);
  process.exit(1);
}

function parseFlags(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) fail(`unexpected argument ${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`flag --${key} needs a value`);
    flags[key] = value;
    index += 1;
  }
  return flags;
}

// Resolve the transient registry file. Prefer an explicit --transient dir; else
// derive the transient root as the sibling of a --workspace root (the partition
// layout <partition>/{workspace,transient}); else fall back to --registry.
function registryPath(flags) {
  if (flags.registry) return resolve(flags.registry);
  if (flags.transient) return resolve(flags.transient, REGISTRY_SUBPATH);
  if (flags.workspace) return resolve(dirname(resolve(flags.workspace)), "transient", REGISTRY_SUBPATH);
  fail("one of --registry, --transient, or --workspace is required");
  return "";
}

async function readRegistryText(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

// Read the live process table exactly as the reaper does: hard-pathed ps, scrubbed
// PATH, headerless numeric columns plus the free-form command. Any stderr or a
// non-zero status fails closed rather than detecting against a partial table.
function readProcessTable() {
  const listed = spawnSync("/bin/ps", ["-axo", "pid=,pgid=,ppid=,%cpu=,command="], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: { PATH: "/usr/bin:/bin" },
  });
  if (listed.status !== 0 || listed.error || (listed.stderr ?? "").trim() !== "") {
    process.stderr.write("SPAWN_GUARD_PROCESS_LIST_FAILED\n");
    process.exit(1);
  }
  return listed.stdout;
}

function nowFlag(flags) {
  if (flags.at) return flags.at;
  // The clock is a host concern; detect/register accept an explicit --at for
  // determinism, but default to the wall clock for interactive use.
  return new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");
}

async function commandRegister(flags) {
  const path = registryPath(flags);
  if (!flags.pgid || !flags.pattern) fail("register needs --pgid and --pattern");
  const line = buildRegistrationLine({
    pgid: Number(flags.pgid),
    pattern: flags.pattern,
    purpose: flags.purpose ?? "",
    spawnedAt: nowFlag(flags),
  });
  await mkdir(dirname(path), { recursive: true });
  const existing = await readRegistryText(path);
  await writeFile(path, existing + line, { mode: 0o600 });
  process.stdout.write(line);
}

async function commandDeregister(flags) {
  const path = registryPath(flags);
  if (!flags.pgid) fail("deregister needs --pgid");
  const pgid = Number(flags.pgid);
  const kept = [];
  for (const line of (await readRegistryText(path)).split("\n")) {
    if (line.trim() === "") continue;
    if (parseRegistrationLine(line).pgid !== pgid) kept.push(line);
  }
  await writeFile(path, kept.length === 0 ? "" : `${kept.join("\n")}\n`, { mode: 0o600 });
  process.stdout.write(`SPAWN_GUARD_DEREGISTERED ${pgid}\n`);
}

async function commandList(flags) {
  const registrations = parseRegistry(await readRegistryText(registryPath(flags)));
  for (const registration of registrations) process.stdout.write(buildRegistrationLine(registration));
}

async function commandDetect(flags) {
  const registrations = parseRegistry(await readRegistryText(registryPath(flags)));
  const rows = parseProcessTable(readProcessTable());
  const report = detectResidue(registrations, rows, nowFlag(flags));
  process.stdout.write(buildResidueReport(report));
  process.exit(report.status === "residue-present" ? 3 : 0);
}

const [command, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);
if (command === "register") await commandRegister(flags);
else if (command === "deregister") await commandDeregister(flags);
else if (command === "list") await commandList(flags);
else if (command === "detect") await commandDetect(flags);
else fail(`unknown command ${command ?? "(none)"}; use register|deregister|list|detect`);
