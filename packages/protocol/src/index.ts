// SPDX-License-Identifier: Apache-2.0

export const PROTOCOL_STATUS = "not-implemented-p1" as const;

export interface ProtocolBootstrapStatus {
  readonly phase: "P1";
  readonly normativeProtocolAvailable: false;
  readonly reasonCode: "P2_OUT_OF_SCOPE";
}

export const protocolBootstrapStatus: ProtocolBootstrapStatus = {
  phase: "P1",
  normativeProtocolAvailable: false,
  reasonCode: "P2_OUT_OF_SCOPE",
};
