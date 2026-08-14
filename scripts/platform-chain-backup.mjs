#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const SNAPSHOT_INTERVAL_HOURS = 6;
export const SNAPSHOT_RETENTION = 14;
export const SNAPSHOT_SCHEMA = "tcrn.platform-chain-snapshot.v1";
export const OFFSITE_SCHEMA = "tcrn.platform-chain-offsite.v1";

function failure(reasonCode, message, details = {}) {
  const error = new Error(message);
  error.reasonCode = reasonCode;
  Object.assign(error, details);
  return error;
}

function timestampSlug(date = new Date()) {
  return date.toISOString().replaceAll(/[-:.]/gu, "").replace("Z", "Z");
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeJson(path, value) {
  await writeFile(path, jsonText(value), { mode: 0o600 });
}

async function fileSha256(path) {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

function spawnCapture(command, args, input = null, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    const timer = options.timeoutMs ? setTimeout(() => child.kill("SIGTERM"), options.timeoutMs) : null;
    child.once("error", (error) => {
      if (timer) clearTimeout(timer);
      rejectPromise(error);
    });
    child.once("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      const result = { code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
      if (code === 0) resolvePromise(result);
      else {
        const error = failure("BACKUP_COMMAND_FAILED", `${command} exited with ${String(code ?? signal)}`, {
          command,
          args,
          exitCode: code,
          signal,
          stdout: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        });
        rejectPromise(error);
      }
    });
    if (input !== null) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function runCommand(command, args, options = {}) {
  try {
    return await spawnCapture(command, args, options.input ?? null, options);
  } catch (error) {
    if (error?.code === "ENOENT") throw failure("BACKUP_COMMAND_UNAVAILABLE", `${command} is unavailable`, { command });
    throw error;
  }
}

async function existingFile(path) {
  try {
    const value = await stat(path);
    return value.isFile() ? value : null;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readDueReceipt(path, kind) {
  try {
    const receipt = await readJson(path);
    const timestamp = kind === "offsite" ? receipt.pushedAt : receipt.finishedAt;
    const ageHours = typeof timestamp === "string" ? (Date.now() - Date.parse(timestamp)) / 3_600_000 : Number.POSITIVE_INFINITY;
    return { receipt, ageHours, fresh: receipt.ok === true && Number.isFinite(ageHours) && ageHours < SNAPSHOT_INTERVAL_HOURS };
  } catch {
    return { receipt: null, ageHours: Number.POSITIVE_INFINITY, fresh: false };
  }
}

export async function isSnapshotDue(archiveRoot) {
  const local = await readDueReceipt(join(archiveRoot, "local-snapshot.json"), "local");
  const offsite = await readDueReceipt(join(archiveRoot, "offsite-push.json"), "offsite");
  return !(local.fresh && offsite.fresh);
}

async function readChainVersions(platformRoot, options = {}) {
  if (options.chainVersions !== undefined) return options.chainVersions;
  const workspaceRoot = join(platformRoot, ".tcrn-workspace");
  const engineCli = options.engineCli
    ?? process.env.TCRN_WORKFLOW_ENGINE_CLI
    ?? join(process.env.HOME ?? "", ".tcrn-workflow", "tcrn-workflow", "scripts", "tcrn-workflow.mjs");
  if (!engineCli) throw failure("BACKUP_ENGINE_CLI_UNAVAILABLE", "an engine CLI is required to record chain versions");
  const entries = await readdir(workspaceRoot, { withFileTypes: true });
  const versions = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
    const workspacePath = join(workspaceRoot, entry.name, "workspace");
    const workspaceStats = await stat(workspacePath).catch(() => null);
    if (!workspaceStats?.isDirectory()) continue;
    try {
      const result = await runCommand(process.execPath, [engineCli, "status", "--workspace", workspacePath], { timeoutMs: 30_000 });
      const status = JSON.parse(result.stdout.toString("utf8"));
      versions.push({
        partition: entry.name,
        workspace: relative(platformRoot, workspacePath),
        engineVersion: status.engineVersion ?? null,
        version: status.version ?? null,
        headEventHash: status.headEventHash ?? null,
        workspaceId: status.workspaceId ?? null,
      });
    } catch (error) {
      throw failure("BACKUP_CHAIN_VERSION_UNAVAILABLE", `could not record ${entry.name} chain version`, {
        partition: entry.name,
        cause: error?.reasonCode ?? error?.code ?? "STATUS_FAILED",
      });
    }
  }
  if (versions.length === 0) throw failure("BACKUP_CHAIN_VERSION_UNAVAILABLE", "no partition workspaces were found");
  return versions;
}

async function listSnapshots(archiveRoot) {
  const entries = await readdir(archiveRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /^chain-snapshot-[0-9TZ]+\.tar\.gz$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function verifySnapshot(snapshotPath, manifestPath) {
  const manifest = await readJson(manifestPath);
  const actual = await fileSha256(snapshotPath);
  if (actual !== manifest.snapshotSha256) throw failure("BACKUP_LATEST_SNAPSHOT_VERIFY_FAILED", "latest snapshot digest does not match its manifest", { snapshotPath, expected: manifest.snapshotSha256, actual });
  return { ok: true, snapshotSha256: actual, snapshotBytes: manifest.snapshotBytes };
}

async function rotateSnapshots(archiveRoot, keep = SNAPSHOT_RETENTION) {
  const snapshots = await listSnapshots(archiveRoot);
  if (snapshots.length <= keep) return { retained: snapshots.length, removed: [] };
  const latest = snapshots.at(-1);
  await verifySnapshot(join(archiveRoot, latest), join(archiveRoot, latest.replace(".tar.gz", ".manifest.json")));
  const removeNames = snapshots.slice(0, snapshots.length - keep);
  for (const name of removeNames) {
    await unlink(join(archiveRoot, name));
    for (const suffix of [".manifest.json", ".chain-versions.json"]) {
      const sidecar = join(archiveRoot, name.replace(".tar.gz", suffix));
      try { await unlink(sidecar); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
  }
  return { retained: snapshots.length - removeNames.length, removed: removeNames };
}

export async function createSnapshot(platformRootArgument, options = {}) {
  if (typeof platformRootArgument !== "string" || platformRootArgument.trim().length === 0) throw failure("PLATFORM_ROOT_REQUIRED", "--platform-root is required");
  const platformRoot = resolve(platformRootArgument);
  const workspaceRoot = join(platformRoot, ".tcrn-workspace");
  const workspaceStats = await stat(workspaceRoot).catch((error) => { throw failure("BACKUP_WORKSPACE_UNAVAILABLE", "the platform workspace container is unavailable", { error: error?.code ?? "UNKNOWN" }); });
  if (!workspaceStats.isDirectory()) throw failure("BACKUP_WORKSPACE_UNAVAILABLE", "the platform workspace container is not a directory");
  const archiveRoot = resolve(options.archiveRoot ?? join(platformRoot, ".tcrn-artifacts", "chain-snapshots"));
  await mkdir(archiveRoot, { recursive: true, mode: 0o700 });
  const stamp = timestampSlug(options.now ? new Date(options.now) : new Date());
  const name = `chain-snapshot-${stamp}.tar.gz`;
  const tempRoot = await mkdtemp(join(tmpdir(), "tcrn-platform-chain-snapshot-"));
  const partialPath = join(tempRoot, name);
  const snapshotPath = join(archiveRoot, name);
  try {
    await runCommand("tar", ["-czf", partialPath, "-C", platformRoot, ".tcrn-workspace"], { timeoutMs: 120_000 });
    const snapshotSha256 = await fileSha256(partialPath);
    const snapshotBytes = (await stat(partialPath)).size;
    const chainVersions = await readChainVersions(platformRoot, options);
    await rename(partialPath, snapshotPath);
    const manifestPath = join(archiveRoot, name.replace(".tar.gz", ".manifest.json"));
    const versionsPath = join(archiveRoot, name.replace(".tar.gz", ".chain-versions.json"));
    const manifest = {
      schemaVersion: SNAPSHOT_SCHEMA,
      createdAt: new Date().toISOString(),
      snapshotFile: name,
      snapshotSha256,
      snapshotBytes,
      workspaceRelative: ".tcrn-workspace",
      chainVersions,
    };
    await writeJson(manifestPath, manifest);
    await writeJson(versionsPath, { schemaVersion: "tcrn.platform-chain-versions.v1", recordedAt: manifest.createdAt, chainVersions });
    const rotation = await rotateSnapshots(archiveRoot, options.retention ?? SNAPSHOT_RETENTION);
    const receipt = {
      schemaVersion: "tcrn.platform-local-snapshot-receipt.v1",
      ok: true,
      finishedAt: manifest.createdAt,
      snapshotFile: name,
      snapshotSha256,
      snapshotBytes,
      chainVersions,
      retainedSnapshots: rotation.retained,
      source: "platform-chain-backup",
    };
    await writeJson(join(archiveRoot, "local-snapshot.json"), receipt);
    return { platformRoot, archiveRoot, snapshotPath, manifestPath, versionsPath, manifest, rotation, receipt };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function gpgLocalAvailable(options) {
  const candidate = options.gpgBin ?? process.env.TCRN_BACKUP_GPG_BIN ?? "gpg";
  try {
    await runCommand(candidate, ["--version"], { timeoutMs: 10_000 });
    return candidate;
  } catch (error) {
    if (error?.reasonCode === "BACKUP_COMMAND_UNAVAILABLE" || error?.code === "ENOENT") return null;
    throw error;
  }
}

async function passphrase(options) {
  const path = options.passphraseFile ?? process.env.TCRN_BACKUP_GPG_PASSPHRASE_FILE;
  if (!path) throw failure("BACKUP_GPG_PASSPHRASE_REFERENCE_REQUIRED", "a passphrase file reference outside the repository is required");
  const value = (await readFile(path, "utf8")).trim();
  if (value.length === 0 || value.includes("\n") || value.includes("\r")) throw failure("BACKUP_GPG_PASSPHRASE_INVALID", "the referenced passphrase must be one non-empty line");
  return value;
}

async function gpgTransform(inputPath, outputPath, mode, options = {}) {
  const local = await gpgLocalAvailable(options);
  const phrasePath = options.passphraseFile ?? process.env.TCRN_BACKUP_GPG_PASSPHRASE_FILE;
  if (local) {
    if (!phrasePath) throw failure("BACKUP_GPG_PASSPHRASE_REFERENCE_REQUIRED", "a passphrase file reference outside the repository is required");
    const args = ["--batch", "--yes", "--pinentry-mode", "loopback", "--passphrase-file", phrasePath, mode === "encrypt" ? "--symmetric" : "--decrypt", "--output", outputPath, inputPath];
    await runCommand(local, args, { timeoutMs: 120_000 });
    return { method: "gpg", command: local };
  }
  const host = options.gpgSshHost ?? process.env.TCRN_BACKUP_GPG_SSH_HOST;
  if (!host) throw failure("BACKUP_GPG_UNAVAILABLE", "local gpg is unavailable and no gpg SSH host was configured");
  const secret = await passphrase(options);
  const payload = await readFile(inputPath);
  const createPassphraseCommand = "sh -c 'umask 077; p=$(mktemp /tmp/tcrn-gpg-pass.XXXXXX); cat > $p; printf %s $p'";
  const created = await runCommand("ssh", ["-o", "BatchMode=yes", host, createPassphraseCommand], { input: Buffer.from(secret, "utf8"), timeoutMs: 30_000 });
  const remotePath = created.stdout.toString("utf8").trim();
  if (!/^\/tmp\/tcrn-gpg-pass\.[A-Za-z0-9]+$/u.test(remotePath)) throw failure("BACKUP_GPG_REMOTE_PASSPHRASE_INVALID", "the remote gpg passphrase reference was not a bounded temporary path");
  try {
    const remoteArgs = ["--batch", "--yes", "--pinentry-mode", "loopback", "--passphrase-file", remotePath, mode === "encrypt" ? "--symmetric" : "--decrypt", "--output", "-"];
    const result = await runCommand("ssh", ["-o", "BatchMode=yes", host, "gpg", ...remoteArgs], { input: payload, timeoutMs: 120_000 });
    await writeFile(outputPath, result.stdout, { mode: 0o600 });
    return { method: "gpg-ssh", command: "gpg", host };
  } finally {
    await runCommand("ssh", ["-o", "BatchMode=yes", host, "rm", "-f", remotePath], { timeoutMs: 30_000 }).catch(() => undefined);
  }
}

export async function encryptSnapshot(snapshotPath, options = {}) {
  const tempRoot = options.tempRoot ?? await mkdtemp(join(tmpdir(), "tcrn-platform-chain-encrypted-"));
  const encryptedPath = join(tempRoot, `${basename(snapshotPath)}.gpg`);
  const method = await gpgTransform(snapshotPath, encryptedPath, "encrypt", options);
  return { encryptedPath, method, ownsTempRoot: options.tempRoot === undefined, tempRoot };
}

async function pushOffsite(encryptedPath, options = {}) {
  const host = options.offsiteHost ?? process.env.TCRN_BACKUP_OFFSITE_HOST;
  const directory = options.offsiteDirectory ?? process.env.TCRN_BACKUP_OFFSITE_DIR;
  if (!host || !directory) throw failure("BACKUP_OFFSITE_CONFIG_REQUIRED", "offsite host and pure-file directory references are required");
  const remotePath = `${host}:${directory.replace(/\/$/u, "")}/${basename(encryptedPath)}`;
  await runCommand("scp", ["-q", "-o", "BatchMode=yes", encryptedPath, remotePath], { timeoutMs: 120_000 });
  return { host, directory, remotePath };
}

async function verifyOffsite(encryptedPath, snapshotPath, options = {}) {
  const host = options.offsiteHost ?? process.env.TCRN_BACKUP_OFFSITE_HOST;
  const directory = options.offsiteDirectory ?? process.env.TCRN_BACKUP_OFFSITE_DIR;
  if (!host || !directory) throw failure("BACKUP_OFFSITE_CONFIG_REQUIRED", "offsite host and pure-file directory references are required");
  const tempRoot = await mkdtemp(join(tmpdir(), "tcrn-platform-chain-readback-"));
  const downloaded = join(tempRoot, basename(encryptedPath));
  const decrypted = join(tempRoot, "readback.tar.gz");
  try {
    await runCommand("scp", ["-q", "-o", "BatchMode=yes", `${host}:${directory.replace(/\/$/u, "")}/${basename(encryptedPath)}`, downloaded], { timeoutMs: 120_000 });
    await gpgTransform(downloaded, decrypted, "decrypt", options);
    const expected = await fileSha256(snapshotPath);
    const actual = await fileSha256(decrypted);
    if (expected !== actual) throw failure("BACKUP_OFFSITE_READBACK_MISMATCH", "offsite decrypted bytes differ from the local snapshot", { expected, actual });
    return { verified: true, snapshotSha256: actual };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

export async function runBackup(platformRoot, options = {}) {
  const archiveRoot = resolve(options.archiveRoot ?? join(resolve(platformRoot), ".tcrn-artifacts", "chain-snapshots"));
  if (options.ifDue && !(await isSnapshotDue(archiveRoot))) return { ok: true, reasonCode: "CHAIN_SNAPSHOT_NOT_DUE", archiveRoot };
  const snapshot = await createSnapshot(platformRoot, options);
  let encrypted;
  try {
    encrypted = await encryptSnapshot(snapshot.snapshotPath, options);
    const push = await pushOffsite(encrypted.encryptedPath, options);
    const readback = await verifyOffsite(encrypted.encryptedPath, snapshot.snapshotPath, options);
    const offsiteReceipt = {
      schemaVersion: OFFSITE_SCHEMA,
      ok: true,
      pushedAt: new Date().toISOString(),
      snapshotFile: snapshot.manifest.snapshotFile,
      snapshotSha256: snapshot.manifest.snapshotSha256,
      encryptedFile: basename(encrypted.encryptedPath),
      encryptedSha256: await fileSha256(encrypted.encryptedPath),
      encryption: encrypted.method,
      remote: push.remotePath,
      readbackVerified: readback.verified,
      readbackSha256: readback.snapshotSha256,
    };
    await writeJson(join(snapshot.archiveRoot, "offsite-push.json"), offsiteReceipt);
    return { ok: true, reasonCode: "CHAIN_SNAPSHOT_AND_OFFSITE_VERIFIED", snapshot: snapshot.receipt, offsite: offsiteReceipt };
  } catch (error) {
    const receipt = {
      schemaVersion: OFFSITE_SCHEMA,
      ok: false,
      pushedAt: new Date().toISOString(),
      snapshotFile: snapshot.manifest.snapshotFile,
      snapshotSha256: snapshot.manifest.snapshotSha256,
      readbackVerified: false,
      reasonCode: error?.reasonCode ?? "BACKUP_OFFSITE_FAILED",
    };
    await writeJson(join(snapshot.archiveRoot, "offsite-push.json"), receipt);
    throw error;
  } finally {
    if (encrypted?.ownsTempRoot) await rm(encrypted.tempRoot, { recursive: true, force: true });
  }
}

function argumentValue(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0 || !argv[index + 1] || argv[index + 1].startsWith("--")) return null;
  return argv[index + 1];
}

export function parseArguments(argv) {
  const platformRoot = argumentValue(argv, "--platform-root");
  const known = new Set(["--platform-root", "--if-due"]);
  if (argv.some((argument, index) => argument.startsWith("--") && !known.has(argument) || argument === "--platform-root" && (!argv[index + 1] || argv[index + 1].startsWith("--")))) throw failure("BACKUP_ARGUMENT_INVALID", "only --platform-root and --if-due are accepted");
  if (!platformRoot) throw failure("PLATFORM_ROOT_REQUIRED", "--platform-root is required");
  return { platformRoot, ifDue: argv.includes("--if-due") };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArguments(process.argv.slice(2));
    const result = await runBackup(args.platformRoot, { ifDue: args.ifDue });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, reasonCode: error?.reasonCode ?? "BACKUP_FAILED", error: error?.message ?? String(error) })}\n`);
    process.exitCode = 1;
  }
}
