#!/usr/bin/env node
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
import { join, resolve } from "node:path";

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

export function verifyStopPactChannel({ projectDirs = [], pactPath } = {}) {
  const pactProblem = activePactProblem(pactPath);
  if (pactProblem) return { ok: false, reason: pactProblem.reason, detail: pactProblem.detail, pactPath: pactProblem.path, roots: [] };
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
  process.stderr.write("usage: verify-channel.mjs --verify-channel --project-dir <dir> [--project-dir <dir> ...]\n");
  process.exitCode = 64;
}

if (process.argv[1]?.endsWith("verify-channel.mjs")) {
  if (process.argv[2] !== "--verify-channel") {
    usage();
  } else {
    const projectDirs = [];
    for (let index = 3; index < process.argv.length; index += 2) {
      if (process.argv[index] !== "--project-dir" || process.argv[index + 1] === undefined) {
        usage();
        break;
      }
      projectDirs.push(process.argv[index + 1]);
    }
    if (projectDirs.length > 0) {
      const result = verifyStopPactChannel({ projectDirs });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (!result.ok) process.exitCode = 1;
    }
  }
}
