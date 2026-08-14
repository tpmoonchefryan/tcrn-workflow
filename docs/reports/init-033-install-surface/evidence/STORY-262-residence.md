已脱敏，非逐字，原件见平台档案 `init-033-install-surface/S262-residence-probe.stdout.json`。

# STORY-262 宿主居所矩阵

## Probe boundary

- Probe: `scripts/init033-residence-probe.mjs`。
- The probe created a disposable container root and a disposable child Git
  fixture, placed temporary host files there, ran only read-only host probes,
  and removed the fixture before returning. No real project configuration was
  changed.
- Host versions observed: Claude Code `2.1.220`; Codex CLI `0.145.0`。
- Claude deny and hook behavior were not claimed as fired: the equivalent
  doctor/config-entry probe accepted the host surface, but no network model
  session was opened. Claude project MCP visibility was observed directly.

## Residence matrix

| Wiring | Claude Code | Codex | Residence conclusion |
| --- | --- | --- | --- |
| `settings.json` deny | container-root surface accepted by `doctor`; firing 未观测 | no Codex equivalent | container root, host-specific |
| hooks | container-root surface accepted by `doctor`; firing 未观测 | no Codex equivalent in this probe | container root, host-specific |
| `.mcp.json` | child project reports the fixture server as `Project config` and `Pending approval` | `codex mcp list` reports no servers | Claude project-config inheritance is effective; Codex has no matching `.mcp.json` project surface |
| Codex feature config | not applicable | `<HOME>/.codex/config.toml` changed `hooks` to `false`; container-root/project `.codex/config.toml` did not | machine/user Codex home, not container-root/project `.codex/config.toml` |
| `AGENTS.md` | not applicable | child fixture carried the inherited file; behavior unobserved without a model session | container/project prose inheritance, verified only as a fixture residence |

## Governed project set

The per-project materialization set is explicit and case-sensitive:

- `TCRN-AOS`
- `TCRN-Design-System`
- `TCRN-TMS`
- `tcrn-workflow`
- `joi-button` (lowercase directory spelling is required)

The resulting residence decisions are now represented by the engine-owned
`install-manifest` read surface; the doctor consumes that manifest rather than
maintaining a second path table.

## Cleanup

The raw probe readback records the disposable fixture root and the cleanup
completion marker. The real host configuration files were not used as probe
fixtures and remained byte-identical.
