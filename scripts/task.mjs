#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { dirname, extname, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import {
  fileRecord,
  repositoryRoot,
  readJson,
  toPosixPath,
  walkFiles,
} from "./lib/files.mjs";

const command = process.argv[2];
const textExtensions = new Set([".json", ".md", ".mjs", ".ts", ".yaml", ".yml"]);
const textNames = new Set([
  ".editorconfig",
  ".gitattributes",
  ".gitignore",
  ".node-version",
  ".npmrc",
  "LICENSE",
  "NOTICE",
]);

function assertion(condition, code, detail = "") {
  if (!condition) {
    throw new Error(`${code}${detail ? `:${detail}` : ""}`);
  }
}

function run(executable, arguments_, options = {}) {
  const result = spawnSync(executable, arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `COMMAND_FAILED:${executable} ${arguments_.join(" ")}\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

async function sourcePolicy() {
  return readJson(resolve(repositoryRoot, "scripts/policy/source-allowlist.json"));
}

function allowedByPolicy(path, policy) {
  return policy.allowedFiles.includes(path) || policy.allowedPrefixes.some((prefix) => path.startsWith(prefix));
}

async function sourceRecords() {
  const files = await walkFiles();
  return Promise.all(files.map((path) => fileRecord(path)));
}

async function verifyRuntime() {
  assertion(process.version === "v24.16.0", "RUNTIME_NODE_VERSION", process.version);
  const userAgent = process.env.npm_config_user_agent ?? "";
  assertion(userAgent.startsWith("pnpm/11.3.0 "), "RUNTIME_PNPM_VERSION", userAgent || "missing");
  return { node: process.version, pnpm: "11.3.0" };
}

async function formatCheck({ write = false } = {}) {
  const files = await walkFiles();
  const findings = [];
  for (const path of files) {
    const name = toPosixPath(relative(repositoryRoot, path));
    if (!textExtensions.has(extname(path)) && !textNames.has(name)) {
      continue;
    }
    const original = await readFile(path, "utf8");
    let normalized = original.replace(/\r\n?/g, "\n");
    if (!name.endsWith(".md")) {
      normalized = normalized
        .split("\n")
        .map((line) => line.replace(/[ \t]+$/u, ""))
        .join("\n");
    }
    normalized = `${normalized.replace(/\n*$/u, "")}\n`;
    if (name.endsWith(".json")) {
      normalized = `${JSON.stringify(JSON.parse(normalized), null, 2)}\n`;
    }
    if (normalized !== original) {
      if (write) {
        await writeFile(path, normalized);
      } else {
        findings.push(name);
      }
    }
  }
  assertion(findings.length === 0, "FORMAT_MISMATCH", findings.join(","));
  return { checked: files.length, rewritten: write };
}

async function lint() {
  const files = await walkFiles();
  const moduleFiles = files.filter((path) => path.endsWith(".mjs"));
  for (const path of moduleFiles) {
    run(process.execPath, ["--check", path]);
  }
  for (const path of files.filter((candidate) => candidate.endsWith(".ts"))) {
    const content = await readFile(path, "utf8");
    assertion(!/\bany\b/u.test(content), "LINT_EXPLICIT_ANY", toPosixPath(relative(repositoryRoot, path)));
    assertion(!content.includes("@ts-ignore"), "LINT_TS_IGNORE", toPosixPath(relative(repositoryRoot, path)));
    assertion(!/\beval\s*\(/u.test(content), "LINT_EVAL", toPosixPath(relative(repositoryRoot, path)));
  }
  for (const path of files.filter((candidate) => candidate.includes("/.github/workflows/") && candidate.endsWith(".yml"))) {
    const content = await readFile(path, "utf8");
    assertion(!content.includes("pull_request_target"), "CI_PULL_REQUEST_TARGET_FORBIDDEN");
    for (const line of content.split("\n").filter((value) => value.trim().startsWith("uses:"))) {
      assertion(/uses:\s+[^@\s]+@[a-f0-9]{40}(?:\s+#.*)?$/u.test(line.trim()), "CI_ACTION_NOT_PINNED", line.trim());
    }
  }
  return { modules: moduleFiles.length };
}

async function typecheck() {
  await verifyRuntime();
  const files = (await walkFiles()).filter((path) => path.endsWith(".ts"));
  for (const path of files) {
    const content = await readFile(path, "utf8");
    stripTypeScriptTypes(content, { mode: "transform", sourceMap: false });
    assertion(!/function\s+\w+\s*\([^)]*\)\s*\{/u.test(content), "TYPECHECK_RETURN_TYPE_REQUIRED", toPosixPath(relative(repositoryRoot, path)));
  }
  return { files: files.length, engine: "node-strip-types-and-p1-contracts" };
}

async function build() {
  const checked = await typecheck();
  const outputRoot = resolve(repositoryRoot, "dist/build");
  await rm(outputRoot, { recursive: true, force: true });
  const files = (await walkFiles()).filter((path) => path.endsWith(".ts"));
  for (const path of files) {
    const source = await readFile(path, "utf8");
    const output = stripTypeScriptTypes(source, { mode: "transform", sourceMap: false });
    const target = resolve(outputRoot, relative(repositoryRoot, path)).replace(/\.ts$/u, ".js");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${output.replace(/\n*$/u, "")}\n`);
  }
  return { files: files.length, engine: checked.engine, output: "dist/build" };
}

