// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { canonicalJson, canonicalSha256 } from "../../protocol/src/index.js";

/**
 * Shared hardened reader for out-of-band authority files.
 *
 * Every caller keeps its own error class, reason-code family, post-read
 * validator and admission branding. This module owns exactly one thing: the
 * time-of-check-to-time-of-use sequence that turns a path plus an out-of-band
 * expectation into verified canonical JSON bytes. Each behaviour below is the
 * strongest of the three variants this module replaced.
 */

export interface AuthorityFileReasonCodes<Code extends string> {
  /** Authority argument absent, or its fields are not strings. */
  readonly required: Code;
  /** Path precheck failure, or a realpath that moved. */
  readonly path: Code;
  /** Malformed expected digest, or a content digest mismatch. */
  readonly digest: Code;
  /** Every time-of-check-to-time-of-use race and normalised filesystem error. */
  readonly changed: Code;
  /** Symbolic link, nlink other than one, or an ELOOP open. */
  readonly link: Code;
  /** Not a regular file. Directories land here. */
  readonly specialFile: Code;
  /** Size below the floor, above the ceiling, or a bounded-read overflow. */
  readonly limitExceeded: Code;
  /** The bytes did not round-trip through UTF-8. */
  readonly notUtf8: Code;
  /** The bytes were not parseable JSON. */
  readonly notJson: Code;
  /** The bytes were not the canonical encoding of their own value. */
  readonly notCanonical: Code;
}

export interface AuthorityFileDetails {
  /** Caller-specific detail for the missing-authority failure. */
  readonly required: string;
  /** Caller-specific detail for the malformed-expected-digest failure. */
  readonly expectedDigest: string;
}

export interface AuthorityFileHooks {
  readonly afterLstatForTest?: () => Promise<void>;
  readonly afterOpenForTest?: () => Promise<void>;
  readonly afterReadChunkForTest?: (totalBytesRead: number) => Promise<void>;
  readonly observeReadBytesForTest?: (totalBytesRead: number) => void;
}

export interface AuthorityFileExpectation {
  readonly expectedCanonicalPath: string;
  readonly expectedFileSha256: string;
}

export interface AuthorityFileParameters<Code extends string> {
  readonly maximumBytes: number;
  readonly codes: AuthorityFileReasonCodes<Code>;
  readonly details: AuthorityFileDetails;
  readonly fail: (reasonCode: Code, detail: string) => never;
  /**
   * Predicate identifying the caller's own error type. The read block
   * normalises unexpected filesystem errors into the `changed` code; without
   * this predicate it would also swallow and relabel the caller's own typed
   * failures raised from inside that block.
   */
  readonly isOwnError: (error: unknown) => boolean;
  readonly hooks?: AuthorityFileHooks;
}

export interface AuthorityFileResult {
  readonly content: Buffer;
  readonly sourceText: string;
  readonly parsed: unknown;
  readonly fileSha256: string;
  readonly sourceIdentityDigest: string;
  readonly canonicalPath: string;
}

const readChunkBytes = 16_384;

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mode === right.mode &&
    left.nlink === right.nlink && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function readBoundedAuthorityBytes<Code extends string>(
  handle: Awaited<ReturnType<typeof open>>,
  path: string,
  parameters: AuthorityFileParameters<Code>,
): Promise<Buffer> {
  const { maximumBytes, codes, hooks } = parameters;
  // Explicitly annotated so the compiler applies never-returning-call control
  // flow analysis: it only does so for a const with an explicit type, which a
  // destructured binding cannot carry.
  const fail: (reasonCode: Code, detail: string) => never = parameters.fail;
  const chunks: Buffer[] = [];
  let totalBytesRead = 0;
  while (true) {
    const remaining = maximumBytes + 1 - totalBytesRead;
    if (remaining <= 0) fail(codes.limitExceeded, path);
    const buffer = Buffer.allocUnsafe(Math.min(readChunkBytes, remaining));
    let bytesRead: number;
    try {
      ({ bytesRead } = await handle.read(buffer, 0, buffer.length, null));
    } catch {
      fail(codes.changed, path);
    }
    if (bytesRead === 0) break;
    totalBytesRead += bytesRead;
    hooks?.observeReadBytesForTest?.(totalBytesRead);
    if (totalBytesRead > maximumBytes) fail(codes.limitExceeded, path);
    chunks.push(buffer.subarray(0, bytesRead));
    await hooks?.afterReadChunkForTest?.(totalBytesRead);
  }
  return Buffer.concat(chunks, totalBytesRead);
}

