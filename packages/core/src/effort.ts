// SPDX-License-Identifier: Apache-2.0

/**
 * The one cross-host effort roster.  Names are literal values from the vendor
 * documents; the host field is capability provenance, not a portal enum
 * invented by the engine.
 *
 * There are two documentation layers and this roster needs both.  The model API
 * pages state the effort parameter a request may carry — and say so explicitly:
 * the Claude page lists its platforms as the Claude API, Bedrock, Vertex and
 * Foundry, which does not include Claude Code.  The host product pages state
 * the levels a *session* can be set to, which is what this roster describes.
 * Anchoring only to the API layer is why `ultracode` and `ultra` were missing:
 * those pages cannot carry a host session level by construction.
 */
export const AGENT_EFFORT_HOSTS = Object.freeze(["claude-code", "codex"] as const);
export type AgentEffortHost = typeof AGENT_EFFORT_HOSTS[number];
export const AGENT_EFFORT_NAMES = Object.freeze(["high", "low", "max", "medium", "minimal", "none", "ultra", "ultracode", "xhigh"] as const);
export type AgentEffortName = typeof AGENT_EFFORT_NAMES[number];
export const AGENT_EFFORT_VERSION = "tcrn.agent-effort.v1" as const;

const ACCESSED_AT = "2026-08-14" as const;
const HOST_DOC_ACCESSED_AT = "2026-08-15" as const;
const CLAUDE_SOURCE = "https://platform.claude.com/docs/en/build-with-claude/effort" as const;
const CODEX_SOURCE = "https://developers.openai.com/api/docs/guides/reasoning" as const;
const CLAUDE_HOST_SOURCE = "https://code.claude.com/docs/en/model-config" as const;
const CODEX_HOST_SOURCE = "https://learn.chatgpt.com/docs/models" as const;

interface EffortEvidence {
  readonly sourceHost: AgentEffortHost;
  readonly quote: string;
  readonly url: string;
  /** Each source is cited on the day it was read; the two layers were read a day apart. */
  readonly accessedAt: typeof ACCESSED_AT | typeof HOST_DOC_ACCESSED_AT;
}

export interface AgentEffortRecord {
  readonly name: AgentEffortName;
  readonly applicableHosts: readonly AgentEffortHost[];
  readonly semantics: Readonly<Partial<Record<AgentEffortHost, string>>>;
  /**
   * Whether a model plan may name this level for one persona.  A plan's `efforts`
   * map is per-persona dispatch configuration read when the host sends work to a
   * subagent, so a level the vendor documents as a property of the *session* has
   * no meaning in that position: setting it would name a level the dispatch never
   * carries.  The roster still records such levels — they exist and the vocabulary
   * says what is true — and marks them unassignable so the dispatch face refuses
   * them.  This mirrors `reviewOnlyDispatchable` in the roles domain, where the
   * value is likewise listed but bounded in where it may be used.
   */
  readonly assignableToSubagent: boolean;
  readonly evidence: readonly EffortEvidence[];
}

const claudeEvidence = (quote: string): EffortEvidence => Object.freeze({ sourceHost: "claude-code", quote, url: CLAUDE_SOURCE, accessedAt: ACCESSED_AT });
const codexEvidence = (quote: string): EffortEvidence => Object.freeze({ sourceHost: "codex", quote, url: CODEX_SOURCE, accessedAt: ACCESSED_AT });
// Host session levels cite the host product documentation, not the model API page.
const claudeHostEvidence = (quote: string): EffortEvidence => Object.freeze({ sourceHost: "claude-code", quote, url: CLAUDE_HOST_SOURCE, accessedAt: HOST_DOC_ACCESSED_AT });
const codexHostEvidence = (quote: string): EffortEvidence => Object.freeze({ sourceHost: "codex", quote, url: CODEX_HOST_SOURCE, accessedAt: HOST_DOC_ACCESSED_AT });
const hosts = (...values: AgentEffortHost[]): readonly AgentEffortHost[] => Object.freeze(values);

const CODEX_VALUES_QUOTE = "Supported values are model-dependent and can include `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.";

