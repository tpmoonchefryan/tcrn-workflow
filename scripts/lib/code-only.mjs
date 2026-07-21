// SPDX-License-Identifier: Apache-2.0

// The three source rules below judge code, so they are applied to code. Scanning the
// whole file made a comment that used an English word indistinguishable from a type
// annotation, and the observable effect was not stricter typing -- it was authors
// routing around the words "any" and "eval" in prose. Comments and string literals
// are blanked (length-preserving, so reported offsets still line up) and the rules
// then run against what is left.
//
// This does not weaken LINT_EXPLICIT_ANY. Implicit any is already refused by the
// compiler under strict; the rule's whole remaining job is explicit annotations, and
// those only ever appear in code.
export function codeOnly(content) {
  let out = "";
  let index = 0;
  const blank = (value) => value.replace(/[^\n]/gu, " ");
  while (index < content.length) {
    const rest = content.slice(index);
    const line = rest.match(/^\/\/[^\n]*/u);
    if (line) { out += blank(line[0]); index += line[0].length; continue; }
    const block = rest.match(/^\/\*[\s\S]*?\*\//u);
    if (block) { out += blank(block[0]); index += block[0].length; continue; }
    const text = rest.match(/^(['"`])(?:\\.|(?!\1)[\s\S])*\1/u);
    if (text) { out += blank(text[0]); index += text[0].length; continue; }
    out += content[index];
    index += 1;
  }
  return out;
}
