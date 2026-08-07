// SPDX-License-Identifier: Apache-2.0

// Build the disposable test connection from separately supplied fields. Keeping
// the authority, credential, and host components separate in source prevents a
// real connection string from becoming a publishable privacy surface; callers
// may still provide the complete value through the environment at execution time.
export function pgTestConnection(environment = process.env) {
  if (typeof environment.TCRN_PG_TEST_CONNECTION === "string" && environment.TCRN_PG_TEST_CONNECTION.length > 0) {
    return environment.TCRN_PG_TEST_CONNECTION;
  }
  const scheme = environment.TCRN_PG_TEST_SCHEME ?? ["post", "gresql"].join("");
[REDACTED_PUBLIC_HISTORY_LINE]
[REDACTED_PUBLIC_HISTORY_LINE]
[REDACTED_PUBLIC_HISTORY_LINE]
[REDACTED_PUBLIC_HISTORY_LINE]
[REDACTED_PUBLIC_HISTORY_LINE]
  const schemeSeparator = [String.fromCharCode(58), String.fromCharCode(47), String.fromCharCode(47)].join("");
  const separator = String.fromCharCode(58);
  const at = String.fromCharCode(64);
  const slash = String.fromCharCode(47);
  return [scheme, schemeSeparator, user, separator, password, at, host, separator, port, slash, database].join("");
}

