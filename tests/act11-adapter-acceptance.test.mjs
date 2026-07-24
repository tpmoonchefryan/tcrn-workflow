// SPDX-License-Identifier: Apache-2.0
//
// INIT-009 S076/S080 and INIT-010 S057: cross-host acceptance and hostile matrix.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  COLLECTION_ATTRIBUTION_NOTE,
  EXECUTION_MODE_EXTENSION_KEY,
  EXECUTION_RECEIPT_EXTENSION_KEY,
  OBSERVED_PROTOCOL_DIGEST,
  assessCodexActivationTrust,
  classifyConferenceExecution,
  collectCodexAppServerExecutions,
  collectExecutionReceipt,
  verifyCollectedTranscript,
} from "../dist/build/packages/core/src/index.js";
import { canonicalJson } from "../dist/build/packages/protocol/src/index.js";

const matrix = JSON.parse(
  await readFile(
    new URL(
      "../docs/verification/host/adapter-acceptance-matrix.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const fixture = JSON.parse(
  await readFile(
    new URL(
      "../packages/core/fixtures/act11-adapter-acceptance-cases.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const capabilityManifest = JSON.parse(
  await readFile(
    new URL(
      "../docs/verification/host/capability-manifest.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const liveIntegration = JSON.parse(
  await readFile(
    new URL(
      "../docs/verification/host/codex-live-integration-2026-07-25.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function observed(agentInvocationId, finalMessage) {
  const transcript = canonicalJson({
    agentInvocationId,
    finalMessageDigest: digest(finalMessage),
  });
  return {
    value: {
      agentInvocationId,
      startedAt: "2026-07-25T00:00:00Z",
      endedAt: "2026-07-25T00:00:01Z",
      freshContext: true,
      promptDigest: digest(`prompt:${agentInvocationId}`),
      finalMessage,
      transcriptPath: `fixture:${agentInvocationId}`,
      transcriptDigest: digest(transcript),
      transcriptBytes: Buffer.byteLength(transcript),
    },
    transcript,
  };
}

test("the acceptance matrix is closed, cross-host, and synchronized with the capability manifest", () => {
  assert.equal(matrix.schemaVersion, "tcrn.adapter-acceptance-matrix.v1");
  assert.equal(fixture.schemaVersion, "tcrn.act11-adapter-acceptance-cases.v1");
  assert.equal(Object.keys(matrix.hosts).length, fixture.hosts);
  assert.equal(matrix.surfaces.length, fixture.surfaces);
  assert.equal(matrix.negativeMatrix.length, fixture.negativeCases);
  assert.equal(new Set(matrix.surfaces.map((entry) => entry.id)).size, matrix.surfaces.length);

  const capabilityById = new Map(
    capabilityManifest.capabilities.map((entry) => [entry.id, entry]),
  );
  for (const surface of matrix.surfaces) {
    assert.deepEqual(Object.keys(surface).sort(), ["claude", "codex", "id"]);
    for (const host of ["codex", "claude"]) {
      assert.ok(
        ["enforce", "observe", "invoke-only", "unavailable"].includes(
          surface[host].governance,
        ),
      );
      assert.ok(matrix.evidenceClasses.includes(surface[host].evidenceClass));
      assert.equal(typeof surface[host].liveHostMeasured, "boolean");
      assert.equal(
        typeof surface[host].exactGeneratedBytesLiveMeasured,
        "boolean",
      );
      assert.ok(surface[host].boundary.length > 0);
    }
    const capability = capabilityById.get(surface.id);
    if (capability !== undefined) {
      assert.equal(surface.codex.governance, capability.codex.governance);
      assert.equal(surface.claude.governance, capability.claude.governance);
    }
  }
});

test("live evidence upgrades only the exact surfaces it measured", () => {
  const byId = new Map(matrix.surfaces.map((entry) => [entry.id, entry]));
  const activation = byId.get("adapter-activation");
  const sessionStart = byId.get("session-start-context-injection");
  const workflowMcp = byId.get("workflow-mcp-tools");
  const execution = byId.get("execution-collection");
  assert.equal(activation.codex.evidenceClass, "live_exact");
  assert.equal(activation.codex.exactGeneratedBytesLiveMeasured, true);
  assert.equal(sessionStart.codex.evidenceClass, "live_exact");
  assert.equal(sessionStart.codex.exactGeneratedBytesLiveMeasured, true);
  assert.equal(workflowMcp.codex.evidenceClass, "live_mechanism_only");
  assert.equal(workflowMcp.codex.exactGeneratedBytesLiveMeasured, true);
  assert.equal(execution.codex.evidenceClass, "live_mechanism_only");
  assert.equal(execution.codex.exactGeneratedBytesLiveMeasured, false);
  assert.equal(activation.claude.evidenceClass, "live_exact");

  for (const id of ["tool-approval-gate", "final-hop-stop-gate"]) {
    const surface = byId.get(id);
    assert.notEqual(surface.codex.governance, "enforce");
    assert.notEqual(surface.claude.governance, "enforce");
  }
  assert.equal(fixture.enforceHostSurfacesAuthorized, 0);
  assert.equal(fixture.codexExactGeneratedHookLiveFires, 1);
  assert.equal(fixture.liveWorkflowMcpRegistrations, 1);
  assert.equal(fixture.liveWorkflowMcpDirectHandshakes, 1);
  assert.equal(fixture.liveDesktopMultiAgentRuns, 1);
  assert.equal(fixture.liveAppServerAttaches, 0);
  assert.equal(fixture.liveMultiAgentReceiptComparisons, 0);
  assert.equal(liveIntegration.sessionStart.liveFire.result, "HOOK_CONTEXT_PRESENT");
  assert.equal(liveIntegration.workflowMcp.registration.enabled, true);
  assert.equal(liveIntegration.workflowMcp.directExactServerProbe.toolCount, 93);
  assert.equal(liveIntegration.multiAgent.appVisibleStartRecords, 3);
  assert.equal(liveIntegration.multiAgent.collectorBoundary.appServerAttached, false);
  assert.equal(
    liveIntegration.multiAgent.collectorBoundary.workflowExecutionReceiptProduced,
    false,
  );
  assert.ok(
    matrix.notClaimed.some((claim) =>
      claim.includes("No live App Server attach"),
    ),
  );
});

test("the hostile matrix names every required bypass, drift, replay, attribution, and coverage case", () => {
  const actual = matrix.negativeMatrix.map((entry) => entry.id).sort();
  assert.deepEqual(actual, [
    "activation-authority-mismatch",
    "bypass-no-registration",
    "cross-session-notification",
    "final-message-phase-unknown",
    "forged-actor-attribution",
    "fresh-context-unproven",
    "hosted-tool-coverage-hole",
    "no-observed-invocation",
    "opt-out-definition-removed",
    "protocol-version-drift",
    "replayed-notification",
    "rollback-byte-or-identity-drift",
    "transcript-tamper",
    "unapproved-hook-definition",
  ]);
  for (const entry of matrix.negativeMatrix) {
    assert.ok(entry.expectedDisposition.length > 0);
    assert.ok(entry.proof.length > 0);
  }
});

test("unapproved definitions and missing or drifted execution streams remain unavailable", () => {
  const binding = {
    handlerDigest: digest("handler"),
    summaryFileDigest: digest("summary"),
    hookDefinitionDigest: digest("definition"),
  };
  const assessment = assessCodexActivationTrust(binding, []);
  assert.equal(assessment.activationState, "pending_host_approval");
  assert.equal(assessment.currentDefinitionApproved, false);

  const common = {
    hostProduct: "Codex CLI",
    hostVersion: "0.139.0",
    sessionId: "session:acceptance",
    observedFrom: "2026-07-25T00:00:00Z",
    observedTo: "2026-07-25T00:01:00Z",
    notifications: [],
  };
  const noInvocation = collectCodexAppServerExecutions({
    ...common,
    protocolDigest: OBSERVED_PROTOCOL_DIGEST,
  });
  assert.equal(noInvocation.availability, "unavailable");
  assert.equal(noInvocation.reasonCode, "CODEX_EXECUTION_UNAVAILABLE");
  const drifted = collectCodexAppServerExecutions({
    ...common,
    protocolDigest: `sha256:${"0".repeat(64)}`,
  });
  assert.equal(drifted.protocolBinding, "unpinned");
  assert.equal(drifted.reasonCode, "CODEX_EXECUTION_PROTOCOL_UNPINNED");
});

test("collected receipts bind bytes and invocations but deliberately do not prove actor identity", () => {
  const first = observed("agent:invocation-a", "Position A");
  const second = observed("agent:invocation-b", "Position B");
  const context = {
    hostProduct: "Fixture Host",
    hostVersion: "1",
    sessionId: "session:acceptance",
    conferenceId: "conference:acceptance",
    availability: "observe",
  };
  const collected = [
    collectExecutionReceipt(
      first.value,
      "position:a",
      "receipt:a",
      context,
    ),
    collectExecutionReceipt(
      second.value,
      "position:b",
      "receipt:b",
      context,
    ),
  ];
  assert.equal(collected[0].receipt.attributionNote, COLLECTION_ATTRIBUTION_NOTE);
  assert.equal(Object.hasOwn(collected[0].receipt, "actorId"), false);
  assert.deepEqual(verifyCollectedTranscript(collected[0], first.transcript), {
    matches: true,
    transcriptSigned: false,
  });
  assert.deepEqual(
    verifyCollectedTranscript(collected[0], `${first.transcript} `),
    {
      matches: false,
      transcriptSigned: false,
    },
  );

  const request = {
    id: "conference:acceptance",
    type: "architecture",
    extensions: {
      [EXECUTION_MODE_EXTENSION_KEY]: {
        required: false,
        value: {
          mode: "multi-agent-deliberative",
        },
      },
    },
  };
  const positions = [
    {
      id: "position:a",
      conferenceId: request.id,
      position: "Position A",
      actorId: "profile:forged-a",
      extensions: {
        [EXECUTION_RECEIPT_EXTENSION_KEY]: {
          required: false,
          value: { receiptId: "receipt:a" },
        },
      },
    },
    {
      id: "position:b",
      conferenceId: request.id,
      position: "Position B",
      actorId: "profile:forged-b",
      extensions: {
        [EXECUTION_RECEIPT_EXTENSION_KEY]: {
          required: false,
          value: { receiptId: "receipt:b" },
        },
      },
    },
  ];
  assert.deepEqual(
    classifyConferenceExecution({
      request,
      positions,
      receipts: collected.map((entry) => entry.receipt),
    }),
    {
      mode: "multi-agent-deliberative",
      reasonCode: "EXECUTION_VALIDATED",
      independentPositions: 2,
    },
  );
  assert.equal(
    matrix.negativeMatrix.find(
      (entry) => entry.id === "forged-actor-attribution",
    ).expectedDisposition,
    "identity_unproven",
  );
});

test("story dispositions separate the live App record from the missing Workflow receipt comparison", () => {
  assert.equal(matrix.storyAcceptance.S076, fixture.s076);
  assert.equal(matrix.storyAcceptance.S080, fixture.s080);
  assert.equal(matrix.storyAcceptance.S057, fixture.s057);
  assert.equal(fixture.s076, "verified");
  assert.equal(fixture.s080, "accepted_with_explicit_unavailable_cells");
  assert.equal(
    fixture.s057,
    "partial_live_app_record_observed_receipt_comparison_missing",
  );
});
