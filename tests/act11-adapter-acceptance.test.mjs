// SPDX-License-Identifier: Apache-2.0
//
// INIT-009 EPIC-024/S076/S080 and INIT-010 S057: cross-host acceptance and hostile matrix.

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
const observeEvidence = JSON.parse(
  await readFile(
    new URL(
      "../docs/verification/host/observe-hook-live-acceptance-2026-07-25.json",
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

test("EPIC-024 accepts exact live observe evidence with explicit version and account unavailable cells", () => {
  assert.equal(
    observeEvidence.schemaVersion,
    "tcrn.observe-hook-live-acceptance.v1",
  );
  assert.deepEqual(
    matrix.observeEventCoverage.eventSet,
    observeEvidence.scope.observeEvents,
  );
  assert.equal(matrix.observeEventCoverage.eventSet.length, fixture.observeEvents);
  assert.equal(
    matrix.observeEventCoverage.liveEventHostCells,
    fixture.liveObserveEventHostCells,
  );
  assert.equal(
    matrix.observeEventCoverage.explicitUnavailableEventHostCells,
    fixture.explicitUnavailableObserveEventHostCells,
  );
  assert.deepEqual(
    matrix.observeEventCoverage.cells,
    observeEvidence.eventCoverage,
  );
  assert.equal(
    observeEvidence.acceptance.disposition,
    "accepted_with_explicit_unavailable_cells",
  );
  assert.equal(observeEvidence.acceptance.crossHostEventSetCovered, true);
  assert.equal(observeEvidence.acceptance.perHostComplete, false);
  assert.equal(
    Object.keys(observeEvidence.codex.observedReceipts).length,
    fixture.codexExactGeneratedObserveEventLiveFires,
  );
  assert.equal(
    Object.keys(observeEvidence.claude.observedReceipts).length,
    fixture.claudeExactGeneratedObserveEventLiveFires,
  );
  assert.equal(
    observeEvidence.codex.versionPinnedUnavailable.event,
    "SessionEnd",
  );
  assert.equal(observeEvidence.codex.versionPinnedUnavailable.mustNotAliasTo, "Stop");
  assert.equal(observeEvidence.codex.hookTrust.bypassReliedUpon, false);
  assert.equal(observeEvidence.codex.appServer.hookStartedNotifications, 7);
  assert.equal(observeEvidence.codex.appServer.hookCompletedNotifications, 7);
  assert.equal(observeEvidence.codex.appServer.threadArchived, true);
  assert.equal(observeEvidence.codex.appServer.cleanTeardown, true);
  assert.equal(observeEvidence.claude.observedReceipts.SessionEnd, 3);
  assert.equal(observeEvidence.claude.remainingEventsUnavailable.inputTokens, 0);
  assert.equal(observeEvidence.claude.remainingEventsUnavailable.outputTokens, 0);
  assert.equal(observeEvidence.scope.enforceHostSurfacesAuthorized, 0);
});

test("current SessionStart definitions stay hermetic while bounded observe and S057 evidence remain separate", () => {
  const byId = new Map(matrix.surfaces.map((entry) => [entry.id, entry]));
  const activation = byId.get("adapter-activation");
  const sessionStart = byId.get("session-start-context-injection");
  const toolLifecycle = byId.get("tool-lifecycle-observe");
  const workflowMcp = byId.get("workflow-mcp-tools");
  const execution = byId.get("execution-collection");
  assert.equal(activation.codex.evidenceClass, "hermetic");
  assert.equal(activation.codex.liveHostMeasured, false);
  assert.equal(activation.codex.exactGeneratedBytesLiveMeasured, false);
  assert.equal(sessionStart.codex.evidenceClass, "hermetic");
  assert.equal(sessionStart.codex.liveHostMeasured, false);
  assert.equal(sessionStart.codex.exactGeneratedBytesLiveMeasured, false);
  assert.equal(workflowMcp.codex.evidenceClass, "live_mechanism_only");
  assert.equal(workflowMcp.codex.exactGeneratedBytesLiveMeasured, true);
  assert.equal(execution.codex.evidenceClass, "live_exact");
  assert.equal(execution.codex.exactGeneratedBytesLiveMeasured, true);
  assert.equal(toolLifecycle.codex.evidenceClass, "live_exact");
  assert.equal(toolLifecycle.codex.liveHostMeasured, true);
  assert.equal(toolLifecycle.codex.exactGeneratedBytesLiveMeasured, true);
  assert.equal(toolLifecycle.codex.governance, "unavailable");
  assert.equal(toolLifecycle.claude.evidenceClass, "live_mechanism_only");
  assert.equal(toolLifecycle.claude.liveHostMeasured, true);
  assert.equal(toolLifecycle.claude.exactGeneratedBytesLiveMeasured, true);
  assert.equal(toolLifecycle.claude.governance, "unavailable");
  assert.equal(activation.claude.evidenceClass, "hermetic");
  assert.equal(activation.claude.liveHostMeasured, false);
  assert.equal(sessionStart.claude.evidenceClass, "hermetic");
  assert.equal(sessionStart.claude.liveHostMeasured, false);

  for (const id of ["tool-approval-gate", "final-hop-stop-gate"]) {
    const surface = byId.get(id);
    assert.notEqual(surface.codex.governance, "enforce");
    assert.notEqual(surface.claude.governance, "enforce");
  }
  assert.equal(fixture.enforceHostSurfacesAuthorized, 0);
  assert.equal(fixture.codexExactGeneratedSessionStartLiveFires, 0);
  assert.equal(fixture.codexExactGeneratedObserveEventLiveFires, 5);
  assert.equal(fixture.claudeExactGeneratedObserveEventLiveFires, 1);
  assert.equal(fixture.liveWorkflowMcpRegistrations, 1);
  assert.equal(fixture.liveWorkflowMcpDirectHandshakes, 1);
  assert.equal(fixture.liveDesktopMultiAgentRuns, 1);
  assert.equal(fixture.liveAppServerAttaches, 1);
  assert.equal(fixture.liveMultiAgentReceiptComparisons, 1);
  assert.equal(liveIntegration.workflowMcp.registration.enabled, true);
  assert.equal(liveIntegration.workflowMcp.directExactServerProbe.toolCount, 93);
  assert.equal(liveIntegration.multiAgent.appVisibleStartRecords, 3);
  assert.equal(liveIntegration.appServerExecutionCollection.appServerAttached, true);
  assert.equal(
    liveIntegration.appServerExecutionCollection.workflowExecutionReceiptProduced,
    true,
  );
  assert.equal(liveIntegration.appServerExecutionCollection.readbackChecks, 28);
  assert.ok(
    matrix.notClaimed.some((claim) =>
      claim.includes("bounded evidence harness"),
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
  const comparison = assessCodexActivationTrust(binding, []);
  assert.equal(comparison.hookDefinitionInSuppliedApprovedSet, false);
  assert.equal(comparison.evidenceClass, "caller_supplied_input_only");

  const common = {
    hostProduct: "Codex CLI",
    hostVersion: "0.139.0",
    sessionId: "session:acceptance",
    observedFrom: "2026-07-25T00:00:00Z",
    observedTo: "2026-07-25T00:01:00Z",
    notifications: [],
    threadReadbacks: [],
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

test("story dispositions retain explicit unavailable cells while S057 is live-verified", () => {
  assert.equal(matrix.epicAcceptance["EPIC-024"], fixture.epic024);
  assert.equal(matrix.storyAcceptance.S076, fixture.s076);
  assert.equal(matrix.storyAcceptance.S080, fixture.s080);
  assert.equal(matrix.storyAcceptance.S057, fixture.s057);
  assert.equal(fixture.s076, "verified");
  assert.equal(fixture.s080, "accepted_with_explicit_unavailable_cells");
  assert.equal(fixture.epic024, "accepted_with_explicit_unavailable_cells");
  assert.equal(
    fixture.s057,
    "verified_live_app_server_readback_receipt_compared",
  );
});
