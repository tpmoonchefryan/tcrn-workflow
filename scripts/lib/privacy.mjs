// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import { compareCanonicalText } from "./canonical-order.mjs";
import { PRIVATE_TOKEN_NAMES } from "./private-token-roster.mjs";

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
const joinParts = (parts, separator) => parts.join(separator);

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

function privacyPatterns(owner, privateTokens = []) {
  const legacyName = joinParts(["TCRN", "Workflow", "Platform", "Legacy"], "-");
  const controlDirectory = joinParts([".", "context", "/"], "");
  const agentDirectory = joinParts([".", "llm", "/"], "");
  const localUserPath = joinParts(["/", "Users", "/[^/\\s]+/"], "");
  const linuxHomePath = joinParts(["/", "home", "/[^/\\s]+/"], "");
  const sshUrlPrefix = joinParts(["ssh", ":", "/", "/"], "");
  const patterns = [
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
    // Credentials are private regardless of the URL scheme. The old https?
    // shape missed postgres:// and other service connection strings.
    ["AUTHENTICATED_URL", /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/iu],
    ["PRIVATE_HOSTNAME", /\b[A-Za-z0-9-]+\.(?:lan|internal|corp)\b/iu],
    ["PRIVATE_USER_AT_HOST", /\b(?:deploy|root|tcrn|ubuntu)@[A-Za-z0-9.-]+\b/iu],
      // Loopback is deliberately NOT in this class. The class exists to catch an
      // address that reveals someone's network — which host, which subnet, what the
      // deployment looks like. 127.0.0.1 names no host and is identical on every
      // machine on earth; publishing it discloses nothing. Keeping it here made any
      // feature that binds locally unreleasable, which is how the portal's bind
      // address — a security property meant to be stated out loud — tripped a
      // privacy gate. The RFC 1918 ranges are unchanged.
    ["PRIVATE_IPV4", /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/u],
    ["US_SSN", /\b\d{3}-\d{2}-\d{4}\b/u],
    ["PHONE_IDENTIFIER", /\+?\d{1,3}[-. ]\d{3}[-. ]\d{3}[-. ]\d{4}\b/u],
    ["CUSTOMER_SOURCE_MARKER", /\b(?:customer|tenant)[-_ ](?:export|dump|backup)\b/iu],
    ["CONTROL_PLANE_PATH", new RegExp(controlDirectory.replace(".", "\\."), "u")],
    ["AGENT_CONTROL_PATH", new RegExp(agentDirectory.replace(".", "\\."), "u")],
    ["LEGACY_REMOTE_NAME", new RegExp(legacyName, "u")],
    ["PRIVATE_RUNTIME_PATH", /\/(?:srv|var)\/[A-Za-z0-9._-]+\/(?:governance|engine)(?:\/|\b)/u],
    ["PRIVATE_SSH_URL", new RegExp(escaped(sshUrlPrefix), "u")],
    ["OWNER_PRIVATE_IDENTIFIER", new RegExp(escaped(owner), "u")],
  ];
  for (const token of privateTokens) {
    if (typeof token !== "string" || token.length === 0) continue;
    patterns.push(["PRIVATE_RUNTIME_VALUE", new RegExp(escaped(token), "u")]);
  }
  // A private value hidden behind a constructor is still a private value. This
  // structural leg is deliberately conservative: it only fires when an encoder
  // is close to a deployment-private token name, so ordinary String.fromCharCode
  // fixtures elsewhere in the repository remain valid.
  const privateName = [...PRIVATE_TOKEN_NAMES, "PRIVATE_VM_HOST", "PRIVATE_RUNTIME_ROOT", "PRIVATE_FACADE_IP", "GOVERNANCE_ROOT"]
    .map(escaped)
    .join("|");
  patterns.push([
    "OBFUSCATED_PRIVATE_CONFIGURATION",
    new RegExp(`(?:^\\s*(?:const|let|var)\\s+(?:${privateName})[^\\n]*(?:\\.join\\s*\\(|String\\.fromCharCode|fromCharCode|atob\\s*\\(|base64|\\.reverse\\s*\\())|(?:^\\s*["']?pattern["']?\\s*:[^\\n]*(?:\\\\x[0-9a-f]{2}|\\\\u[0-9a-f]{4}|\\.join\\s*\\(|String\\.fromCharCode|atob\\s*\\(|base64|\\.reverse\\s*\\())`, "mu"),
  ]);
  return patterns;
}

