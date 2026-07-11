// SPDX-License-Identifier: Apache-2.0

export const RELEASE_REQUIRED_ARGUMENTS = [
  "trust-root",
  "bundle",
  "subject",
  "repository",
  "workflow",
  "now",
] as const;

export type ReleaseRequiredArgument =
  (typeof RELEASE_REQUIRED_ARGUMENTS)[number];

export function missingReleaseArguments(
  supplied: Readonly<Record<string, string | undefined>>,
): readonly ReleaseRequiredArgument[] {
  return RELEASE_REQUIRED_ARGUMENTS.filter((name) => !supplied[name]);
}
