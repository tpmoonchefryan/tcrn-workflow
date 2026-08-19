// SPDX-License-Identifier: Apache-2.0

// TCRN-CROSS-INC-232: every relative link in a tracked Markdown file must resolve.
//
// This exists because one did not, in the worst possible sentence. Moving the four
// code-of-conduct translations under docs/i18n/ left the French one's authority line --
// "en cas de divergence, c'est le texte anglais de CODE_OF_CONDUCT.md qui prévaut" --
// pointing at ./CODE_OF_CONDUCT.md, which from docs/i18n/ is nothing. The sentence
// telling a reader where the normative text lives linked to a 404, on a public
// repository, and it survived P1's twenty-three gates, sixty-one guard mutations, the
// release gate and eighteen platform-doctor legs. Nothing in this repository checked
// documentation links; the "links checked, none broken" claim made at the time came
// from a throwaway one-liner, which is not a gate and did not run again.
//
// Deliberately narrow. Anchors, mailto and external URLs are not resolved -- an
// external checker needs the network, which is the opposite of what this repository's
// verification path is allowed to need. A relative path either names a file in this
// tree or it does not, and that question is answerable offline and identically on
// every host.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// [text](target) and [text]: target, which together cover every form used here.
const INLINE_LINK = /\[(?:[^\]\\]|\\.)*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/gu;
const REFERENCE_LINK = /^\s{0,3}\[(?:[^\]\\]|\\.)+\]:\s*<?([^\s>]+)>?/gmu;

// A target that names something other than a path in this tree. Anchors are in-document,
// and a scheme means the answer is not on this filesystem.
function isLocalPath(target) {
  return !(target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/iu.test(target));
}

export function extractLinkTargets(source) {
  const targets = [];
  for (const pattern of [INLINE_LINK, REFERENCE_LINK]) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) targets.push(match[1]);
  }
  return targets;
}

// The fragment is a position inside the target, not part of its name, and a query
// string is meaningless for a path. Both are stripped before the file is looked for.
export function resolveLinkTarget(target, fromFile, root = REPOSITORY_ROOT) {
  const path = target.split("#")[0].split("?")[0];
  if (path.length === 0) return { checked: false, reason: "fragment-only" };
  const base = path.startsWith("/") ? root : dirname(resolve(root, fromFile));
  const absolute = path.startsWith("/") ? resolve(root, `.${path}`) : resolve(base, path);
  return { checked: true, absolute, resolves: existsSync(absolute) };
}

export async function inspectMarkdownLinks(root = REPOSITORY_ROOT, files) {
  const tracked = files ?? (await execFileAsync("git", ["-C", root, "ls-files", "*.md"], { maxBuffer: 8 * 1_048_576 }))
    .stdout.split("\n").filter((line) => line.length > 0);
  const broken = [];
  let checked = 0;
  for (const file of tracked) {
    let source;
    try {
      source = await readFile(resolve(root, file), "utf8");
    } catch {
      // A tracked file that cannot be read is the source allowlist's question, not this
      // gate's; reporting it here would give the same defect two owners.
      continue;
    }
    for (const target of extractLinkTargets(source)) {
      if (!isLocalPath(target)) continue;
      const verdict = resolveLinkTarget(target, file, root);
      if (!verdict.checked) continue;
      checked += 1;
      if (!verdict.resolves) broken.push({ file, target });
    }
  }
  broken.sort((left, right) => (left.file === right.file ? (left.target < right.target ? -1 : 1) : left.file < right.file ? -1 : 1));
  return broken.length === 0
    ? { ok: true, reasonCode: "MARKDOWN_LINKS_RESOLVED", files: tracked.length, checked }
    : { ok: false, reasonCode: "MARKDOWN_LINK_BROKEN", files: tracked.length, checked, broken };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await inspectMarkdownLinks();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}
