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
  readonly network: "offline";
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
    network: "offline",
    telemetry: "disabled",
  };
}

export function assertDistinctRoots(roots: readonly ExplicitRoot[]): void {
  const paths = new Set<string>();
  for (const root of roots) {
    if (root.path.length === 0) {
      throw new Error("ROOT_PATH_REQUIRED");
    }
    if (paths.has(root.path)) {
      throw new Error("ROOT_PATH_COLLISION");
    }
    paths.add(root.path);
  }
}
