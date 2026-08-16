// SPDX-License-Identifier: Apache-2.0

import { compareCanonicalText } from "../../protocol/src/index.js";

export const INSTALL_MANIFEST_VERSION = "tcrn.install-manifest.v1" as const;

export type InstallManifestLayer = "machine" | "container" | "project";
export type InstallManifestWriter = "engine-adapter" | "host-self" | "user-guided";
export type InstallManifestHost = "claude" | "codex" | "shared";

export interface InstallManifestItem {
  readonly id: string;
  readonly layer: InstallManifestLayer;
  readonly host: InstallManifestHost;
  readonly pathTemplate: string;
  readonly writer: InstallManifestWriter;
  readonly acceptanceProbe: string;
}

export interface InstallManifestProject {
  readonly name: string;
  readonly host: InstallManifestHost;
  readonly pathTemplate: string;
}

export interface InstallManifestReadback {
  readonly schemaVersion: typeof INSTALL_MANIFEST_VERSION;
  readonly placeholders: readonly ("<HOME>" | "<PLATFORM_ROOT>")[];
  readonly projects: readonly InstallManifestProject[];
  readonly items: readonly InstallManifestItem[];
}

export const INSTALL_MANIFEST_REASON_CODES = Object.freeze([
  "INSTALL_MANIFEST_INVALID",
  "INSTALL_MANIFEST_ITEM_MISSING",
] as const);
export type InstallManifestReasonCode = typeof INSTALL_MANIFEST_REASON_CODES[number];

export class InstallManifestError extends Error {
  readonly reasonCode: InstallManifestReasonCode;

  constructor(reasonCode: InstallManifestReasonCode, message: string) {
    super(message);
    this.name = "InstallManifestError";
    this.reasonCode = reasonCode;
  }
}

function item(
  id: string,
  layer: InstallManifestLayer,
  host: InstallManifestHost,
  pathTemplate: string,
  writer: InstallManifestWriter,
  acceptanceProbe: string,
): InstallManifestItem {
  return Object.freeze({ id, layer, host, pathTemplate, writer, acceptanceProbe });
}

const projects: readonly InstallManifestProject[] = Object.freeze([
  Object.freeze({ name: "TCRN-AOS", host: "shared", pathTemplate: "<PLATFORM_ROOT>/TCRN Platform/TCRN-AOS" }),
  Object.freeze({ name: "TCRN-Design-System", host: "shared", pathTemplate: "<PLATFORM_ROOT>/TCRN Platform/TCRN-Design-System" }),
  Object.freeze({ name: "TCRN-TMS", host: "shared", pathTemplate: "<PLATFORM_ROOT>/TCRN Platform/TCRN-TMS" }),
  Object.freeze({ name: "tcrn-workflow", host: "shared", pathTemplate: "<PLATFORM_ROOT>/TCRN Platform/tcrn-workflow" }),
  // Case is contractual: this is the external project directory, not a prose
  // rendering of the partition label "Joi-Button".
  Object.freeze({ name: "joi-button", host: "shared", pathTemplate: "<PLATFORM_ROOT>/joi-button" }),
]);

// INC-207: the harness is built at the chosen workspace root and nowhere else.
// Materialising it into every project put a live `.claude` and `.codex` inside
// directories whose repositories are deliberately clean of them, and made "which
// hooks am I running" a function of which folder happened to be opened. The Owner
// ruled on 2026-08-16 that harness files belong to the workspace root; the container
// and machine layers below carry the whole surface now.
//
// One project entry survives, and it is not a materialisation: the engine
// repository commits its own `.claude/settings.json` as a sanitised CI fixture —
// git-tracked, covered by that repository's source allowlist, and read by two of its
// tests. It stays declared here so the harness-surface leg can tell an accounted-for
// directory from a stray, with its provenance stated rather than implied.
const projectItems = [
  item("project.tcrn-workflow.claude-settings", "project", "claude", "<PLATFORM_ROOT>/TCRN Platform/tcrn-workflow/.claude/settings.json", "host-self", "probe:regular-file"),
];