export const AGENT_EFFORT_ROSTER: readonly AgentEffortRecord[] = Object.freeze([
  Object.freeze({
    name: "high",
    assignableToSubagent: true,
    applicableHosts: hosts("claude-code", "codex"),
    semantics: Object.freeze({
      "claude-code": "High capability; equivalent to omitting the effort parameter.",
      codex: "Hard reasoning, complex debugging, and high-value tasks.",
    }),
    evidence: Object.freeze([claudeEvidence("`high`  High capability. Equivalent to not setting the parameter."), codexEvidence(CODEX_VALUES_QUOTE)]),
  }),
  Object.freeze({
    name: "low",
    assignableToSubagent: true,
    applicableHosts: hosts("claude-code", "codex"),
    semantics: Object.freeze({
      "claude-code": "Most efficient; significant token savings with some capability reduction.",
      codex: "Efficient reasoning with a modest latency increase.",
    }),
    evidence: Object.freeze([claudeEvidence("`low`  Most efficient. Significant token savings with some capability reduction."), codexEvidence(CODEX_VALUES_QUOTE)]),
  }),
  Object.freeze({
    name: "max",
    assignableToSubagent: true,
    applicableHosts: hosts("claude-code", "codex"),
    semantics: Object.freeze({
      "claude-code": "Absolute maximum capability with no constraints on token spending.",
      codex: "Maximum reasoning for the most complex tasks.",
    }),
    evidence: Object.freeze([claudeEvidence("`max`  Absolute maximum capability with no constraints on token spending."), codexEvidence(CODEX_VALUES_QUOTE)]),
  }),
  Object.freeze({
    name: "medium",
    assignableToSubagent: true,
    applicableHosts: hosts("claude-code", "codex"),
    semantics: Object.freeze({
      "claude-code": "Balanced approach with moderate token savings.",
      codex: "Quality and reliability for planning and complex reasoning.",
    }),
    evidence: Object.freeze([claudeEvidence("`medium`  Balanced approach with moderate token savings."), codexEvidence(CODEX_VALUES_QUOTE)]),
  }),
  Object.freeze({
    name: "minimal",
    assignableToSubagent: true,
    applicableHosts: hosts("codex"),
    semantics: Object.freeze({ codex: "Codex-specific lower reasoning level when supported by the selected model." }),
    evidence: Object.freeze([codexEvidence(CODEX_VALUES_QUOTE)]),
  }),
  Object.freeze({
    name: "none",
    assignableToSubagent: true,
    applicableHosts: hosts("codex"),
    semantics: Object.freeze({ codex: "Latency-critical work that does not benefit from reasoning." }),
    evidence: Object.freeze([codexEvidence(CODEX_VALUES_QUOTE)]),
  }),
  Object.freeze({
    name: "xhigh",
    assignableToSubagent: true,
    applicableHosts: hosts("claude-code", "codex"),
    semantics: Object.freeze({
      "claude-code": "Extended capability for long-horizon work; availability is model-dependent.",
      codex: "Deep research, asynchronous workflows, and long-running agentic tasks.",
    }),
    evidence: Object.freeze([claudeEvidence("`xhigh`  Extended capability for long-horizon work."), codexEvidence(CODEX_VALUES_QUOTE)]),
  }),
  // The two host session levels. Both are documented as session-scoped rather than
  // persisted, and Owner ruled (MIN-093 R2) that a plan — per-persona dispatch
  // configuration — may not name one: they are `assignableToSubagent: false`, listed
  // by the vocabulary and refused by the dispatch face.
  Object.freeze({
    name: "ultra",
    assignableToSubagent: false,
    applicableHosts: hosts("codex"),
    semantics: Object.freeze({
      codex: "Maximum reasoning with automatic task delegation; a Codex session level rather than an API effort value.",
    }),
    evidence: Object.freeze([codexHostEvidence("Ultra (current): Maximum reasoning with automatic task delegation")]),
  }),
  Object.freeze({
    name: "ultracode",
    assignableToSubagent: false,
    applicableHosts: hosts("claude-code"),
    semantics: Object.freeze({
      "claude-code": "Plans a dynamic workflow for each substantive task and reasons at xhigh per message; session-only, not persisted.",
    }),
    evidence: Object.freeze([claudeHostEvidence("A Claude Code setting that plans a dynamic workflow for each substantive task with `xhigh` per-message reasoning. Session-only.")]),
  }),
]);

function fail(value: unknown): never {
  throw new Error(`${String(value)} is not a registered agent effort`);
}

export function effortForHost(value: unknown, host: AgentEffortHost): AgentEffortName {
  const record = AGENT_EFFORT_ROSTER.find((candidate) => candidate.name === value);
  if (record === undefined || !record.applicableHosts.includes(host)) {
    const legal = AGENT_EFFORT_ROSTER.filter((candidate) => candidate.applicableHosts.includes(host)).map((candidate) => candidate.name).join(", ");
    fail(`${String(value)} is not valid for ${host}; legal values: ${legal}`);
  }
  return record.name;
}
