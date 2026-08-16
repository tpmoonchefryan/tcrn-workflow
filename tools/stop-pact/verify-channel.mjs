#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// INC-105 — stop-pact in-position gate.
//
// A stop decider passing pure tests is not evidence that a host has registered it.
// This gate reads the actual project Stop registration, starts that exact command,
// feeds it a bounded scratch pact/transcript, and checks the host decision object.
// It also rejects an active pact that has expired without being migrated. The gate
// never installs or edits settings; absent registration is a named red result.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { buildPact } from "./pact.mjs";

const PROJECT_SETTINGS_FILES = [".claude/settings.json", ".claude/settings.local.json"];
const REGISTRATION_MARKER = "stop-pact/hook.mjs";
const PROJECT_DIR_PLACEHOLDERS = ["${CLAUDE_PROJECT_DIR}", "$CLAUDE_PROJECT_DIR"];

function substituteProjectDir(value, projectDir) {
  return PROJECT_DIR_PLACEHOLDERS.reduce((text, token) => text.split(token).join(projectDir), String(value));
}

function parseSettings(projectDir) {
  const root = resolve(projectDir);
  const present = [];
  for (const relative of PROJECT_SETTINGS_FILES) {
    const path = join(root, relative);
    if (!existsSync(path)) continue;
    try {
      present.push({ path, settings: JSON.parse(readFileSync(path, "utf8")) });
    } catch (error) {
      return { ok: false, projectDir: root, settingsPath: path, reason: "STOP_PACT_SETTINGS_UNPARSABLE", detail: error?.message ?? String(error) };
    }
  }
  if (present.length === 0) {
    return { ok: false, projectDir: root, settingsPath: join(root, PROJECT_SETTINGS_FILES[0]), reason: "STOP_PACT_SETTINGS_MISSING", detail: `no project settings under ${root}` };
  }
  for (const { path, settings } of present) {
    const groups = Array.isArray(settings?.hooks?.Stop) ? settings.hooks.Stop : [];
    for (const group of groups) {
      for (const entry of Array.isArray(group?.hooks) ? group.hooks : []) {
        if (entry?.type !== "command" || typeof entry.command !== "string") continue;
        const command = substituteProjectDir(entry.command, root);
        const args = Array.isArray(entry.args) ? entry.args.map((arg) => substituteProjectDir(arg, root)) : null;
        const whole = [command, ...(args ?? [])].join(" ");
        if (!whole.includes(REGISTRATION_MARKER)) continue;
        return {
          ok: true,
          projectDir: root,
          settingsPath: path,
          form: args === null ? "shell" : "exec",
          command,
          args,
          registeredCommand: entry.command,
        };
      }
    }
  }
  return {
    ok: false,
    projectDir: root,
    settingsPath: present[0].path,
    reason: "STOP_PACT_HOOK_NOT_REGISTERED",
    detail: `no Stop hook names ${REGISTRATION_MARKER}`,
  };
}

/**
 * Ancestors of `startDir` that could hold the harness, nearest first.
 *
 * TCRN-CROSS-INC-218. This gate used to be handed two fixed directories — the repository
 * and its parent — and on 2026-08-16 the platform ruled that harness is built at the
 * chosen workspace root and nowhere else, archiving the project-local registrations. The
 * fixed pair then named two places the harness is not: the classification folder never
 * had settings, and the repository's own copy was archived. So the gate read red while
 * the channel was live, which is the same as reading nothing.
 *
 * The walk stops at the home directory rather than the filesystem root, because
 * `~/.claude/settings.json` is the USER settings layer, not a workspace root. It may
 * legitimately register this same hook; counting it as a workspace registration would
 * make the gate answer a question nobody asked.
 */
