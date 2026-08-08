// SPDX-License-Identifier: Apache-2.0
// INC-099: the names of deployment-supplied private values live in one place.
// The values themselves never belong in a public candidate or release artifact;
// the host supplies them at runtime. Keeping this roster value-free lets both the
// privacy gate and the SSH observer agree on the boundary without publishing the
// topology they protect.

export const PRIVATE_TOKEN_NAMES = Object.freeze([
  "TCRN_SSH_GOVERNED_HOST",
  "TCRN_SSH_RUNTIME_ROOT",
  "TCRN_SSH_LOOPBACK",
  "TCRN_SSH_FACADE_ENDPOINT",
]);

export const PRIVATE_TOKEN_PLACEHOLDERS = Object.freeze({
  TCRN_SSH_GOVERNED_HOST: "governed-host.invalid",
  TCRN_SSH_RUNTIME_ROOT: "/opt/tcrn-governed",
  TCRN_SSH_LOOPBACK: "loopback.invalid",
  TCRN_SSH_FACADE_ENDPOINT: "facade.invalid",
});

function configured(env, name) {
  const value = env?.[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function privateRuntimeConfig(env = process.env) {
  return Object.freeze({
    host: configured(env, "TCRN_SSH_GOVERNED_HOST") ?? PRIVATE_TOKEN_PLACEHOLDERS.TCRN_SSH_GOVERNED_HOST,
    runtimeRoot: configured(env, "TCRN_SSH_RUNTIME_ROOT") ?? PRIVATE_TOKEN_PLACEHOLDERS.TCRN_SSH_RUNTIME_ROOT,
    loopback: configured(env, "TCRN_SSH_LOOPBACK") ?? PRIVATE_TOKEN_PLACEHOLDERS.TCRN_SSH_LOOPBACK,
    facadeEndpoint: configured(env, "TCRN_SSH_FACADE_ENDPOINT") ?? PRIVATE_TOKEN_PLACEHOLDERS.TCRN_SSH_FACADE_ENDPOINT,
    configured: PRIVATE_TOKEN_NAMES.every((name) => configured(env, name) !== null),
  });
}