export const INSTALL_MANIFEST_ITEMS: readonly InstallManifestItem[] = Object.freeze([
  item("container.claude-settings", "container", "claude", "<PLATFORM_ROOT>/.claude/settings.json", "engine-adapter", "probe:regular-file"),
  item("container.mcp", "container", "claude", "<PLATFORM_ROOT>/.mcp.json", "engine-adapter", "probe:regular-file"),
  item("container.platform-agents", "container", "shared", "<PLATFORM_ROOT>/AGENTS.md", "engine-adapter", "probe:regular-file"),
  item("container.platform-claude-bridge", "container", "claude", "<PLATFORM_ROOT>/CLAUDE.md", "engine-adapter", "probe:regular-file"),
  item("container.claude-adapter", "container", "claude", "<PLATFORM_ROOT>/.claude/tcrn-workflow", "engine-adapter",
    "probe:adapter-bundle-digest;receipt=<PLATFORM_ROOT>/.tcrn-artifacts/install-receipts/platform-container/claude.json"),
  item("container.codex-adapter", "container", "codex", "<PLATFORM_ROOT>/.codex/tcrn-workflow", "engine-adapter",
    "probe:adapter-bundle-digest;receipt=<PLATFORM_ROOT>/.tcrn-artifacts/install-receipts/platform-container/codex.json"),
  // STORY-286: the two adapter entries used to accept a directory merely existing, which
  // is the ceiling INC-208 recorded — a bundle whose bytes had been edited passed. They
  // now verify against the digests their own install receipt recorded, so an accepted
  // bundle is one that still is what was installed.
  item("container.platform-container.claude-receipt", "container", "claude", "<PLATFORM_ROOT>/.tcrn-artifacts/install-receipts/platform-container/claude.json", "engine-adapter", "probe:receipt-json"),
  item("container.platform-container.codex-receipt", "container", "codex", "<PLATFORM_ROOT>/.tcrn-artifacts/install-receipts/platform-container/codex.json", "engine-adapter", "probe:receipt-json"),
  // INC-208: the chain-write refusal lives at the machine layer because project
  // settings do not inherit from a parent directory. INC-207 moved the harness to the
  // container root, and the three project settings files it retired were the only
  // thing refusing a write to the chain from a session opened at a project root —
  // container rules never covered those sessions. Declared here it holds wherever a
  // session is opened, which is a stronger guarantee than the per-project copies were.
  item("machine.claude-settings", "machine", "claude", "<HOME>/.claude/settings.json", "user-guided", "probe:regular-file"),
  item("machine.codex-config", "machine", "codex", "<HOME>/.codex/config.toml", "user-guided", "probe:regular-file"),
  item("machine.claude-skill", "machine", "claude", "<HOME>/.claude/skills/tcrn-workflow-helper", "user-guided", "probe:helper-skill-digest;source=trusted-archive-state;archive=skill-archive.json;state=state.json;entry=SKILL.md"),
  item("machine.codex-skill", "machine", "codex", "<HOME>/.codex/skills/tcrn-workflow-helper", "user-guided", "probe:helper-skill-digest;source=trusted-archive-state;archive=skill-archive.json;state=state.json;entry=SKILL.md"),
  item("machine.agents-skill", "machine", "shared", "<HOME>/.agents/skills/tcrn-workflow-helper", "user-guided", "probe:helper-skill-digest;source=trusted-archive-state;archive=skill-archive.json;state=state.json;entry=SKILL.md"),
  item("machine.workflow-engine", "machine", "shared", "<HOME>/.tcrn-workflow", "user-guided", "probe:engine-version"),
  item("machine.trust-archive", "machine", "shared", "<HOME>/.tcrn-workflow/skill-archive.json", "user-guided", "probe:trust-archive-freshness"),
  item("machine.local-snapshot-artifacts", "machine", "shared", "<PLATFORM_ROOT>/.tcrn-artifacts/chain-snapshots", "user-guided", "probe:regular-directory"),
  item("machine.local-snapshot-receipt", "machine", "shared", "<PLATFORM_ROOT>/.tcrn-artifacts/chain-snapshots/local-snapshot.json", "user-guided", "probe:local-snapshot-freshness;maxAgeHours=26"),
  item("machine.offsite-push-receipt", "machine", "shared", "<PLATFORM_ROOT>/.tcrn-artifacts/chain-snapshots/offsite-push.json", "user-guided", "probe:offsite-push-freshness;maxAgeHours=26"),
  item("machine.launchd-local-snapshot", "machine", "shared", "<HOME>/Library/LaunchAgents/com.tcrn.platform.local-snapshot.plist", "user-guided", "probe:launchd-duty;label=com.tcrn.platform.local-snapshot;maxAgeHours=26"),
  item("machine.portal-launcher-command", "machine", "shared", "<PLATFORM_ROOT>/tcrn-workflow-portal.command", "user-guided", "probe:regular-executable"),
  item("machine.portal-launcher-sh", "machine", "shared", "<PLATFORM_ROOT>/tcrn-workflow-portal.sh", "user-guided", "probe:regular-executable"),
  item("machine.portal-launcher-cmd", "machine", "shared", "<PLATFORM_ROOT>/tcrn-workflow-portal.cmd", "user-guided", "probe:regular-file"),
  ...projectItems,
].sort((left, right) => compareCanonicalText(left.id, right.id)));

