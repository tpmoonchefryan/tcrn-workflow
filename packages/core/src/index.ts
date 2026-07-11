// SPDX-License-Identifier: Apache-2.0

export const FRAMEWORK_VERSION = "0.0.0-development" as const;
export const DEFAULT_MODE = "development" as const;

export type WorkflowMode = "development" | "release";

export type RootKind =
  | "framework"
  | "workspace"
  | "transient"
  | "evidence-locator"
  | "release-trust";

export interface ExplicitRoot {
  readonly kind: RootKind;
  readonly path: string;
}

export interface DevelopmentAdmission {
  readonly admitted: true;
  readonly mode: "development";
  readonly projectCommandNetwork: "process-guarded-offline";
  readonly osNetworkSandbox: "not-provided";
  readonly telemetry: "disabled";
}

export interface ReleaseAdmissionRequest {
  readonly mode: "release";
  readonly trustRootPath: string;
  readonly bundlePath: string;
  readonly subject: string;
  readonly repository: string;
  readonly workflow: string;
}

export function admitDevelopment(): DevelopmentAdmission {
  return {
    admitted: true,
    mode: DEFAULT_MODE,
    projectCommandNetwork: "process-guarded-offline",
    osNetworkSandbox: "not-provided",
    telemetry: "disabled",
  };
}

export { assertDistinctRoots, RootIdentityError } from "./root-identity.js";
export type { CanonicalRoot } from "./root-identity.js";