export async function readAuthorityFile<Code extends string>(
  path: string,
  authority: AuthorityFileExpectation | undefined,
  parameters: AuthorityFileParameters<Code>,
): Promise<AuthorityFileResult> {
  const { maximumBytes, codes, details, isOwnError, hooks } = parameters;
  // See the note in readBoundedAuthorityBytes: the explicit annotation is what
  // lets the compiler treat every fail(...) call as terminating this flow.
  const fail: (reasonCode: Code, detail: string) => never = parameters.fail;
  if (!authority || typeof authority.expectedCanonicalPath !== "string" || typeof authority.expectedFileSha256 !== "string") {
    fail(codes.required, details.required);
  }
  if (!isAbsolute(authority.expectedCanonicalPath) || resolve(authority.expectedCanonicalPath) !== authority.expectedCanonicalPath ||
    path !== authority.expectedCanonicalPath) {
    fail(codes.path, path);
  }
  if (!/^[a-f0-9]{64}$/u.test(authority.expectedFileSha256)) fail(codes.digest, details.expectedDigest);

  let before: BigIntStats;
  try { before = await lstat(path, { bigint: true }); } catch { fail(codes.changed, path); }
  if (before.isSymbolicLink()) fail(codes.link, path);
  if (!before.isFile()) fail(codes.specialFile, path);
  if (before.nlink !== 1n) fail(codes.link, path);
  if (before.size < 2n || before.size > BigInt(maximumBytes)) fail(codes.limitExceeded, path);
  await hooks?.afterLstatForTest?.();

  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as { code?: string }).code === "ELOOP") fail(codes.link, path);
    fail(codes.changed, path);
  }

  let content: Buffer;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameFileIdentity(before, opened)) fail(codes.changed, path);
    await hooks?.afterOpenForTest?.();
    content = await readBoundedAuthorityBytes(handle, path, parameters);
    const afterRead = await handle.stat({ bigint: true });
    let named: BigIntStats;
    try { named = await lstat(path, { bigint: true }); } catch { fail(codes.changed, path); }
    if (!sameFileIdentity(opened, afterRead) || !sameFileIdentity(afterRead, named) || BigInt(content.length) !== afterRead.size) {
      fail(codes.changed, path);
    }
  } catch (error) {
    if (isOwnError(error)) throw error;
    fail(codes.changed, path);
  } finally {
    await handle.close();
  }

  const sourceText = content.toString("utf8");
  if (!Buffer.from(sourceText, "utf8").equals(content)) fail(codes.notUtf8, path);
  let canonicalPath: string;
  try { canonicalPath = await realpath(path); } catch { fail(codes.changed, path); }
  if (canonicalPath !== path) fail(codes.path, path);
  const fileSha256 = createHash("sha256").update(content).digest("hex");
  if (fileSha256 !== authority.expectedFileSha256) fail(codes.digest, path);
  let parsed: unknown;
  try { parsed = JSON.parse(sourceText); } catch { fail(codes.notJson, path); }
  let canonicalSource: string;
  try { canonicalSource = canonicalJson(parsed); } catch { fail(codes.notCanonical, path); }
  if (canonicalSource !== sourceText) fail(codes.notCanonical, path);

  return {
    content,
    sourceText,
    parsed,
    fileSha256,
    canonicalPath,
    sourceIdentityDigest: canonicalSha256({
      dev: before.dev.toString(), ino: before.ino.toString(), size: before.size.toString(), mode: before.mode.toString(),
      mtimeNs: before.mtimeNs.toString(), ctimeNs: before.ctimeNs.toString(),
    }),
  };
}