async function runTests({ trustOnly = false } = {}) {
  await build();
  const tests = (await walkFiles())
    .map((path) => toPosixPath(relative(repositoryRoot, path)))
    .filter((path) => path.startsWith("tests/") && path.endsWith(".test.mjs"))
    .filter((path) => !trustOnly || path === "tests/release-trust.test.mjs");
  run(process.execPath, ["--test", ...tests]);
  return { trustOnly, tests, result: "passed" };
}

function octal(value, length) {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

function writeTarField(header, offset, length, value) {
  Buffer.from(value, "utf8").copy(header, offset, 0, length);
}

function tarEntry(name, content, mode) {
  const nameBytes = Buffer.byteLength(name);
  assertion(nameBytes <= 100, "ARCHIVE_PATH_TOO_LONG", name);
  const header = Buffer.alloc(512, 0);
  writeTarField(header, 0, 100, name);
  writeTarField(header, 100, 8, octal(mode, 8));
  writeTarField(header, 108, 8, octal(0, 8));
  writeTarField(header, 116, 8, octal(0, 8));
  writeTarField(header, 124, 12, octal(content.length, 12));
  writeTarField(header, 136, 12, octal(0, 12));
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeTarField(header, 257, 6, "ustar\0");
  writeTarField(header, 263, 2, "00");
  writeTarField(header, 265, 32, "root");
  writeTarField(header, 297, 32, "root");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeTarField(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512, 0);
  return Buffer.concat([header, content, padding]);
}

async function archive() {
  await verifySource();
  const records = await sourceRecords();
  records.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const entries = [];
  for (const record of records) {
    const content = await readFile(resolve(repositoryRoot, record.path));
    const executable = content.subarray(0, 2).toString("utf8") === "#!";
    entries.push(tarEntry(record.path, content, executable ? 0o755 : 0o644));
  }
  entries.push(Buffer.alloc(1024, 0));
  const output = Buffer.concat(entries);
  const outputPath = resolve(repositoryRoot, "dist/source/tcrn-workflow-source.tar");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, output);
  return {
    path: toPosixPath(relative(repositoryRoot, outputPath)),
    sha256: createHash("sha256").update(output).digest("hex"),
    files: records.length,
  };
}

