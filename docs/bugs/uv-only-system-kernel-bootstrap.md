---
title: "Global uv only-system preference breaks Python kernel bootstrap"
date: 2026-08-20
status: resolved
owners: [coding-agent, aimgr]
reviewers: []
related: []
---

<!-- bugs:block:tldr -->
## TL;DR

- **Symptom:** A normal `aim prime run codex` session repeatedly fails kernel setup at `uv venv ~/.prime/agent/kernel-venv --python 3.11 --seed` even though the current source contains the `--managed-python` repair.
- **Impact:** AIM-launched Prime sessions on this machine cannot execute any Python kernel tool action.
- **Most likely cause:** AIM deliberately adds `--dist`; the installed bundle predates the source repair and upstream integration, so it launches schema 21 code without `--managed-python` and replaces the current schema 23 source daemon.
- **Next action:** None. The sole installed launcher, AIMGR launch paths, refreshed bundle, daemon, default kernel environment, and both managed provider paths are verified.
- **Status:** Resolved on 2026-08-23.
<!-- /bugs:block:tldr -->

<!-- bugs:block:analysis -->
## Bug North Star

Prime Agent's self-managed Python kernel bootstrap must use the Python it explicitly installs, regardless of a user's unrelated global uv interpreter preference.

## Bug Summary

Before the source fix, `bootstrapVenv()` ran `uv python install 3.11`, which installs a uv-managed interpreter, and then ran `uv venv <path> --python 3.11 --seed`. A global `python-preference = "only-system"` applied to the second command, causing uv to see but reject the managed Python 3.11 candidate. The source fix was present on `origin/main`, but the machine's ignored distribution bundle had not been rebuilt and was still the artifact selected by AIM.

## Evidence

- `/Users/aelaguiz/.config/uv/uv.toml` resolves to the user's dotfiles and sets `python-preference = "only-system"` plus `python-downloads = "manual"`.
- The installed arm64 interpreter at `~/.local/share/uv/python/cpython-3.11.14-macos-aarch64-none/bin/python3.11` executes successfully and reports Python 3.11.14.
- Default `uv python find 3.11` fails. Verbose output reports the managed candidate and then says it is ignored because only system interpreters are allowed.
- `UV_MANAGED_PYTHON=1 uv python find 3.11`, `UV_PYTHON_PREFERENCE=managed uv python find 3.11`, and `uv --no-config python find 3.11` all resolve the same installed interpreter.
- `uv venv <probe> --python 3.11 --seed --managed-python` succeeds under the unchanged global configuration and creates a Python 3.11.14 venv.
- Before the fix, `packages/coding-agent/src/core/kernel/bootstrap.ts` did not pass `--managed-python` to `uv venv`.
- Current source at `b6c37e628429a5eb7c8c8df133218a2be8bfc129` passes `--managed-python`, and the focused regression requires it.
- Before the rebuild, `packages/coding-agent/dist/bundle/` contained no `--managed-python` string; its entrypoint was dated 2026-08-20, before the source repair commit `307fd13c` from 2026-08-21.
- The exact uncorrected command still exits 2 with `No interpreter found for Python 3.11 in search path` under the unchanged global uv configuration.
- At 2026-08-23 12:50 local time, `aimgr.js prime run codex` launched Prime with its explicit `--dist` argument. The resulting default daemon reported schema `protocol-7-schema-21-a3a50d3924f1` and bundle build `5cedf88b...`, replacing the verified schema 23 source daemon.
- The rebuilt bundle is `bundle-v1:69398d1308a290566577af368074f3ad4e86be34e58d83cf12732a57f2853d78`, contains the exact managed-interpreter call, and runs protocol 7/schema `protocol-7-schema-23-633d151dce99` as the only default daemon.

## Investigation

The interpreter is neither missing nor stale, so reinstalling it cannot resolve the failure. `python-downloads = "manual"` is not the remaining blocker because Prime Agent explicitly runs `uv python install 3.11`. Source and test already own the correct interpreter-selection behavior. The live failure is an installation-artifact mismatch: direct Prime was temporarily source-linked, while AIM independently forced the dist lane. Amir explicitly requested both the local rebuild and an AIMGR fix, so the installed launcher becomes the single lane authority and AIM must forward only product arguments.

## Scope and Simplicity Contract

- **Human-authorized corrected behavior:** Prime Agent's automatic kernel setup completes on this machine through the same installed client used by direct zsh and AIM-managed Codex/Claude launches, despite the user's global system-only uv preference.
- **Smallest sufficient fix:** Keep the existing source repair; remove AIMGR's hardcoded `--dist` from Prime run, resume, handoff, routine pin, and routine TUI launches; rebuild the local distribution from current `origin/main`; and make the sole PATH launcher select that refreshed dist by default.
- **Initial minimal convergence closure:** AIMGR's ordinary run/resume/handoff owner and scheduled-routine owner are the only active paths that independently select the Prime lane, so both must delegate to the installed launcher. The one ignored local bundle and one `~/.local/bin/prime-agent` wrapper move together. No other AIM/provider/session behavior changes.
- **Scope freeze:** Re-frozen before implementation after Amir explicitly approved the build override and AIMGR repair on 2026-08-23.
- **Enough proof:** Focused AIM launcher tests prove no AIM path injects `--dist`; the focused kernel bootstrap test passes; the rebuilt bundle contains the managed-interpreter fix; direct and AIM launches report the same schema/build; the real default venv becomes ready; installed-client Codex and Claude sessions each successfully execute `Path.cwd()`; Prime's required check and AIMGR's lint/owned suites pass; and any unrelated broad-suite baseline is explicitly reported.
- **Do not build:** No global uv configuration change, no fallback interpreter search, no dependency changes, no kernel bootstrap refactor, no provider/account behavior change, and no daemon protocol change.
- **Accepted residual risk:** A uv version too old to support `--managed-python` would fail loudly; Prime Agent's existing uv installation/update policy remains responsible for providing a supported uv CLI.
<!-- /bugs:block:analysis -->

