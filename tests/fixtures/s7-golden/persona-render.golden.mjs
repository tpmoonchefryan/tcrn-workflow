// SPDX-License-Identifier: Apache-2.0
// S7 golden — persona-render (TCRN-CROSS-STORY-141; re-homed under TCRN-CROSS-INC-034).
//
// The engine emits CANONICAL single-line JSON, and this snapshot locks those exact
// bytes. It cannot be stored as a .json file here: this repository formats every
// .json in its walked tree to pretty-printed form, which would rewrite the very
// bytes under test and turn a behaviour lock into a formatter artefact. Held as a
// string module instead — the formatter does not rewrite string contents, so the
// golden and the format gate can both be right.
//
// Regenerate ONLY when the behaviour change is intended; see the S7 evidence pack.

export const PERSONA_RENDER_GOLDEN = "{\"bundleDigest\":\"dea33c610178a5bb44db61b62e3e1051ba9ff46a9367fe657d4a76ab0dfc8ffa\",\"byteLength\":501,\"profileDigest\":\"d6973d1ad4df618453a4a2d4b384e8661586c7927da683a6daf934cae7492c31\",\"profileId\":\"profile:tcrn-mneme-v1\",\"renderDigest\":\"843ab5145caf5e602ce639115bec0e2e4b207a1fcbc90419da853149cbeeccdb\",\"schemaVersion\":\"tcrn.conference-persona-reference.v1\",\"scope\":\"conference_position_reference\",\"text\":\"Conference role reference: Mneme (Knowledge Steward).\\nMandate boundary: Owns knowledge-policy and promotion verdicts; cannot implement product code, admit private history, or replace proof and security gates.\\nRefuses: no owner-private or transcript admission; no unproven promotion; no product implementation.\\nUse only to attribute a conference position argued from this role's mandate.\\nThis reference does not bind the main thread, make it read-only, or grant Workflow mutation or approval authority.\"}";