async function sbom() {
  const packageJson = await readJson(resolve(repositoryRoot, "package.json"));
  const policy = await readJson(resolve(repositoryRoot, "scripts/policy/dependency-policy.json"));
  const lockContent = await readFile(resolve(repositoryRoot, "pnpm-lock.yaml"));
  const packageContent = await readFile(resolve(repositoryRoot, "package.json"));
  const basis = createHash("sha256").update(packageContent).update(lockContent).digest("hex");
  const components = Object.entries(packageJson.devDependencies ?? {}).map(([name, version]) => {
    const approved = policy.dependencies[`${name}@${version}`];
    assertion(approved, "SBOM_DEPENDENCY_NOT_APPROVED", `${name}@${version}`);
    return {
      type: "library",
      name,
      version,
      scope: "optional",
      licenses: [{ license: { id: approved.license } }],
      purl: `pkg:npm/${encodeURIComponent(name)}@${version}`,
    };
  });
  const document = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber: `urn:uuid:${basis.slice(0, 8)}-${basis.slice(8, 12)}-4${basis.slice(13, 16)}-a${basis.slice(17, 20)}-${basis.slice(20, 32)}`,
    version: 1,
    metadata: {
      component: {
        type: "application",
        name: packageJson.name,
        version: packageJson.version,
      },
      properties: [{ name: "tcrn:deterministic-basis-sha256", value: basis }],
    },
    components,
  };
  const outputPath = resolve(repositoryRoot, "dist/sbom/sbom.cdx.json");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`);
  return { path: toPosixPath(relative(repositoryRoot, outputPath)), components: components.length, basis };
}

async function verifyLicenses() {
  const license = await readFile(resolve(repositoryRoot, "LICENSE"), "utf8");
  const notice = await readFile(resolve(repositoryRoot, "NOTICE"), "utf8");
  assertion(license.includes("Apache License") && license.includes("Version 2.0"), "LICENSE_APACHE_REQUIRED");
  assertion(notice.includes("Apache-2.0"), "NOTICE_SPDX_REQUIRED");
  const files = await walkFiles();
  const sourceFiles = files.filter((path) => [".mjs", ".ts"].includes(extname(path)));
  const missing = [];
  for (const path of sourceFiles) {
    const content = await readFile(path, "utf8");
    if (!content.split("\n").slice(0, 4).some((line) => line.includes("SPDX-License-Identifier: Apache-2.0"))) {
      missing.push(toPosixPath(relative(repositoryRoot, path)));
    }
  }
  assertion(missing.length === 0, "SPDX_HEADER_MISSING", missing.join(","));
  return { sourceFiles: sourceFiles.length };
}

async function verifyVulnerabilities() {
  const packageJson = await readJson(resolve(repositoryRoot, "package.json"));
  const policy = await readJson(resolve(repositoryRoot, "scripts/policy/vulnerability-policy.json"));
  const snapshot = Date.parse(`${policy.snapshotDate}T00:00:00.000Z`);
  const ageDays = Math.floor((Date.now() - snapshot) / 86_400_000);
  assertion(ageDays >= 0 && ageDays <= policy.maxAgeDays, "VULNERABILITY_POLICY_STALE", String(ageDays));
  for (const vulnerability of policy.knownVulnerabilities) {
    const version = packageJson.dependencies?.[vulnerability.package] ?? packageJson.devDependencies?.[vulnerability.package];
    assertion(version !== vulnerability.version, "VULNERABLE_DEPENDENCY", `${vulnerability.package}@${version}`);
  }
  return { disposition: policy.disposition, snapshotDate: policy.snapshotDate, ageDays };
}

async function remoteOwner() {
  const remote = run("git", ["remote", "get-url", "origin"]);
  const match = remote.match(/github\.com[/:]([^/]+)\/tcrn-workflow(?:\.git)?$/u);
  assertion(match, "PRIVACY_ORIGIN_UNEXPECTED");
  return match[1];
}

async function verifyPrivacy() {
  const owner = await remoteOwner();
  const legacyName = ["TCRN", "Workflow", "Platform", "Legacy"].join("-");
  const controlDirectory = [".", "context", "/"].join("");
  const agentDirectory = [".", "llm", "/"].join("");
  const privateKeyMarker = ["BEGIN", " PRIVATE KEY"].join("");
  const patterns = [
    ["LOCAL_ABSOLUTE_PATH", new RegExp(["/", "Users", "/[^/\\s]+/"].join(""), "u")],
    ["WINDOWS_USER_PATH", /[A-Za-z]:\\\\Users\\\\/u],
    ["THREAD_IDENTIFIER", /019[a-f0-9]{5}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/u],
    ["PRIVATE_KEY", new RegExp(privateKeyMarker, "u")],
    ["GITHUB_TOKEN", /gh[pousr]_[A-Za-z0-9_]{20,}/u],
    ["AWS_ACCESS_KEY", /AKIA[0-9A-Z]{16}/u],
    ["CONTROL_PLANE_PATH", new RegExp(controlDirectory.replace(".", "\\."), "u")],
    ["AGENT_CONTROL_PATH", new RegExp(agentDirectory.replace(".", "\\."), "u")],
    ["LEGACY_REMOTE_NAME", new RegExp(legacyName, "u")],
    ["PRIVATE_RUNTIME_PATH", new RegExp(["/", "srv", "/"].join(""), "u")],
    ["PRIVATE_SSH_URL", /ssh:\/\//u],
  ];
  if (owner) {
    patterns.push(["OWNER_PRIVATE_IDENTIFIER", new RegExp(owner.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u")]);
  }
  const findings = [];
  const scanned = (await walkFiles()).map((path) => ({
    label: toPosixPath(relative(repositoryRoot, path)),
    path,
  }));
  const archivePath = resolve(repositoryRoot, "dist/source/tcrn-workflow-source.tar");
  if (await stat(archivePath).then(() => true).catch(() => false)) {
    scanned.push({ label: "dist/source/tcrn-workflow-source.tar", path: archivePath });
  }
  const headProbe = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  const historicalContent = [];
  if (headProbe.status === 0) {
    const objectLines = run("git", ["rev-list", "--objects", "--all"]).split("\n").filter(Boolean);
    for (const line of objectLines) {
      const [object, ...pathParts] = line.split(" ");
      if (run("git", ["cat-file", "-t", object]) === "blob") {
        historicalContent.push({
          label: `git:${object}:${pathParts.join(" ")}`,
          content: run("git", ["cat-file", "blob", object]),
          kind: "blob",
        });
      }
    }
    for (const commit of run("git", ["rev-list", "--all"]).split("\n").filter(Boolean)) {
      historicalContent.push({
        label: `git-commit:${commit}`,
        content: run("git", ["cat-file", "commit", commit]),
        kind: "commit",
      });
    }
  }
  const contentEntries = await Promise.all(
    scanned.map(async (entry) => ({
      label: entry.label,
      content: await readFile(entry.path, "utf8").catch(() => ""),
      kind: "source",
    })),
  );
  contentEntries.push(...historicalContent);
  for (const entry of contentEntries) {
    for (const [code, pattern] of patterns) {
      if (entry.kind === "commit" && code === "OWNER_PRIVATE_IDENTIFIER") {
        continue;
      }
      if (pattern.test(entry.content)) {
        findings.push(`${code}:${entry.label}`);
      }
    }
  }
  assertion(findings.length === 0, "PRIVACY_FINDINGS", findings.join(","));
  return {
    scannedFiles: scanned.length,
    historicalObjects: historicalContent.length,
    archiveScanned: scanned.some((entry) => entry.path === archivePath),
    patterns: patterns.length,
  };
}

async function verifySource() {
  const policy = await sourcePolicy();
  const records = await sourceRecords();
  const denied = records.map((record) => record.path).filter((path) => !allowedByPolicy(path, policy));
  assertion(denied.length === 0, "SOURCE_NOT_ALLOWLISTED", denied.join(","));
  return { files: records.length };
}

async function verifyLifecycle() {
  const manifests = (await walkFiles()).filter((path) => path.endsWith("package.json"));
  const forbidden = new Set(["preinstall", "install", "postinstall", "prepare", "prepublish", "prepublishOnly"]);
  for (const path of manifests) {
    const manifest = await readJson(path);
    for (const script of Object.keys(manifest.scripts ?? {})) {
      assertion(!forbidden.has(script), "LIFECYCLE_SCRIPT_FORBIDDEN", `${path}:${script}`);
    }
    for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [name, version] of Object.entries(manifest[section] ?? {})) {
        assertion(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version), "DEPENDENCY_NOT_EXACT", `${name}@${version}`);
      }
    }
  }
  const npmrc = await readFile(resolve(repositoryRoot, ".npmrc"), "utf8");
  assertion(/^ignore-scripts=true$/mu.test(npmrc), "IGNORE_SCRIPTS_REQUIRED");
  assertion(/^offline=true$/mu.test(npmrc), "OFFLINE_DEFAULT_REQUIRED");
  return { manifests: manifests.length };
}

async function aggregateDigest(paths) {
  const records = await Promise.all(paths.map((path) => fileRecord(resolve(repositoryRoot, path))));
  records.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return createHash("sha256").update(JSON.stringify(records)).digest("hex");
}

async function verifyMap() {
  const map = JSON.parse(await readFile(resolve(repositoryRoot, "verification-map.yaml"), "utf8"));
  assertion(map.schemaVersion === "tcrn.verification-map.v1", "VERIFICATION_MAP_SCHEMA");
  assertion(Array.isArray(map.claims) && map.claims.length > 0, "VERIFICATION_MAP_EMPTY");
  const ids = new Set();
  const required = [
    "id",
    "phase",
    "status",
    "subject",
    "command",
    "fixturePaths",
    "fixtureDigest",
    "environment",
    "expectedExit",
    "expectedReasonCode",
    "evidencePath",
    "invalidationTriggers",
  ];
  for (const claim of map.claims) {
    assertion(required.every((field) => Object.hasOwn(claim, field)), "VERIFICATION_MAP_FIELDS", claim.id ?? "unknown");
    assertion(!ids.has(claim.id), "VERIFICATION_MAP_DUPLICATE", claim.id);
    ids.add(claim.id);
    assertion(["P1", "P2", "RC1"].includes(claim.phase), "VERIFICATION_MAP_PHASE", claim.id);
    assertion(["implemented", "planned"].includes(claim.status), "VERIFICATION_MAP_STATUS", claim.id);
    assertion(Array.isArray(claim.fixturePaths), "VERIFICATION_MAP_FIXTURES", claim.id);
    assertion(Array.isArray(claim.invalidationTriggers) && claim.invalidationTriggers.length > 0, "VERIFICATION_MAP_INVALIDATION", claim.id);
    if (claim.status === "implemented") {
      assertion(/^[a-f0-9]{64}$/u.test(claim.fixtureDigest), "VERIFICATION_MAP_DIGEST", claim.id);
      assertion(claim.fixtureDigest === await aggregateDigest(claim.fixturePaths), "VERIFICATION_MAP_DIGEST_MISMATCH", claim.id);
    } else {
      assertion(claim.fixtureDigest === null, "VERIFICATION_MAP_PLANNED_DIGEST", claim.id);
      assertion(claim.expectedReasonCode.endsWith("_OUT_OF_SCOPE"), "VERIFICATION_MAP_PLANNED_REASON", claim.id);
    }
  }
  for (const phase of ["P1", "P2", "RC1"]) {
    assertion(map.claims.some((claim) => claim.phase === phase), "VERIFICATION_MAP_PHASE_MISSING", phase);
  }
  return { claims: map.claims.length, implemented: map.claims.filter((claim) => claim.status === "implemented").length };
}

async function verifyHistory() {
  const remotes = run("git", ["remote"]).split("\n").filter(Boolean);
  assertion(remotes.length === 1 && remotes[0] === "origin", "HISTORY_REMOTE_SET", remotes.join(","));
  const remote = run("git", ["remote", "get-url", "--all", "origin"]).split("\n").filter(Boolean);
  assertion(remote.length === 1 && /^https:\/\/github\.com\/[^/]+\/tcrn-workflow\.git$/u.test(remote[0]), "HISTORY_ORIGIN", remote.join(","));
  const roots = run("git", ["rev-list", "--max-parents=0", "--all"]).split("\n").filter(Boolean);
  assertion(roots.length === 1, "HISTORY_ROOT_COUNT", String(roots.length));
  const rootLine = run("git", ["rev-list", "--parents", "-n", "1", roots[0]]).split(/\s+/u);
  assertion(rootLine.length === 1, "HISTORY_ROOT_HAS_PARENT");
  const refs = run("git", ["for-each-ref", "--format=%(refname)"]).split("\n").filter(Boolean);
  assertion(refs.every((ref) => !ref.startsWith("refs/replace/") && !ref.startsWith("refs/notes/")), "HISTORY_FORBIDDEN_REF", refs.join(","));
  assertion(!await stat(resolve(repositoryRoot, ".git/objects/info/alternates")).then(() => true).catch(() => false), "HISTORY_ALTERNATES");
  run("git", ["fsck", "--strict", "--no-reflogs", "--unreachable"]);
  const reachable = new Set(run("git", ["rev-list", "--objects", "--all"]).split("\n").filter(Boolean).map((line) => line.split(" ")[0]));
  const stored = new Set(run("git", ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"]).split("\n").filter(Boolean));
  const unreachable = [...stored].filter((object) => !reachable.has(object));
  assertion(unreachable.length === 0, "HISTORY_UNREACHABLE_OBJECTS", unreachable.join(","));
  const reflog = run("git", ["reflog", "show", "--all", "--format=%H"]).split("\n").filter(Boolean);
  assertion(reflog.every((object) => reachable.has(object)), "HISTORY_REFLOG_UNREACHABLE");
  return { rootCommit: roots[0], objects: stored.size, refs: refs.length, reflogEntries: reflog.length };
}

async function clean() {
  await rm(resolve(repositoryRoot, "dist"), { recursive: true, force: true });
  return { removed: "dist" };
}

const handlers = {
  archive,
  build,
  clean,
  "format-check": () => formatCheck(),
  "format-write": () => formatCheck({ write: true }),
  history: verifyHistory,
  licenses: verifyLicenses,
  lifecycle: verifyLifecycle,
  lint,
  privacy: verifyPrivacy,
  runtime: verifyRuntime,
  sbom,
  source: verifySource,
  test: () => runTests(),
  "test-trust": () => runTests({ trustOnly: true }),
  "verification-map": verifyMap,
  typecheck,
  vulnerabilities: verifyVulnerabilities,
};

try {
  assertion(command && handlers[command], "TASK_UNKNOWN", command ?? "missing");
  const result = await handlers[command]();
  const evidencePath = resolve(repositoryRoot, `dist/evidence/p1/${command}.json`);
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(
    evidencePath,
    `${JSON.stringify({ schemaVersion: "tcrn.p1-command-evidence.v1", command, result }, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify({ ok: true, command, ...result })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, command, error: error.message })}\n`);
  process.exitCode = 1;
}
