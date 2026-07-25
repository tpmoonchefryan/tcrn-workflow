// SPDX-License-Identifier: Apache-2.0

// The lint rules that judge source text run against code with comments and string
// literals blanked. That blanking is the whole of the change, so it is what these
// cases pin: what it must keep (every construct the rules exist to catch) and what it
// must stop keeping (the same words appearing in prose or data).
//
// The catching direction matters more than the passing one. A blanker that erased too
// much would let an explicit any through while every "must pass" case still passed,
// so each rule is exercised against a real violation as well as a false alarm.

import assert from "node:assert/strict";
import test from "node:test";

import { codeOnly, controlByteOffset } from "../scripts/lib/code-only.mjs";

const hasAny = (source) => /\bany\b/u.test(codeOnly(source));
const hasEval = (source) => /\beval\s*\(/u.test(codeOnly(source));

test("code survives blanking, so the rules still catch what they exist to catch", () => {
  assert.equal(hasAny("export function f(value: any): void { void value; }"), true);
  assert.equal(hasAny("export const a = (1 as unknown) as any;"), true);
  assert.equal(hasAny("export const a: Array<any> = [];"), true);
  assert.equal(hasAny("export const a: Record<string, any> = {};"), true);
  assert.equal(hasEval('export const r = eval("1");'), true);
});

test("prose and data stop being mistaken for code", () => {
  assert.equal(hasAny("// this comment may say any thing it likes"), false);
  assert.equal(hasAny("/* any of these words\n * are fine any time\n */"), false);
  assert.equal(hasAny('export const a = "any value at all";'), false);
  assert.equal(hasAny("export const a = 'any value at all';"), false);
  assert.equal(hasAny("export const a = `any interpolation`;"), false);
  assert.equal(hasEval("// never call eval( here"), false);
});

test("blanking is length-preserving and keeps line structure", () => {
  // Offsets and line numbers reported by a rule must still point at the real place,
  // so the blanked span has to occupy exactly as much room as what it replaced.
  const source = 'const a = 1; // any\nconst b = "any";\n/* any\nany */\nconst c = 2;\n';
  const blanked = codeOnly(source);
  assert.equal(blanked.length, source.length);
  assert.equal(blanked.split("\n").length, source.split("\n").length);
  for (const [index, line] of source.split("\n").entries()) {
    assert.equal(blanked.split("\n")[index].length, line.length, `line ${index + 1} width`);
  }
  assert.match(blanked, /const a = 1;/u);
  assert.match(blanked, /const c = 2;/u);
});

test("a string that contains comment markers is still a string", () => {
  // The scanner walks left to right, so an opener inside the other construct must not
  // end it early -- otherwise real code after the apparent close would be blanked away
  // and a violation there would go unseen.
  assert.equal(hasAny('const a = "// not a comment"; const b: any = 1;'), true);
  assert.equal(hasAny('const a = "/* not a comment */"; const b: any = 1;'), true);
  assert.equal(hasAny('const a = 1; // a quote " does not open a string\nconst b: any = 2;'), true);
  assert.equal(hasAny("const a = 1; /* a quote \" inside a block */ const b: any = 2;"), true);
});

test("an escaped quote does not end its string early", () => {
  // Without escape handling the string would appear to close at the escaped quote,
  // and "any" after it would read as code -- a false alarm that is hard to explain.
  assert.equal(hasAny('const a = "he said \\"any\\" loudly";'), false);
  assert.equal(hasAny("const a = 'it is \\'any\\' again';"), false);
});

test("a raw control byte is reported by offset, while TAB and LF are not", () => {
  // This is the one rule that must NOT go through the blanker: both real INC-018
  // instances sat inside string literals, which codeOnly() erases. Bytes are
  // synthesized here so this test file stays a text file.
  const clean = Buffer.from('const a = "x";\n\tconst b = 2;\n', "utf8");
  assert.equal(controlByteOffset(clean), -1);
  const nul = Buffer.concat([
    Buffer.from('const a = "', "utf8"),
    Buffer.from([0x00]),
    Buffer.from('";\n', "utf8"),
  ]);
  assert.equal(controlByteOffset(nul), 11);
  assert.equal(controlByteOffset(Buffer.from([0x0d])), 0);
  assert.equal(controlByteOffset(Buffer.from([0x7f])), 0);
  // The escape spelling the INC-018 patch adopted encodes to exactly the byte it
  // replaced, so the digest inputs that separator feeds are unchanged.
  assert.deepEqual([...Buffer.from("\u0000", "utf8")], [0x00]);
  assert.throws(() => controlByteOffset("not a buffer"), TypeError);
});