export function harnessSearchRoots(startDir, stopAt = homedir()) {
  const boundary = resolve(stopAt);
  const roots = [];
  let current = resolve(startDir);
  for (;;) {
    roots.push(current);
    if (current === boundary) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return roots;
}

/**
 * The nearest ancestor whose project settings register the stop-pact Stop hook.
 *
 * Nearest wins: a workspace root closer to the repository is the one a session opened
 * there would actually read.
 */
export function discoverStopPactRegistration(startDir, stopAt = homedir(), parse = parseSettings) {
  const searched = harnessSearchRoots(startDir, stopAt);
  const considered = [];
  for (const root of searched) {
    const registration = parse(root);
    if (registration.ok) return { found: true, registration, searched, considered };
    // A directory with no settings at all is not a finding — most ancestors have none.
    if (registration.reason !== "STOP_PACT_SETTINGS_MISSING") considered.push(registration);
  }
  return { found: false, registration: null, searched, considered };
}

function activePactProblem(path = process.env.TCRN_STOP_PACT_PATH ?? join(homedir(), ".claude/stop-pact/current.json")) {
  if (!existsSync(path)) return null;
  let pact;
  try {
    pact = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { reason: "STOP_PACT_FILE_UNREADABLE", detail: `${path}: ${error?.message ?? error}`, path };
  }
  if (pact?.active === true && typeof pact.expiresAt === "string" && !Number.isNaN(Date.parse(pact.expiresAt))
    && Date.now() >= Date.parse(pact.expiresAt)) {
    return { reason: "STOP_PACT_ACTIVE_EXPIRED", detail: `active pact expired at ${pact.expiresAt} without migration`, path };
  }
  return null;
}

function probeRegistration(registration) {
  const scratch = mkdtempSync(join(tmpdir(), "stop-pact-channel-"));
  const pactPath = join(scratch, "pact.json");
  const transcriptPath = join(scratch, "transcript.jsonl");
  const now = new Date().toISOString();
  writeFileSync(pactPath, `${JSON.stringify(buildPact({
    scope: "stop-pact channel probe",
    authorizedBy: "agent:stop-pact-channel-gate",
    now,
    ttlMs: 60 * 60 * 1000,
    boundSession: "stop-pact-channel-probe",
  }))}\n`);
  writeFileSync(transcriptPath, `${JSON.stringify({ type: "assistant", message: { model: "gpt-5-codex" } })}\n${JSON.stringify({ type: "tool_use", name: "probe" })}\n`);
  const input = JSON.stringify({
    hook_event_name: "Stop",
    session_id: "stop-pact-channel-probe",
    transcript_path: transcriptPath,
    stop_hook_active: false,
  });
  let run;
  try {
    const options = {
      input,
      encoding: "utf8",
      cwd: scratch,
      env: { ...process.env, TCRN_STOP_PACT_PATH: pactPath, TCRN_STOP_PACT_NO_NOTIFY: "1", CLAUDE_PROJECT_DIR: registration.projectDir },
    };
    run = registration.form === "exec"
      ? spawnSync(registration.command, registration.args, options)
      : spawnSync(registration.command, { ...options, shell: true });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (run.error) return { ok: false, reason: "STOP_PACT_HOOK_LAUNCH_FAILED", detail: run.error.message };
  if (run.status !== 0) return { ok: false, reason: "STOP_PACT_HOOK_LAUNCH_FAILED", detail: `exit=${run.status} stderr=${(run.stderr ?? "").trim()}` };
  let response;
  try { response = JSON.parse((run.stdout ?? "").trim()); } catch { response = null; }
  if (response?.decision !== "block" || typeof response.reason !== "string" || response.reason.trim().length === 0) {
    return { ok: false, reason: "STOP_PACT_DECISION_PROTOCOL_INVALID", detail: `expected non-empty block decision, got ${run.stdout ?? ""}` };
  }
  return { ok: true, response: { decision: response.decision, reasonBytes: response.reason.length } };
}

export function verifyStopPactChannel({ projectDirs = [], pactPath, discoverFrom, stopAt } = {}) {
  const pactProblem = activePactProblem(pactPath);
  if (pactProblem) return { ok: false, reason: pactProblem.reason, detail: pactProblem.detail, pactPath: pactProblem.path, roots: [] };
  if (discoverFrom !== undefined) {
    const discovery = discoverStopPactRegistration(discoverFrom, stopAt ?? homedir());
    if (!discovery.found) {
      return {
        ok: false,
        status: "STOP_PACT_CHANNEL_SEVERED",
        reason: "STOP_PACT_HOOK_NOT_REGISTERED",
        detail: `no ancestor of ${resolve(discoverFrom)} up to ${resolve(stopAt ?? homedir())} names ${REGISTRATION_MARKER}`,
        searched: discovery.searched,
        roots: discovery.considered,
      };
    }
    const probe = probeRegistration(discovery.registration);
    const root = { ...discovery.registration, ...probe };
    return {
      ok: root.ok === true,
      status: root.ok === true ? "STOP_PACT_CHANNEL_LIVE" : "STOP_PACT_CHANNEL_SEVERED",
      discoveredAt: discovery.registration.projectDir,
      searched: discovery.searched,
      roots: [root],
      reason: root.ok === true ? null : root.reason ?? null,
      detail: root.ok === true ? null : root.detail ?? null,
    };
  }
  if (!Array.isArray(projectDirs) || projectDirs.length === 0) {
    return { ok: false, reason: "STOP_PACT_PROJECT_DIR_REQUIRED", detail: "pass at least one --project-dir", roots: [] };
  }
  const roots = projectDirs.map((projectDir) => {
    const registration = parseSettings(projectDir);
    if (!registration.ok) return { ...registration, ok: false };
    const probe = probeRegistration(registration);
    return { ...registration, ...probe };
  });
  const failed = roots.find((root) => !root.ok);
  return {
    ok: failed === undefined,
    status: failed === undefined ? "STOP_PACT_CHANNEL_LIVE" : "STOP_PACT_CHANNEL_SEVERED",
    roots,
    reason: failed?.reason ?? null,
    detail: failed?.detail ?? null,
  };
}

function usage() {
  process.stderr.write("usage: verify-channel.mjs --verify-channel (--discover-from <dir> | --project-dir <dir> [--project-dir <dir> ...])\n");
  process.exitCode = 64;
}

if (process.argv[1]?.endsWith("verify-channel.mjs")) {
  if (process.argv[2] !== "--verify-channel") {
    usage();
  } else {
    const projectDirs = [];
    let discoverFrom;
    let malformed = false;
    for (let index = 3; index < process.argv.length; index += 2) {
      const flag = process.argv[index];
      const value = process.argv[index + 1];
      if (value === undefined || (flag !== "--project-dir" && flag !== "--discover-from")) {
        usage();
        malformed = true;
        break;
      }
      if (flag === "--discover-from") discoverFrom = value;
      else projectDirs.push(value);
    }
    if (!malformed && (discoverFrom !== undefined || projectDirs.length > 0)) {
      const result = verifyStopPactChannel(
        discoverFrom !== undefined ? { discoverFrom } : { projectDirs },
      );
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (!result.ok) process.exitCode = 1;
    } else if (!malformed) {
      usage();
    }
  }
}
