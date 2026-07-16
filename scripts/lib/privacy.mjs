// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import { compareCanonicalText } from "./canonical-order.mjs";

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

export function decodeGitMetadataBytes(content, reasonCode) {
  if (!Buffer.isBuffer(content) || typeof reasonCode !== "string" || reasonCode.length === 0) {
    throw new Error("GIT_METADATA_DECODE_INPUT_INVALID");
  }
  try {
    return strictUtf8.decode(content);
  } catch {
    throw new Error(reasonCode);
  }
}

export function decodePrivacyScanBytes(content) {
  if (!Buffer.isBuffer(content)) throw new Error("PRIVACY_SCAN_BYTES_REQUIRED");
  // Privacy patterns are textual and continue to scan the UTF-8 projection,
  // while byte-count and digest evidence retain the original Buffer below.
  return content.toString("utf8");
}

export function aggregatePrivacySurface(records) {
  const ordered = [...records].sort((left, right) => compareCanonicalText(left.path, right.path));
  const digest = createHash("sha256");
  let bytes = 0;
  for (const record of ordered) {
    const content = Buffer.isBuffer(record.content) ? record.content : Buffer.from(record.content, "utf8");
    bytes += content.length;
    digest.update(record.path, "utf8");
    digest.update("\0", "utf8");
    digest.update(String(content.length), "utf8");
    digest.update("\0", "utf8");
    digest.update(content);
  }
  return { entries: ordered.length, bytes, sha256: digest.digest("hex") };
}

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function privacyPatterns(owner) {
  const legacyName = ["TCRN", "Workflow", "Platform", "Legacy"].join("-");
  const controlDirectory = [".", "context", "/"].join("");
  const agentDirectory = [".", "llm", "/"].join("");
  const localUserPath = ["/", "Users", "/[^/\\s]+/"].join("");
  const linuxHomePath = ["/", "home", "/[^/\\s]+/"].join("");
  return [
    ["LOCAL_ABSOLUTE_PATH", new RegExp(localUserPath, "u")],
    ["LINUX_HOME_PATH", new RegExp(linuxHomePath, "u")],
    ["WINDOWS_USER_PATH", /[A-Za-z]:\\+Users\\+/u],
    ["THREAD_IDENTIFIER", /019[a-f0-9]{5}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/u],
    ["EMAIL_IDENTIFIER", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu],
    ["PRIVATE_KEY", /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/u],
    ["GITHUB_CLASSIC_TOKEN", /gh[pousr]_[A-Za-z0-9_]{20,}/u],
    ["GITHUB_FINE_GRAINED_TOKEN", /github_pat_[A-Za-z0-9_]{20,}/u],
    ["AWS_ACCESS_KEY", /(?:AKIA|ASIA)[0-9A-Z]{16}/u],
    ["NPM_TOKEN", /npm_[A-Za-z0-9]{36,}/u],
    ["SLACK_TOKEN", /xox[baprs]-[A-Za-z0-9-]{20,}/u],
    ["GOOGLE_API_KEY", /AIza[0-9A-Za-z_-]{35}/u],
    ["AZURE_STORAGE_KEY", /AccountKey=[A-Za-z0-9+/]{40,}={0,2}/u],
    ["JWT_TOKEN", /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/u],
    ["AUTHENTICATED_URL", /https?:\/\/[^\s/:@]+:[^\s/@]+@/iu],
    ["PRIVATE_IPV4", /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/u],
    ["US_SSN", /\b\d{3}-\d{2}-\d{4}\b/u],
    ["PHONE_IDENTIFIER", /\+?\d{1,3}[-. ]\d{3}[-. ]\d{3}[-. ]\d{4}\b/u],
    ["CUSTOMER_SOURCE_MARKER", /\b(?:customer|tenant)[-_ ](?:export|dump|backup)\b/iu],
    ["CONTROL_PLANE_PATH", new RegExp(controlDirectory.replace(".", "\\."), "u")],
    ["AGENT_CONTROL_PATH", new RegExp(agentDirectory.replace(".", "\\."), "u")],
    ["LEGACY_REMOTE_NAME", new RegExp(legacyName, "u")],
    ["PRIVATE_RUNTIME_PATH", new RegExp(["/", "srv", "/"].join(""), "u")],
    ["PRIVATE_SSH_URL", /ssh:\/\//u],
    ["OWNER_PRIVATE_IDENTIFIER", new RegExp(escaped(owner), "u")],
  ];
}

function sanitizeAllowedPublicMetadata(entry, owner) {
  const p3Marker = [".", "context/platform/workflow-v3-capabilities/p3-local-work-graph.accepted.json"].join("");
  const content = entry.content.split(p3Marker).join("[ALLOWED_PUBLIC_P3_MARKER_CONTRACT]");
  if (
    entry.kind === "remote" &&
    content === `https://github.com/${owner}/tcrn-workflow.git`
  ) {
    return "[ALLOWED_PUBLIC_GIT_REMOTE]";
  }
  if (entry.kind !== "commit" && entry.kind !== "tag") {
    return content;
  }
  return content
    .split("\n")
    .map((line) => {
      const match = line.match(/^(author|committer|tagger) ([^<>\r\n]+) <((?:\d+\+)?([A-Za-z0-9-]+)@users\.noreply\.github\.com)> \d+ [+-]\d{4}$/u);
      if (!match) {
        return line;
      }
      const [, role, name, , login] = match;
      if (name !== login) {
        return line;
      }
      return `${role} [ALLOWED_PUBLIC_GIT_HOSTING_IDENTITY]`;
    })
    .join("\n");
}

export function scanPrivacyEntries(entries, { owner }) {
  if (typeof owner !== "string" || owner.length === 0) {
    throw new Error("PRIVACY_OWNER_REQUIRED");
  }
  const patterns = privacyPatterns(owner);
  const findings = [];
  for (const entry of entries) {
    if (typeof entry.label !== "string" || typeof entry.kind !== "string" || typeof entry.content !== "string") {
      throw new Error("PRIVACY_ENTRY_INVALID");
    }
    const content = sanitizeAllowedPublicMetadata(entry, owner);
    for (const [reasonCode, pattern] of patterns) {
      if (pattern.test(content)) {
        findings.push(`${reasonCode}:${entry.kind}:${entry.label}`);
      }
    }
  }
  return findings;
}

export function parseHistoricalTreePaths(content) {
  if (content === "") {
    return [];
  }
  if (typeof content !== "string" || !content.endsWith("\0")) {
    throw new Error("PRIVACY_TREE_RECORD_INVALID");
  }
  return content
    .split("\0")
    .slice(0, -1)
    .map((record) => {
      const match = record.match(/^[0-7]{6} (?:blob|tree|commit) [a-f0-9]{40,64}\t(.+)$/su);
      if (!match || match[1].length === 0) {
        throw new Error("PRIVACY_TREE_RECORD_INVALID");
      }
      return match[1];
    });
}