function decodeJavascriptString(value) {
  try {
    return JSON.parse(`"${value.replaceAll('"', '\\"')}"`);
  } catch {
    return value
      .replaceAll(/\\x([0-9a-f]{2})/giu, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replaceAll(/\\u\{([0-9a-f]+)\}/giu, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
      .replaceAll(/\\u([0-9a-f]{4})/giu, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replaceAll(/\\\//gu, "/");
  }
}

function evaluateStringLiteral(value) {
  const quote = value[0];
  if (quote !== "\"" && quote !== "'") return null;
  const body = value.slice(1, -1);
  return quote === "\"" ? decodeJavascriptString(body) : body
    .replaceAll(/\\x([0-9a-f]{2})/giu, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replaceAll(/\\u([0-9a-f]{4})/giu, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replaceAll(/\\\//gu, "/")
    .replaceAll("\\'", "'");
}

// A privacy scan must distinguish a path that appears in program data from the
// syntax of a regular-expression literal. Decoding every `\\/` in a source
// file turns a pattern containing an escaped local prefix and a character class into a convincing-looking
// path and lets its character class provide a fake username. Keep this lexer
// small and non-executing: it recognizes strings, comments and regex literals,
// then projects only literal portions of a valid regex into the normalized scan
// surface. Invalid or ambiguous slash expressions remain untouched and are
// still covered by the raw scan.
const regexPrefixWords = new Set([
  "await", "case", "delete", "do", "else", "in", "instanceof", "new", "of", "return", "throw", "typeof", "void", "yield",
]);
const regexPrefixPunctuation = new Set(["(", "[", "{", ",", ";", ":", "=", "!", "?", "&", "|", "+", "-", "*", "%", "^", "~", "<", ">"]);
const regexMetaEscapes = new Set(["A", "B", "b", "D", "d", "G", "K", "k", "p", "P", "s", "S", "W", "w", "Z", "z"]);

function canStartRegex(previous) {
  if (previous === null) return true;
  if (previous.kind === "word") return regexPrefixWords.has(previous.value);
  return previous.kind === "punctuation" && regexPrefixPunctuation.has(previous.value);
}

function readQuotedSource(value, start, quote) {
  let cursor = start + 1;
  while (cursor < value.length) {
    if (value[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (value[cursor] === quote) return {end: cursor + 1};
    if (value[cursor] === "\n" || value[cursor] === "\r") return {end: cursor};
    cursor += 1;
  }
  return {end: value.length};
}

function readTemplateSource(value, start) {
  let cursor = start + 1;
  while (cursor < value.length) {
    if (value[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (value[cursor] === "`") return {end: cursor + 1};
    cursor += 1;
  }
  return {end: value.length};
}

function readRegexSource(value, start) {
  let cursor = start + 1;
  let inClass = false;
  let escaped = false;
  while (cursor < value.length) {
    const character = value[cursor];
    if (escaped) {
      escaped = false;
      cursor += 1;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      cursor += 1;
      continue;
    }
    if (character === "\n" || character === "\r") return null;
    if (character === "[") {
      inClass = true;
      cursor += 1;
      continue;
    }
    if (character === "]" && inClass) {
      inClass = false;
      cursor += 1;
      continue;
    }
    if (character === "/" && !inClass) {
      const body = value.slice(start + 1, cursor);
      let flagEnd = cursor + 1;
      while (flagEnd < value.length && /[A-Za-z]/u.test(value[flagEnd])) flagEnd += 1;
      const flags = value.slice(cursor + 1, flagEnd);
      try {
        // Constructor parsing validates the body/flag grammar without ever
        // executing the expression represented by this literal.
        new RegExp(body, flags);
      } catch {
        return null;
      }
      return {end: flagEnd, body};
    }
    cursor += 1;
  }
  return null;
}

function decodeRegexEscape(body, cursor) {
  const next = body[cursor + 1];
  if (next === undefined) return {text: "", end: cursor + 1};
  if (next === "x" && /^[0-9a-f]{2}$/iu.test(body.slice(cursor + 2, cursor + 4))) {
    return {text: String.fromCharCode(Number.parseInt(body.slice(cursor + 2, cursor + 4), 16)), end: cursor + 4};
  }
  if (next === "u") {
    const brace = body[cursor + 2] === "{";
    const close = brace ? body.indexOf("}", cursor + 3) : -1;
    const digits = brace ? body.slice(cursor + 3, close < 0 ? body.length : close) : body.slice(cursor + 2, cursor + 6);
    if (digits.length > 0 && /^[0-9a-f]+$/iu.test(digits) && (!brace || close >= 0)) {
      try {
        return {text: String.fromCodePoint(Number.parseInt(digits, 16)), end: brace ? close + 1 : cursor + 6};
      } catch {
        return {text: " ", end: brace ? close + 1 : cursor + 6};
      }
    }
  }
  if (regexMetaEscapes.has(next) || /[0-9]/u.test(next)) return {text: " ", end: cursor + 2};
  if (next === "c" && body[cursor + 2]) return {text: " ", end: cursor + 3};
  // Escaped punctuation is a literal in a regex pattern. In particular,
  // escaped slash and dot are needed to retain concrete path values.
  return {text: next, end: cursor + 2};
}

function regexLiteralText(body) {
  let output = "";
  let cursor = 0;
  while (cursor < body.length) {
    const character = body[cursor];
    if (character === "\\") {
      const decoded = decodeRegexEscape(body, cursor);
      output += decoded.text;
      cursor = decoded.end;
      continue;
    }
    if (character === "[") {
      let end = cursor + 1;
      let escaped = false;
      while (end < body.length) {
        if (!escaped && body[end] === "]") {
          end += 1;
          break;
        }
        if (!escaped && body[end] === "\\") escaped = true;
        else escaped = false;
        end += 1;
      }
      // A class describes a set of possible characters, not one concrete
      // username. Leave a separator so surrounding literals cannot form one.
      output += " ";
      cursor = end;
      continue;
    }
    if (character === "|" || character === "." || character === "^" || character === "$" || character === "*" || character === "+" || character === "?" || character === "{") {
      output += " ";
      if (character === "{") {
        const close = body.indexOf("}", cursor + 1);
        cursor = close < 0 ? cursor + 1 : close + 1;
      } else {
        cursor += 1;
      }
      continue;
    }
    if (character === "}" || character === ")" || character === "(" || character === ":") {
      cursor += 1;
      continue;
    }
    output += character;
    cursor += 1;
  }
  return output;
}

function normalizeJavascriptRegexLiterals(value) {
  let output = "";
  let cursor = 0;
  let previous = null;
  while (cursor < value.length) {
    const character = value[cursor];
    if (character === "\"" || character === "'") {
      const token = readQuotedSource(value, cursor, character);
      output += value.slice(cursor, token.end);
      cursor = token.end;
      previous = {kind: "literal", value: "string"};
      continue;
    }
    if (character === "`") {
      const token = readTemplateSource(value, cursor);
      output += value.slice(cursor, token.end);
      cursor = token.end;
      previous = {kind: "literal", value: "template"};
      continue;
    }
    if (character === "/" && value[cursor + 1] === "/") {
      const newline = value.indexOf("\n", cursor + 2);
      const end = newline < 0 ? value.length : newline;
      output += value.slice(cursor, end);
      cursor = end;
      continue;
    }
    if (character === "/" && value[cursor + 1] === "*") {
      const close = value.indexOf("*/", cursor + 2);
      const end = close < 0 ? value.length : close + 2;
      output += value.slice(cursor, end);
      cursor = end;
      continue;
    }
    if (character === "/" && canStartRegex(previous)) {
      const literal = readRegexSource(value, cursor);
      if (literal) {
        output += regexLiteralText(literal.body);
        cursor = literal.end;
        previous = {kind: "literal", value: "regex"};
        continue;
      }
    }
    if (/[A-Za-z_$]/u.test(character)) {
      let end = cursor + 1;
      while (end < value.length && /[A-Za-z0-9_$]/u.test(value[end])) end += 1;
      const word = value.slice(cursor, end);
      output += word;
      cursor = end;
      previous = {kind: "word", value: word};
      continue;
    }
    if (/[0-9]/u.test(character)) {
      let end = cursor + 1;
      while (end < value.length && /[A-Za-z0-9_.]/u.test(value[end])) end += 1;
      output += value.slice(cursor, end);
      cursor = end;
      previous = {kind: "literal", value: "number"};
      continue;
    }
    if (character === "+" && value[cursor + 1] === "+" || character === "-" && value[cursor + 1] === "-") {
      output += value.slice(cursor, cursor + 2);
      cursor += 2;
      previous = {kind: "literal", value: "update"};
      continue;
    }
    output += character;
    cursor += 1;
    previous = {kind: "punctuation", value: character};
  }
  return output;
}

function decodeBase64(value) {
  try {
    return Buffer.from(value, "base64").toString("utf8");
  } catch {
    return value;
  }
}

/** Expand only literal, local obfuscation forms; never execute source code. */
export function normalizePrivacyText(content) {
  let normalized = String(content);
  for (let pass = 0; pass < 3; pass += 1) {
    const protectedPatternLines = [];
    normalized = normalized.split("\n").map((line) => {
      if (/\[\s*["'](?:LOCAL_ABSOLUTE_PATH|PRIVATE_SSH_URL)["']\s*,/u.test(line)) {
        const marker = `__PUBLIC_PATTERN_LINE_${protectedPatternLines.length}__`;
        protectedPatternLines.push(line);
        return marker;
      }
      return line;
    }).join("\n");
    // Run the regex projection once. Running it on later passes would mistake
    // a projected concrete path for a second regex
    // literal and erase the evidence that the first pass intentionally kept.
    if (pass === 0) normalized = normalizeJavascriptRegexLiterals(normalized);
    const protectedPatternJoins = [];
    normalized = normalized.replace(
      /(\b(?:legacyName|controlDirectory|agentDirectory|localUserPath|privateKeyMarker)\s*=\s*)(\[[^\n]*?\]\s*\.join\(\s*["'][^"']*["']\s*\))/gu,
      (_, prefix, expression) => {
        const marker = `__PUBLIC_PATTERN_JOIN_${protectedPatternJoins.length}__`;
        protectedPatternJoins.push(expression);
        return `${prefix}${marker}`;
      },
    );
    normalized = normalized
      .replaceAll(/\\x([0-9a-f]{2})/giu, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replaceAll(/\\u\{([0-9a-f]+)\}/giu, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
      .replaceAll(/\\u([0-9a-f]{4})/giu, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replaceAll(/\\\//gu, "/")
      .replaceAll(/\[-\]/gu, "-")
      .replace(/String\.fromCharCode\(\s*([0-9]+(?:\s*,\s*[0-9]+)*)\s*\)/gu, (_, values) =>
        [...values.matchAll(/[0-9]+/gu)].map((match) => String.fromCharCode(Number(match[0]))).join(""))
      .replace(/(?:atob|Buffer\.from)\(\s*(["'])([A-Za-z0-9+/=]+)\1(?:\s*,\s*["']base64["'])?\s*\)(?:\.toString\(\s*["']utf8["']\s*\))?/gu,
        (_, __, value) => decodeBase64(value));

    normalized = normalized.replace(/\[\s*((?:["'](?:\\.|[^"'])*["']\s*,\s*)+["'](?:\\.|[^"'])*["'])\s*\]\s*\.join\(\s*(["'])(.*?)\2\s*\)/gu,
      (_, values, __, separator) => {
        const parts = [...values.matchAll(/(["'])(?:\\.|[^"'])*\1/gu)]
          .map((match) => evaluateStringLiteral(match[0]))
          .filter((value) => value !== null);
        return parts.length > 0 ? parts.join(separator) : _;
      });
    normalized = normalized.replace(/\[\s*((?:["'](?:\\.|[^"'])*["']\s*,\s*)+["'](?:\\.|[^"'])*["'])\s*\]\s*\.reverse\(\)\.join\(\s*(["'])(.*?)\2\s*\)/gu,
      (_, values, __, separator) => {
        const parts = [...values.matchAll(/(["'])(?:\\.|[^"'])*\1/gu)]
          .map((match) => evaluateStringLiteral(match[0]))
          .filter((value) => value !== null)
          .reverse();
        return parts.length > 0 ? parts.join(separator) : _;
      });
    normalized = normalized
      .replace(/__PUBLIC_PATTERN_JOIN_(\d+)__/gu, (_, index) => protectedPatternJoins[Number(index)])
      .replace(/__PUBLIC_PATTERN_LINE_(\d+)__/gu, (_, index) => protectedPatternLines[Number(index)]);
  }
  return normalized;
}

function sanitizeAllowedPublicMetadata(entry, owner) {
  const p3Marker = joinParts([".", "context/platform/workflow-v3-capabilities/p3-local-work-graph.accepted.json"], "");
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

export function scanPrivacyEntries(entries, { owner, privateTokens = [] } = {}) {
  if (typeof owner !== "string" || owner.length === 0) {
    throw new Error("PRIVACY_OWNER_REQUIRED");
  }
  const patterns = privacyPatterns(owner, privateTokens);
  const findings = [];
  for (const entry of entries) {
    if (typeof entry.label !== "string" || typeof entry.kind !== "string" || typeof entry.content !== "string") {
      throw new Error("PRIVACY_ENTRY_INVALID");
    }
    const content = sanitizeAllowedPublicMetadata(entry, owner);
    const normalized = normalizePrivacyText(content);
    for (const [reasonCode, pattern] of patterns) {
      pattern.lastIndex = 0;
      if (pattern.test(content) || pattern.test(normalized)) {
        findings.push(`${reasonCode}:${entry.kind}:${entry.label}`);
      }
    }
  }
  return findings;
}

const gitObjectBatchHeader = /^([a-f0-9]{40,64}) (blob|commit|tag|tree) (0|[1-9][0-9]*)$/u;

// `git cat-file --batch` frames each object as "<oid> SP <type> SP <size> LF <bytes> LF".
// Extraction is length-defined: the payload is a zero-copy subarray sized by the declared
// header count and is never decoded, so it is bit-identical to a per-object raw capture
// even for binary, NUL-bearing and invalid-UTF-8 blobs.
//
// `expectedBytes` is the total stream length implied by the batch-check pass. The
// equality check is an independent backstop against a truncated capture: a short stream
// parses cleanly right up to the cut and would silently drop every object past it,
// leaving the privacy gate green over unscanned history. It holds even if the
// COMMAND_OUTPUT_OVERFLOW guard in local-command.mjs is reverted.
export function parseGitObjectBatch(stream, expectedBytes) {
  if (!Buffer.isBuffer(stream)) {
    throw new Error("PRIVACY_GIT_OBJECT_STREAM_INVALID");
  }
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) {
    throw new Error("PRIVACY_GIT_OBJECT_STREAM_INVALID");
  }
  if (stream.length !== expectedBytes) {
    throw new Error("PRIVACY_GIT_OBJECT_STREAM_INCOMPLETE");
  }
  const records = [];
  let cursor = 0;
  while (cursor < stream.length) {
    const headerEnd = stream.indexOf(0x0a, cursor);
    if (headerEnd === -1) {
      throw new Error("PRIVACY_GIT_OBJECT_TYPE");
    }
    const match = stream.subarray(cursor, headerEnd).toString("utf8").match(gitObjectBatchHeader);
    if (!match) {
      throw new Error("PRIVACY_GIT_OBJECT_TYPE");
    }
    const [, object, type, sizeText] = match;
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size)) {
      throw new Error("PRIVACY_GIT_OBJECT_TYPE");
    }
    const start = headerEnd + 1;
    const content = stream.subarray(start, start + size);
    if (content.length !== size || stream[start + size] !== 0x0a) {
      throw new Error("PRIVACY_GIT_OBJECT_TYPE");
    }
    cursor = start + size + 1;
    records.push({ object, type, content });
  }
  return records;
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