<!-- bugs:block:fix_plan -->
## Fix Plan

1. Preserve the already-landed `--managed-python` source/test repair.
2. Remove AIMGR's independent `--dist` selection from every Prime launch owner and update focused assertions so the installed launcher is authoritative.
3. Rebuild the local distribution from exact current `origin/main` under the explicit no-local-build override.
4. Restore the sole PATH wrapper to the refreshed dist lane and cut over the one failed default daemon.
5. Run focused tests, both repository checks, direct venv readiness checks, and real installed-client Codex and Claude `Path.cwd()` kernel actions.
<!-- /bugs:block:fix_plan -->

<!-- bugs:block:implementation -->
## Implementation and Verification

### Earlier source repair

- Added `--managed-python` to the `uv venv` invocation in `bootstrapVenv()`, binding venv creation to the interpreter installed by the preceding `uv python install 3.11` command.
- Updated the missing-venv bootstrap regression to require the managed-Python flag in the emitted uv arguments.
- Added the user-visible fix to `packages/coding-agent/CHANGELOG.md` under `[Unreleased]`.
- Bootstrapped `~/.prime/agent/kernel-venv` successfully without changing the user's global uv configuration.

### Verified

- `npx tsx ../../node_modules/vitest/dist/cli.js --run test/kernel-bootstrap.test.ts` passed all 21 tests.
- `npm run check` passed Biome, TypeScript, installer rendering, and browser smoke checks with no fixes applied.
- The real bootstrap completed under `python-preference = "only-system"` and returned `~/.prime/agent/kernel-venv/bin/python`.
- The kernel Python reports 3.11.14 and contains ipykernel, the `prime-agent-runtime` package, snapshot support, and every default Python package required by the runtime.
- A second real bootstrap reused the ready environment immediately.
- The installed `prime-agent` launcher reports v0.7.4 and reached the interactive TUI in an isolated tmux session; the test session was then removed.

### Current installation regression

- Reproduced the exact exit-2 uv failure from the user report.
- Proved current source and regression coverage contain `--managed-python` while the selected dist artifact does not.
- Traced the stale daemon's parent chain to `aimgr.js prime run codex`, whose established contract invokes the installed launcher with `--dist`.
- Amir explicitly approved rebuilding the local artifact, fixing AIMGR's lane selection, and testing both managed provider paths. Implementation is now authorized under the re-frozen closure above.

### Installation and AIMGR repair

- Removed AIMGR's hardcoded `--dist` argument from ordinary Prime run, resume, credential handoff, scheduled-routine pin, and scheduled-routine TUI launches. The installed launcher is now the only source/dist authority.
- Rebuilt Prime Agent 0.8.0 from exact current `origin/main` under the explicit local-build override. The generated distribution contains `--managed-python`; no tracked generated-model change resulted.
- Restored the sole PATH-resolved Prime wrapper to the refreshed dist lane and reinstalled AIMGR's local `aim`/`aimgr` wrappers plus its Claude file-storage adapter from `/Users/aelaguiz/workspace/aimgr`.
- Stopped the one failed schema-21 daemon and started the refreshed schema-23 daemon. Final runtime identity is bundle `69398d13...`, with zero resident sessions after the bounded canaries.
- The default kernel venv now exists at `~/.prime/agent/kernel-venv`, uses Python 3.11.14, and contains IPython 9.16.1, ipykernel 7.3.0, dill 0.4.1, and `prime-agent-runtime` 0.1.0.

### Final verification

- AIMGR focused Prime target/routine suite: 30 passed. Real launcher-probe runs for both `aim prime run codex` and `aim prime run claude` forwarded only provider/model arguments and no `--dist`.
- AIMGR lint passed. The broad suite reported 389 passes, zero assertion failures, and five cancellations isolated to the pre-existing `test/coordination/redis-store.test.js`; that untouched file reproduces all five cancellations alone and is outside this signed-off launcher/kernel closure.
- Prime kernel bootstrap suite: 21 passed. Prime repository check passed Biome, TypeScript, installer rendering, and browser smoke with no fixes applied.
- AIM-managed Codex emitted a structured `ipython` tool call for `Path.cwd()`, returned `/Users/aelaguiz/workspace/aimgr` with `status: ok`, `isError: false`, and `kernelRestarted: false`, then returned `KERNEL_CODEX_STRUCTURED_OK`.
- AIM-managed Claude emitted the same structured tool call and successful result, then returned `KERNEL_CLAUDE_STRUCTURED_OK`. After a real AIM Claude selection changed the binding to `pro12`, that selected descriptor repeated the successful call and returned `KERNEL_CLAUDE_AIM_SELECTED_OK`.
<!-- /bugs:block:implementation -->
