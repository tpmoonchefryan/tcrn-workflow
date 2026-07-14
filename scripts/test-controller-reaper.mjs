// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { basename, resolve } from "node:path";

const [parentPidText, processGroupText, outputDirectory] = process.argv.slice(2);
const parentPid = Number(parentPidText);
const processGroup = Number(processGroupText);

if (!Number.isSafeInteger(parentPid) || parentPid <= 0 || !Number.isSafeInteger(processGroup) || processGroup <= 0 ||
    typeof outputDirectory !== "string" || !outputDirectory.startsWith("/") || !basename(outputDirectory).startsWith("tcrn-test-controller-")) {
  process.exit(1);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function parentAlive() {
  try {
    process.kill(parentPid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function groupMembers() {
  const listed = spawnSync("/bin/ps", ["-axo", "pid=,pgid="], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
  if (listed.status !== 0 || listed.error || (listed.stderr ?? "").trim() !== "") throw new Error("TEST_CONTROLLER_REAPER_PROCESS_LIST_FAILED");
  const members = [];
  for (const line of listed.stdout.split("\n")) {
    if (line.trim() === "") continue;
    const match = line.trim().match(/^(\d+)\s+(\d+)$/u);
    if (!match) throw new Error("TEST_CONTROLLER_REAPER_PROCESS_LIST_INVALID");
    if (Number(match[2]) === processGroup && Number(match[1]) !== parentPid) members.push(Number(match[1]));
  }
  return members;
}

function signal(pids, signal) {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
}

async function removeOutputDirectory() {
  const path = resolve(outputDirectory);
  if (basename(path) !== basename(outputDirectory) || !basename(path).startsWith("tcrn-test-controller-")) {
    throw new Error("TEST_CONTROLLER_REAPER_OUTPUT_PATH_INVALID");
  }
  await rm(path, { recursive: true, force: true });
}

let groupClean = false;
async function terminateGroup() {
  if (groupClean) return;
  let members = groupMembers();
  signal(members, "SIGTERM");
  for (let elapsed = 0; elapsed < 1_000; elapsed += 20) {
    await delay(20);
    members = groupMembers();
    if (members.length === 0) {
      process.send?.({ type: "clean" });
      groupClean = true;
      return;
    }
  }
  signal(members, "SIGKILL");
  for (let elapsed = 0; elapsed < 1_000; elapsed += 20) {
    await delay(20);
    members = groupMembers();
    if (members.length === 0) {
      process.send?.({ type: "clean" });
      groupClean = true;
      return;
    }
  }
  throw new Error("TEST_CONTROLLER_REAPER_GROUP_LIVE");
}

process.on("message", (message) => {
  if (message?.type === "cleanup") terminateGroup().catch((error) => {
    process.send?.({ type: "error", code: error?.message ?? "TEST_CONTROLLER_REAPER_FAILED" });
    process.exit(1);
  });
  if (message?.type === "dispose") removeOutputDirectory().then(() => process.exit(0)).catch(() => process.exit(1));
});

process.send?.({ type: "ready" });
setInterval(() => {
  if (!parentAlive()) terminateGroup().then(removeOutputDirectory).then(() => process.exit(0)).catch(() => process.exit(1));
}, 20).unref();
