---
title: Fast mode off status alarm
date: 2026-08-18
status: complete
owners: [aelaguiz]
reviewers: []
fallback_policy: Revert the presentation-only tray and theme changes.
related:
  - packages/coding-agent/src/modes/interactive/interactive-mode.ts
  - packages/coding-agent/src/modes/interactive/components/subagent-summary-line.ts
  - packages/coding-agent/src/modes/interactive/theme/theme.ts
  - packages/coding-agent/test/interactive-mode-effort-command.test.ts
  - packages/coding-agent/test/interactive-mode-startup.test.ts
  - packages/coding-agent/test/subagent-summary-line.test.ts
---

# TL;DR

For every fast-capable GPT-5.6 Sol model, make disabled Fast mode continuously visible as bold bright-red `FAST OFF` at the front of the interactive status line. Preserve the existing lowercase `fast` suffix when enabled and leave unsupported models unchanged.

Execution log: [FAST_MODE_OFF_STATUS_PLAN_WORKLOG.md](./FAST_MODE_OFF_STATUS_PLAN_WORKLOG.md)

## North Star

**Claim:** A user can determine that Fast mode is disabled without inferring it from a missing label.

- **In scope:** Interactive tray text, semantic theme color, focused regression coverage, and the coding-agent changelog.
- **Out of scope:** Daemon protocol changes, new settings, notifications, blinking UI, or automatic Fast-mode changes.
- **Definition of done:** The disabled state is first, bold, and bright red; enabled and unsupported behavior remain correct; focused tests and `npm run check` pass.

<!-- lilarch:block:requirements -->
## Requirements

1. For a model accepted by `supportsFastMode()`, `serviceTier !== "priority"` renders `FAST OFF` before all ordinary tray information.
2. `FAST OFF` uses a dedicated semantic theme color plus bold styling and remains complete under ordinary narrow-terminal truncation.
3. `serviceTier === "priority"` preserves the existing `model • effort • fast` presentation.
4. Models not accepted by `supportsFastMode()` do not show either Fast-state label.
5. Existing connection-state invalidation remains the only refresh mechanism.

**Defaults:** Off means every non-priority tier; color is high-contrast red in each built-in theme.

**Non-requirements:** No provider/model-ID duplicate logic, new state owner, animation, toast, preference, or wire change.

## Scope and Simplicity Contract

- **Human-authorized outcome:** The user asked for an unmistakable bright-red `FAST OFF` status for GPT-5.6 Sol, then authorized implementation and testing.
- **Smallest sufficient solution:** Derive presentation from the existing model capability and `connectionState.serviceTier`, add one semantic color, and test the label contract.
- **Initial minimal convergence closure:** None. `supportsFastMode()` and `connectionState.serviceTier` are already the single capability/state owners.
- **Scope-freeze boundary:** The tray label builder, its existing summary-line renderer, built-in theme definitions/schema, focused tests, changelog, and these plan artifacts only.
- **Enough proof:** Off/on/unsupported label assertions, ANSI style assertion, narrow render assertion, focused test run, and `npm run check`.
- **Do-not-build boundary:** No daemon, persistence, command, model-registry, event, or generalized alert-system work.
- **Accepted residual risk:** User-supplied custom themes inherit schema validation and must define the new required semantic color.

<!-- arch_skill:block:research_grounding -->
## Research Grounding

- `InteractiveMode.getTrayLocationLabel()` assembles the persistent location/status line.
- `InteractiveMode.getModelTrayLabel()` already owns model, effort, and enabled `fast` text.
- `supportsFastMode(model)` is the capability source of truth; `connectionState.serviceTier === "priority"` is the enabled-state source of truth.
- `patchConnectionState()` already invalidates the summary line on relevant state changes.
- `SubagentSummaryLine` currently protects the right-aligned context label first at narrow widths, so an optional priority prefix must reserve the left edge for the alarm.

<!-- arch_skill:block:current_architecture -->
## Current Architecture

The tray omits Fast information when a capable model is not on the priority tier. Absence therefore carries state, which is easy to miss. The whole assembled line is rendered under a muted outer style.

<!-- arch_skill:block:target_architecture -->
## Target Architecture

Keep state ownership unchanged. Build the ordinary model label as today; when Fast is capable but off, supply a theme-styled `FAST OFF` priority prefix to the existing summary-line renderer. The renderer reserves that prefix before allocating space to location and context labels. Add `fastModeOff` as a required foreground token in theme types, schema, and all built-in themes.

<!-- arch_skill:block:call_site_audit -->
## Call-site Audit

- Change: Fast-state projection in `interactive-mode.ts` and priority-prefix layout in `components/subagent-summary-line.ts`.
- Theme contract: `theme.ts`, `theme-schema.json`, `dark.json`, `light.json`, and `prime.json`.
- Proof: `interactive-mode-effort-command.test.ts` for enabled state, `interactive-mode-startup.test.ts` for off/style integration, and `subagent-summary-line.test.ts` for priority-prefix truncation.
- No daemon command, event, response shape, or capability negotiation is involved; this is backward-compatible local presentation.

<!-- arch_skill:block:phase_plan -->
## Phase Plan

### Phase 1 — Implement the tray alarm

- Add the semantic theme token across the built-in theme contract.
- Render bold red `FAST OFF` through the summary line's reserved priority prefix when a capable model is not on the priority tier.
- Preserve enabled and unsupported model output.

### Phase 2 — Prove and document

- Add focused off/on/unsupported, style, ordering, and narrow-render assertions.
- Run all modified test files and `npm run check`.
- Add one user-visible `[Unreleased]` changelog bullet and record proof in the worklog.

<!-- lilarch:block:plan_audit -->
## Plan Audit

**Approved for implementation.** Every phase item maps directly to the user-authorized status-line outcome. The plan reuses existing state and capability owners, introduces no competing authority or new behavior surface, protects the alarm by reserving it before the existing truncation allocation, and includes proof for the failure modes that matter. Scope is frozen at the boundary above.

<!-- arch_skill:block:implementation_audit -->
## Implementation Audit

**Complete.** The code derives both states from `supportsFastMode()` and `connectionState.serviceTier`, renders disabled Fast mode through the summary line's reserved priority prefix, and preserves the existing enabled suffix. The semantic token is defined in the TypeBox contract, JSON schema, and all built-in themes. The dark/Prime red has 5.56:1 contrast against the Prime background; the light red has 6.48:1 against white.

Proof passed:

- 45/45 focused tests across Fast command/label behavior, startup projection/style, and summary-line truncation.
- `npm run check`, including Biome, TypeScript, installer rendering, and browser smoke checks.
- `git diff --check` on all implementation files.
- Installed integrated dist verification: `FAST OFF` and `__aim-handoff-credential` are both present; Prime/AIM handoff regressions passed 75/75 and AIM rotation tests passed 19/19.

All implemented work is authorized by the frozen user outcome. No daemon/wire changes, new state owner, automatic mode changes, or unauthorized adjacent behavior were introduced.