export const INSTALL_MANIFEST_PROJECTS = projects;
// This catalog is intentionally independent from INSTALL_MANIFEST_ITEMS.  A
// completeness test must fail when a required entry is deleted from the
// materialized item list; deriving this array from that list would make the
// predicate tautological.
const REQUIRED_ITEM_ID_CATALOG = [
  "container.claude-adapter",
  "container.claude-settings",
  "container.codex-adapter",
  "container.mcp",
  "container.platform-agents",
  "container.platform-claude-bridge",
  "container.platform-container.claude-receipt",
  "container.platform-container.codex-receipt",
  "machine.claude-settings",
  "machine.claude-skill",
  "machine.codex-config",
  "machine.codex-skill",
  "machine.agents-skill",
  "machine.launchd-local-snapshot",
  "machine.local-snapshot-artifacts",
  "machine.local-snapshot-receipt",
  "machine.offsite-push-receipt",
  "machine.portal-launcher-cmd",
  "machine.portal-launcher-command",
  "machine.portal-launcher-sh",
  "machine.trust-archive",
  "machine.workflow-engine",
  // INC-207: only the engine repository's own committed fixture remains at project
  // layer. This catalog stays written out by hand rather than derived from the item
  // list, so deleting the entry above still fails the completeness test.
  "project.tcrn-workflow.claude-settings",
].sort(compareCanonicalText);
export const INSTALL_MANIFEST_REQUIRED_ITEM_IDS = Object.freeze(REQUIRED_ITEM_ID_CATALOG);

export const INSTALL_MANIFEST: InstallManifestReadback = Object.freeze({
  schemaVersion: INSTALL_MANIFEST_VERSION,
  placeholders: Object.freeze(["<HOME>" as const, "<PLATFORM_ROOT>" as const]),
  projects,
  items: INSTALL_MANIFEST_ITEMS,
});

function invalid(message: string): never {
  throw new InstallManifestError("INSTALL_MANIFEST_INVALID", message);
}

export function assertInstallManifestComplete(value: unknown): asserts value is InstallManifestReadback {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid("manifest must be an object");
  const manifest = value as Partial<InstallManifestReadback>;
  if (manifest.schemaVersion !== INSTALL_MANIFEST_VERSION) invalid("manifest schema version");
  if (!Array.isArray(manifest.placeholders) || manifest.placeholders.join("\u0000") !== "<HOME>\u0000<PLATFORM_ROOT>") invalid("manifest placeholders");
  if (!Array.isArray(manifest.projects) || manifest.projects.length !== projects.length) invalid("manifest projects are incomplete");
  if (!Array.isArray(manifest.items)) invalid("manifest items are missing");
  const ids = new Set<string>();
  for (const entry of manifest.items) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) invalid("manifest item is not an object");
    const candidate = entry as InstallManifestItem;
    if (typeof candidate.id !== "string" || ids.has(candidate.id)) invalid(`manifest item id is missing or duplicated: ${String(candidate.id)}`);
    ids.add(candidate.id);
    if (!["machine", "container", "project"].includes(candidate.layer)) invalid(`${candidate.id}: layer`);
    if (!["claude", "codex", "shared"].includes(candidate.host)) invalid(`${candidate.id}: host`);
    if (typeof candidate.pathTemplate !== "string" || !candidate.pathTemplate.includes("<PLATFORM_ROOT>") && !candidate.pathTemplate.includes("<HOME>")) invalid(`${candidate.id}: pathTemplate must use a placeholder`);
    if (!["engine-adapter", "host-self", "user-guided"].includes(candidate.writer)) invalid(`${candidate.id}: writer`);
    if (typeof candidate.acceptanceProbe !== "string" || candidate.acceptanceProbe.length === 0) invalid(`${candidate.id}: acceptanceProbe`);
  }
  for (const requiredId of INSTALL_MANIFEST_REQUIRED_ITEM_IDS) {
    if (!ids.has(requiredId)) throw new InstallManifestError("INSTALL_MANIFEST_ITEM_MISSING", requiredId);
  }
}

export function readInstallManifest(): InstallManifestReadback {
  assertInstallManifestComplete(INSTALL_MANIFEST);
  return INSTALL_MANIFEST;
}
